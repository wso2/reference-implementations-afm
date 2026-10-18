// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import MarkdownIt from "markdown-it";
import { Fragment, Schema, Slice } from "prosemirror-model";
import type { Mark, Node as DocumentNode } from "prosemirror-model";
import {
  schema as markdownSchema,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  MarkdownParser,
  MarkdownSerializer,
} from "prosemirror-markdown";
import type { MarkdownSerializerState } from "prosemirror-markdown";
import { AllSelection, EditorState, TextSelection } from "prosemirror-state";
import type { Command as EditorCommand, Transaction } from "prosemirror-state";
import { baseKeymap, chainCommands, lift, newlineInCode, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import { inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { gapCursor } from "prosemirror-gapcursor";
import {
  addColumnAfter,
  addRowAfter,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  isInTable,
  tableEditing,
  tableNodes,
} from "prosemirror-tables";

export function safeHref(value: string): string | null {
  const href = value.trim();
  if (!href || /[\u0000- \u007f]/.test(href)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  return scheme === undefined || ["http", "https", "mailto"].includes(scheme) ? href : null;
}

const ALIGNMENTS = ["left", "right", "center"];

function alignmentOf(style: string | null): string | null {
  const found = /text-align:\s*(\w+)/.exec(style ?? "")?.[1];
  return found !== undefined && ALIGNMENTS.includes(found) ? found : null;
}

const linkSpec = markdownSchema.spec.marks.get("link")!;
const tables = tableNodes({
  tableGroup: "block",
  cellContent: "(text | image)*",
  cellAttributes: {
    align: {
      default: null,
      getFromDOM: (cell) => alignmentOf(`text-align: ${cell.style.textAlign}`),
      setDOMAttr: (align, attrs) => {
        if (ALIGNMENTS.includes(align as string)) attrs.style = `text-align: ${align}`;
      },
    },
  },
});

export const editorSchema = new Schema({
  nodes: markdownSchema.spec.nodes
    .update("list_item", { ...markdownSchema.spec.nodes.get("list_item")!, content: "paragraph block*" })
    .update("image", {
      ...markdownSchema.spec.nodes.get("image")!,
      toDOM: (node) => [
        "span",
        { "data-markdown-image": "true", title: node.attrs.src },
        `![${node.attrs.alt ?? ""}](${node.attrs.src})`,
      ],
      parseDOM: [],
    })
    .append(tables),
  marks: markdownSchema.spec.marks
    .update("link", {
      ...linkSpec,
      parseDOM: [
        {
          tag: "a[href]",
          getAttrs: (element) => {
            const href = safeHref(element.getAttribute("href") ?? "");
            return href === null ? false : { href, title: element.getAttribute("title") };
          },
        },
      ],
      toDOM: (mark) => {
        const href = safeHref(mark.attrs.href);
        return href === null ? ["span", 0] : ["a", { href, title: mark.attrs.title, rel: "noopener noreferrer" }, 0];
      },
    })
    .addBefore("code", "strike", {
      parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }, { style: "text-decoration=line-through" }],
      toDOM: () => ["s", 0],
    }),
});

const tokenizer = new MarkdownIt("commonmark", { html: false })
  .enable(["strikethrough", "table"])
  .disable(["entity", "reference"]);

const parser = new MarkdownParser(editorSchema, tokenizer, {
  ...defaultMarkdownParser.tokens,
  s: { mark: "strike" },
  softbreak: { node: "hard_break" },
  table: { block: "table" },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: "table_row" },
  th: { block: "table_header", getAttrs: (token) => ({ align: alignmentOf(token.attrGet("style")) }) },
  td: { block: "table_cell", getAttrs: (token) => ({ align: alignmentOf(token.attrGet("style")) }) },
});

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const AUTOLINK = /^<(?:[a-z][a-z0-9+.-]{1,31}:[^\s<>]*|[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*)>/i;

const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);
const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

interface Place {
  lineStart: boolean;
  inCell: boolean;
  inLink: boolean;
  last: boolean;
}

function mustEscape(text: string, at: number, place: Place): boolean {
  const before = text[at - 1];
  const after = text[at + 1];
  switch (text[at]) {
    case "\\":
      return after === undefined ? !place.last : ASCII_PUNCTUATION.test(after);
    case "`":
      return true;
    case "*":
      return !(isSpace(before) && isSpace(after));
    case "_":
      return !(isWordChar(before) && isWordChar(after)) && !(isSpace(before) && isSpace(after));
    case "~":
      return before === "~" || after === "~";
    case "[":
      return place.inLink;
    case "]":
      return place.inLink || after === "(";
    case "<":
      return AUTOLINK.test(text.slice(at));
    case "|":
      return place.inCell;
    default:
      return false;
  }
}

function lineStartMarker(text: string): number {
  const indent = text.length - text.trimStart().length;
  const rest = text.slice(indent);
  if (/^(#{1,6}|[-+])(\s|$)/.test(rest) || rest.startsWith(">") || /^(-{2,}|=+)\s*$/.test(rest)) return indent;
  return /^\d{1,9}[.)](\s|$)/.test(rest) ? indent + /^\d+/.exec(rest)![0].length : -1;
}

function escapeMarkdown(text: string, place: Place): string {
  const escaped = new Set<number>();
  for (let at = 0; at < text.length; at++) if (mustEscape(text, at, place)) escaped.add(at);
  const marker = place.lineStart ? lineStartMarker(text) : -1;
  if (marker >= 0) escaped.add(marker);
  return Array.from(text, (char, at) => (escaped.has(at) ? `\\${char}` : char)).join("");
}

function isPlainUrl(link: Mark, parent: DocumentNode, index: number): boolean {
  if (link.attrs.title || !/^\w+:/.test(link.attrs.href)) return false;
  const content = parent.child(index);
  if (!content.isText || content.text !== link.attrs.href || content.marks[content.marks.length - 1] !== link)
    return false;
  return index === parent.childCount - 1 || !link.isInSet(parent.child(index + 1).marks);
}

const isCell = (node: DocumentNode) => node.type.name === "table_cell" || node.type.name === "table_header";

function backticksFor(node: DocumentNode, side: -1 | 1): string {
  let longest = 0;
  if (node.isText) for (const run of node.text!.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const opening = longest > 0 && side > 0 ? " `" : "`";
  return opening + "`".repeat(longest) + (longest > 0 && side < 0 ? " " : "");
}

function textOf(node: DocumentNode, parent: DocumentNode, index: number): string {
  const text = node.text ?? "";
  const inCell = isCell(parent);
  if (node.marks.some((mark) => mark.type.name === "code")) return inCell ? text.replaceAll("|", "\\|") : text;
  const link = node.marks.find((mark) => mark.type.name === "link");
  if (link !== undefined && isPlainUrl(link, parent, index)) return text;
  const lineStart =
    parent.type.name === "paragraph" &&
    node.marks.length === 0 &&
    (index === 0 || parent.child(index - 1).type.name === "hard_break");
  return escapeMarkdown(text, { lineStart, inCell, inLink: link !== undefined, last: index === parent.childCount - 1 });
}

function alignmentRule(align: string | null): string {
  if (align === "left") return ":---";
  if (align === "right") return "---:";
  return align === "center" ? ":---:" : "---";
}

function writeTable(state: MarkdownSerializerState, table: DocumentNode) {
  table.forEach((row, _, rowIndex) => {
    if (rowIndex > 0) state.write("\n");
    state.write("|");
    const rule: string[] = [];
    row.forEach((cell) => {
      state.write(" ");
      state.renderInline(cell, false);
      state.write(" |");
      for (let span = 0; span < cell.attrs.colspan; span++) rule.push(alignmentRule(cell.attrs.align));
      for (let span = 1; span < cell.attrs.colspan; span++) state.write("  |");
    });
    if (rowIndex === 0) {
      state.write("\n");
      state.write(`| ${rule.join(" | ")} |`);
    }
  });
  state.closeBlock(table);
}

const serializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    bullet_list: (state, node) => state.renderList(node, "  ", () => "- "),
    text: (state, node, parent, index) => state.text(textOf(node, parent, index), false),
    hard_break: (state, _node, parent, index) => {
      for (let next = index + 1; next < parent.childCount; next++) {
        if (parent.child(next).type.name === "hard_break") continue;
        state.write(index === 0 || parent.child(index - 1).type.name === "hard_break" ? "\\\n" : "\n");
        return;
      }
    },
    image: (state, node, parent) => {
      const alt = escapeMarkdown(node.attrs.alt || "", {
        lineStart: false,
        inCell: isCell(parent),
        inLink: true,
        last: false,
      });
      const title = node.attrs.title ? ` "${node.attrs.title.replace(/"/g, '\\"')}"` : "";
      state.write(`![${alt}](${node.attrs.src.replace(/[()]/g, "\\$&")}${title})`);
    },
    table: writeTable,
  },
  {
    ...defaultMarkdownSerializer.marks,
    strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
    code: {
      open: (_state, _mark, parent, index) => backticksFor(parent.child(index), -1),
      close: (_state, _mark, parent, index) => backticksFor(parent.child(index - 1), 1),
    },
  },
);

export const parseMarkdown = (value: string): DocumentNode => parser.parse(value);
export const serializeMarkdown = (doc: DocumentNode): string => serializer.serialize(doc);

function demoteHeadings(content: Fragment): Fragment {
  const nodes: DocumentNode[] = [];
  content.forEach((node) => {
    const inner = demoteHeadings(node.content);
    nodes.push(
      node.type.name === "heading" && node.attrs.level === 1
        ? node.type.create({ ...node.attrs, level: 2 }, inner, node.marks)
        : node.copy(inner),
    );
  });
  return Fragment.fromArray(nodes);
}

export function pastedSlice(slice: Slice): Slice {
  return new Slice(demoteHeadings(slice.content), slice.openStart, slice.openEnd);
}

export function parseClipboardText(text: string, plain: boolean): Slice {
  if (!plain) return Slice.maxOpen(parseMarkdown(text).content);
  const { doc, paragraph } = editorSchema.nodes;
  const lines = text.split(/\r?\n/).map((line) => paragraph!.create(null, line ? editorSchema.text(line) : undefined));
  return Slice.maxOpen(doc!.create(null, lines).content);
}

type TableAction = "insert" | "addRow" | "addColumn" | "deleteRow" | "deleteColumn" | "deleteTable";

export type Command =
  | { kind: "inline"; command: string }
  | { kind: "block"; tag: string }
  | { kind: "list"; command: string }
  | { kind: "code" }
  | { kind: "link" }
  | { kind: "table"; action: TableAction }
  | { kind: "clear" };

function ancestor(state: EditorState, names: string[]): number {
  const { $from, $to } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if (names.includes($from.node(depth).type.name) && $to.pos <= $from.end(depth)) return depth;
  }
  return -1;
}

function toggleList(name: "bullet_list" | "ordered_list"): EditorCommand {
  return (state, dispatch) => {
    const depth = ancestor(state, ["bullet_list", "ordered_list"]);
    const type = editorSchema.nodes[name]!;
    if (depth < 0) return wrapInList(type, { tight: true })(state, dispatch);
    const current = state.selection.$from.node(depth);
    if (current.type === type) return liftListItem(editorSchema.nodes.list_item!)(state, dispatch);
    dispatch?.(
      state.tr
        .setNodeMarkup(state.selection.$from.before(depth), type, { ...current.attrs, tight: true })
        .scrollIntoView(),
    );
    return true;
  };
}

const TABLE_COLUMNS = 3;
const TABLE_BODY_ROWS = 2;

const insertTable: EditorCommand = (state, dispatch) => {
  if (isInTable(state)) return false;
  const { table, table_row: row, table_header: header, table_cell: cell, paragraph } = editorSchema.nodes;
  const cells = (type: typeof cell) => Array.from({ length: TABLE_COLUMNS }, () => type!.create());
  const node = table!.create(null, [
    row!.create(null, cells(header)),
    ...Array.from({ length: TABLE_BODY_ROWS }, () => row!.create(null, cells(cell))),
  ]);
  if (dispatch) {
    const { $from } = state.selection;
    const inBlock = $from.parent.isTextblock;
    const firstInItem = inBlock && $from.node(-1).type.name === "list_item" && $from.index(-1) === 0;
    const blank = inBlock && $from.parent.content.size === 0 && !firstInItem;
    const from = !inBlock ? $from.pos : blank ? $from.before() : $from.after();
    const to = blank ? $from.after() : from;
    const atEnd = state.doc.resolve(to).nodeAfter === null;
    const tr = state.tr.replaceWith(from, to, atEnd ? [node, paragraph!.create()] : node);
    dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(from + 3))).scrollIntoView());
  }
  return true;
};

const nextCellOrNewRow: EditorCommand = (state, dispatch) => {
  if (!isInTable(state)) return false;
  if (goToNextCell(1)(state, dispatch)) return true;
  const grown: Transaction[] = [];
  addRowAfter(state, (transaction) => grown.push(transaction));
  const added = grown[0];
  if (added === undefined) return false;
  const moved: Transaction[] = [];
  goToNextCell(1)(state.apply(added), (transaction) => moved.push(transaction));
  if (moved[0] === undefined) return false;
  dispatch?.(added.setSelection(moved[0].selection).scrollIntoView());
  return true;
};

const TABLE_COMMANDS: Record<Exclude<TableAction, "insert">, EditorCommand> = {
  addRow: addRowAfter,
  addColumn: addColumnAfter,
  deleteRow,
  deleteColumn,
  deleteTable,
};

function textSelection(state: EditorState): EditorState {
  if (!(state.selection instanceof AllSelection)) return state;
  const from = TextSelection.atStart(state.doc).from;
  const to = TextSelection.atEnd(state.doc).to;
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

export function commandFor(command: Command, href?: string): EditorCommand {
  const run = documentCommand(command, href);
  return (state, dispatch, view) => run(textSelection(state), dispatch, view);
}

function documentCommand(command: Command, href?: string): EditorCommand {
  if (command.kind === "inline" || command.kind === "code") {
    const name =
      command.kind === "code" ? "code" : { bold: "strong", italic: "em", strikeThrough: "strike" }[command.command];
    return name === undefined ? () => false : toggleMark(editorSchema.marks[name]!);
  }
  if (command.kind === "list")
    return toggleList(command.command === "insertOrderedList" ? "ordered_list" : "bullet_list");
  if (command.kind === "table") return command.action === "insert" ? insertTable : TABLE_COMMANDS[command.action];
  if (command.kind === "block") {
    if (command.tag === "blockquote")
      return (state, dispatch) =>
        ancestor(state, ["blockquote"]) >= 0
          ? lift(state, dispatch)
          : wrapIn(editorSchema.nodes.blockquote!)(state, dispatch);
    const level = Number(command.tag.slice(1));
    return (state, dispatch) => {
      const same =
        state.selection.$from.parent.type.name === "heading" && state.selection.$from.parent.attrs.level === level;
      return setBlockType(
        same ? editorSchema.nodes.paragraph! : editorSchema.nodes.heading!,
        same ? undefined : { level },
      )(state, dispatch);
    };
  }
  if (command.kind === "link")
    return (state, dispatch) => {
      const url = safeHref(href ?? "");
      if (url === null || state.selection.empty) return false;
      dispatch?.(
        state.tr
          .addMark(state.selection.from, state.selection.to, editorSchema.marks.link!.create({ href: url }))
          .scrollIntoView(),
      );
      return true;
    };
  return (state, dispatch) => {
    dispatch?.(state.tr.removeMark(state.selection.from, state.selection.to).setStoredMarks([]));
    return true;
  };
}

export function activeFormats(state: EditorState): Record<string, boolean> {
  state = textSelection(state);
  const { from, to, empty, $from } = state.selection;
  const active = (name: string) =>
    empty
      ? editorSchema.marks[name]!.isInSet(state.storedMarks ?? $from.marks()) !== undefined
      : state.doc.rangeHasMark(from, to, editorSchema.marks[name]!);
  return {
    bold: active("strong"),
    italic: active("em"),
    strike: active("strike"),
    code: active("code"),
    link: active("link"),
    h2: $from.parent.type.name === "heading" && $from.parent.attrs.level === 2,
    h3: $from.parent.type.name === "heading" && $from.parent.attrs.level === 3,
    quote: ancestor(state, ["blockquote"]) >= 0,
    bullet: ancestor(state, ["bullet_list"]) >= 0,
    number: ancestor(state, ["ordered_list"]) >= 0,
    table: isInTable(state),
  };
}

export function createEditorState(value: string): EditorState {
  const nodes = editorSchema.nodes;
  return EditorState.create({
    doc: parseMarkdown(value),
    plugins: [
      inputRules({
        rules: [
          wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list!, { tight: true }),
          wrappingInputRule(/^(\d+)\.\s$/, nodes.ordered_list!, (match) => ({ order: Number(match[1]), tight: true })),
          wrappingInputRule(/^\s*>\s$/, nodes.blockquote!),
          textblockTypeInputRule(/^(#{2,6})\s$/, nodes.heading!, (match) => ({ level: match[1]!.length })),
          textblockTypeInputRule(/^```$/, nodes.code_block!),
        ],
      }),
      tableEditing(),
      gapCursor(),
      keymap({
        "Mod-b": toggleMark(editorSchema.marks.strong!),
        "Mod-i": toggleMark(editorSchema.marks.em!),
        "Mod-`": toggleMark(editorSchema.marks.code!),
        "Mod-z": undo,
        "Shift-Mod-z": redo,
        "Mod-y": redo,
        Backspace: undoInputRule,
        Enter: chainCommands(nextCellOrNewRow, newlineInCode, splitListItem(nodes.list_item!), baseKeymap.Enter!),
        "Shift-Enter": (state, dispatch) => {
          if (isInTable(state)) return true;
          dispatch?.(state.tr.replaceSelectionWith(nodes.hard_break!.create()).scrollIntoView());
          return true;
        },
        Tab: chainCommands(nextCellOrNewRow, sinkListItem(nodes.list_item!)),
        "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(nodes.list_item!)),
      }),
      keymap(baseKeymap),
      history(),
    ],
  });
}
