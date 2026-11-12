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

import { describe, it, expect } from "vitest";
import type { Node as ProseNode } from "prosemirror-model";
import { TextSelection } from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import { undo, redo } from "prosemirror-history";
import type { EditorView } from "prosemirror-view";
import { sinkListItem, liftListItem, splitListItem } from "prosemirror-schema-list";
import {
  activeFormats,
  commandFor,
  createEditorState,
  editorSchema,
  parseClipboardText,
  parseMarkdown,
  pastedSlice,
  safeHref,
  serializeMarkdown,
  softBreak,
} from "./rich-text";

const samples = [
  "",
  "Answer clearly.",
  "Answer **clearly** and *briefly*.",
  "**Purpose**\n\n- Use my CV.\n- Check **my contribution**.\n\n**Style**\n\n- Keep it brief.",
  "- first\n  - nested **bold**\n    1. deeper\n  - sibling\n- last",
  "3. third\n4. fourth\n\n- separate list",
  "- first\n\n  A second paragraph.\n\n- second",
  "> ## A heading\n>\n> - a quote\n>   - nested quote list",
  "Paragraph with **bold and *italic*** plus ~~strike~~ and ``a ` backtick``.",
  "See [the docs](https://example.com/path_(one)) and <https://github.com>.",
  "```ts\nconst a = '**not bold**';\n// # Role stays code\n```",
  "Line one\nline two\n\n---\n\nLast paragraph.",
  "<script>alert('not HTML')</script>",
  "![an image](https://example.com/image.png)",
];

describe("structured Markdown document round trips", () => {
  it.each(samples)("keeps the document structure through repeated reloads: %j", (value) => {
    const first = parseMarkdown(value);
    let saved = serializeMarkdown(first);
    for (let pass = 0; pass < 5; pass++) {
      const restored = parseMarkdown(saved);
      expect(restored.toJSON()).toEqual(first.toJSON());
      expect(serializeMarkdown(restored)).toBe(saved);
      saved = serializeMarkdown(restored);
    }
  });

  it("does not turn Markdown-looking code into marks or lists", () => {
    const doc = parseMarkdown("```\n- one\n**two**\n```");
    expect(doc.firstChild?.type.name).toBe("code_block");
    expect(doc.firstChild?.textContent).toBe("- one\n**two**");
  });
});

function editing(value: string) {
  let state = createEditorState(value);
  const dispatch = (transaction: Transaction) => {
    state = state.apply(transaction);
  };
  const select = (text: string) => {
    let from = -1;
    state.doc.descendants((node, pos) => {
      if (from < 0 && node.isText && node.text?.includes(text)) from = pos + node.text.indexOf(text);
    });
    if (from < 0) throw new Error(`Text not found: ${text}`);
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, from + text.length)));
  };
  return {
    get state(): EditorState {
      return state;
    },
    dispatch,
    select,
    markdown: () => serializeMarkdown(state.doc),
    command: (command: Parameters<typeof commandFor>[0], href?: string) => commandFor(command, href)(state, dispatch),
  };
}

describe("formatting transactions and history", () => {
  it("turns selected paragraphs into persistent bullets, even without typing or blur", () => {
    const editor = editing("One\n\nTwo");
    editor.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, editor.state.doc.content.size - 1)),
    );
    expect(editor.command({ kind: "list", command: "insertUnorderedList" })).toBe(true);
    expect(editor.markdown()).toBe("- One\n- Two");
    expect(parseMarkdown(editor.markdown()).firstChild?.type.name).toBe("bullet_list");
    expect(activeFormats(editor.state).bullet).toBe(true);
    expect(undo(editor.state, editor.dispatch)).toBe(true);
    expect(editor.markdown()).toBe("One\n\nTwo");
    expect(redo(editor.state, editor.dispatch)).toBe(true);
    expect(editor.markdown()).toBe("- One\n- Two");
  });

  it("toggles list types and removes bullets without flattening the words", () => {
    const editor = editing("- One\n- Two");
    editor.select("One");
    editor.command({ kind: "list", command: "insertOrderedList" });
    expect(editor.markdown()).toBe("1. One\n2. Two");
    editor.command({ kind: "list", command: "insertOrderedList" });
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.textContent).toBe("OneTwo");
  });

  it("indents, outdents and splits list items using document transactions", () => {
    const editor = editing("- One\n- Two");
    editor.select("Two");
    expect(sinkListItem(editorSchema.nodes.list_item!)(editor.state, editor.dispatch)).toBe(true);
    expect(editor.markdown()).toBe("- One\n  - Two");
    expect(liftListItem(editorSchema.nodes.list_item!)(editor.state, editor.dispatch)).toBe(true);
    expect(editor.markdown()).toBe("- One\n- Two");
    const end = editor.state.selection.to;
    editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)));
    expect(splitListItem(editorSchema.nodes.list_item!)(editor.state, editor.dispatch)).toBe(true);
    expect(editor.state.doc.firstChild?.childCount).toBe(3);
  });

  it("keeps bold, italic, strike, code and link edits across document reloads", () => {
    const editor = editing("Bold italic outdated code docs");
    for (const [text, command] of [
      ["Bold", "bold"],
      ["italic", "italic"],
      ["outdated", "strikeThrough"],
    ]) {
      editor.select(text!);
      editor.command({ kind: "inline", command: command! });
    }
    editor.select("code");
    editor.command({ kind: "code" });
    editor.select("docs");
    editor.command({ kind: "link" }, "https://github.com");
    expect(editor.markdown()).toBe("**Bold** *italic* ~~outdated~~ `code` [docs](https://github.com)");
    expect(parseMarkdown(editor.markdown()).toJSON()).toEqual(editor.state.doc.toJSON());
  });

  it("preserves the selection bookmark while editing a link destination", () => {
    const editor = editing("Read the docs here");
    editor.select("the docs");
    const saved = editor.state.selection.getBookmark();
    editor.dispatch(editor.state.tr.setSelection(TextSelection.atStart(editor.state.doc)));
    editor.dispatch(editor.state.tr.setSelection(saved.resolve(editor.state.doc)));
    editor.command({ kind: "link" }, "https://example.com");
    expect(editor.markdown()).toBe("Read [the docs](https://example.com) here");
  });

  it("clears marks and toggles headings and quotes", () => {
    const editor = editing("**Title**");
    editor.select("Title");
    editor.command({ kind: "clear" });
    expect(editor.markdown()).toBe("Title");
    editor.command({ kind: "block", tag: "h2" });
    expect(editor.markdown()).toBe("## Title");
    editor.command({ kind: "block", tag: "h2" });
    editor.command({ kind: "block", tag: "blockquote" });
    expect(editor.markdown()).toBe("> Title");
    editor.command({ kind: "block", tag: "blockquote" });
    expect(editor.markdown()).toBe("Title");
  });
});

describe("safe link handling", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "vbscript:x",
    "java\nscript:alert(1)",
    "",
    "https://a.test/a b",
  ])("rejects %j", (href) => {
    expect(safeHref(href)).toBeNull();
    const editor = editing("link");
    editor.select("link");
    expect(editor.command({ kind: "link" }, href)).toBe(false);
    expect(editor.markdown()).toBe("link");
  });
  it.each(["https://github.com", "http://localhost:5173", "mailto:a@example.com", "/docs", "#section"])(
    "accepts %j",
    (href) => {
      expect(safeHref(href)).toBe(href);
    },
  );
  it("never parses raw HTML into executable document nodes", () => {
    const doc = parseMarkdown("<script>alert(1)</script>\n\n[x](javascript:alert%281%29)");
    expect(doc.textContent).toContain("<script>");
    doc.descendants((node) => expect(node.marks.some((mark) => mark.type.name === "link")).toBe(false));
  });
});

const plain = (text: string) =>
  editorSchema.nodes.doc!.create(null, editorSchema.nodes.paragraph!.create(null, editorSchema.text(text)));

describe("Markdown the editor leaves exactly as it was written", () => {
  it.each([
    "line one\nline two\nline three",
    "C:\\path\\to and \\d+ regex and a trailing backslash\\",
    "Use [name] and [1] and [PLACEHOLDER] in the answer",
    "AT&amp;T and &copy; and a < b and <https://example.com>",
    "- [ ] todo\n- [x] done",
    "a * b and snake_case and 3 ~ 4",
    "[ref]: https://example.com\n\nSee [ref]",
    "> quote line one\n> quote line two",
    "- item one\n  continues here\n- item two",
    "Note: *emphasis* and **strong** and `code with | pipe`",
    "<!-- a comment --> and <b>not html</b>",
    "Intro\n\n---\n\nEnd",
    '```json\n{"a": [1, 2]}\n```',
    "Price: $5 + $6 = $11; 50% off; x^2; #hashtag; 100%",
    "First\n\n## Heading\n\nSecond paragraph\nwith two lines.",
  ])("%j", (value) => {
    expect(serializeMarkdown(parseMarkdown(value))).toBe(value);
  });

  it("never adds a backslash to a line that was only wrapped", () => {
    expect(serializeMarkdown(parseMarkdown("| Scenario | Behavior |\nplain\nlines"))).not.toContain("\\");
  });
});

describe("text typed in the editor is saved so that it reads back as the same text", () => {
  it.each([
    "# h",
    "###### six",
    "####### seven",
    "- a",
    "+ a",
    "* a",
    "-",
    "+",
    "1. a",
    "12) a",
    ">q",
    "---",
    "***",
    "___",
    "===",
    "***bold***",
    "*a*",
    "_a_",
    "__a__",
    "a_b_c",
    "`code`",
    "``x``",
    "~~x~~",
    "~x~",
    "[a](b)",
    "![a](b)",
    "[a][b]",
    "<https://x.y>",
    "<a@b.co>",
    "\\*",
    "\\\\",
    "a\\",
    "a\\b",
    "C:\\dir\\file",
    "| a | b |",
    "&amp;",
    "<b>x</b>",
    "1.",
    "a 1. b",
    "\\`",
  ])("%j", (text) => {
    const saved = serializeMarkdown(plain(text));
    expect(parseMarkdown(saved).textContent).toBe(text);
    expect(parseMarkdown(saved).childCount).toBe(1);
    expect(parseMarkdown(saved).firstChild?.type.name).toBe("paragraph");
  });

  it("only escapes what would otherwise change the meaning", () => {
    expect(serializeMarkdown(plain("# h and C:\\dir and [x] and a*b"))).toBe("\\# h and C:\\dir and [x] and a\\*b");
    expect(serializeMarkdown(plain("[a](b)"))).toBe("[a\\](b)");
    expect(serializeMarkdown(plain("1. a"))).toBe("1\\. a");
  });
});

describe("line breaks", () => {
  const withBreaks = (...parts: (string | null)[]) =>
    editorSchema.nodes.doc!.create(
      null,
      editorSchema.nodes.paragraph!.create(
        null,
        parts.map((part) => (part === null ? editorSchema.nodes.hard_break!.create() : editorSchema.text(part))),
      ),
    );

  it("are saved as plain new lines and read back as line breaks", () => {
    const doc = withBreaks("a", null, "b");
    expect(serializeMarkdown(doc)).toBe("a\nb");
    expect(parseMarkdown("a\nb").toJSON()).toEqual(doc.toJSON());
  });

  it("keep an empty line inside a paragraph from splitting it in two", () => {
    const doc = withBreaks("a", null, null, "b");
    const saved = serializeMarkdown(doc);
    expect(saved).toBe("a\n\\\nb");
    expect(parseMarkdown(saved).toJSON()).toEqual(doc.toJSON());
  });

  it("keep a break at the start of a paragraph inside that paragraph", () => {
    const doc = withBreaks(null, "b");
    expect(parseMarkdown(serializeMarkdown(doc)).childCount).toBe(1);
  });

  it("read a backslash or two spaces before the line end as a break, and save it as a plain new line", () => {
    expect(serializeMarkdown(parseMarkdown("x\\\ny"))).toBe("x\ny");
    expect(serializeMarkdown(parseMarkdown("x  \ny"))).toBe("x\ny");
  });

  it("do not let the next line start a list, heading or quote", () => {
    const doc = withBreaks("a", null, "# b", null, "- c", null, "1. d");
    const saved = serializeMarkdown(doc);
    expect(saved).toBe("a\n\\# b\n\\- c\n1\\. d");
    expect(parseMarkdown(saved).toJSON()).toEqual(doc.toJSON());
  });
});

const TABLE = "| Scenario | Behavior |\n| --- | --- |\n| Signed out | Ask for the date |";

function tableOf(value: string) {
  const table = parseMarkdown(value).firstChild!;
  return { table, rows: table.childCount, columns: table.firstChild!.childCount };
}

describe("tables", () => {
  it("are read as a header row and body rows", () => {
    const { table, rows, columns } = tableOf(TABLE);
    expect(table.type.name).toBe("table");
    expect([rows, columns]).toEqual([2, 2]);
    expect(table.child(0).child(0).type.name).toBe("table_header");
    expect(table.child(1).child(1).type.name).toBe("table_cell");
    expect(table.child(1).child(1).textContent).toBe("Ask for the date");
  });

  it.each([
    TABLE,
    "| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |",
    "| **bold** | `code` | [link](https://example.com) |\n| --- | --- | --- |\n| *em* | ~~gone~~ | x |",
    "| a |\n| --- |\n| pipe \\| inside |",
    "| `x \\| y` |\n| --- |\n| z |",
    "| a | b |\n| --- | --- |\n|  | z |",
    "Before\n\n| a |\n| --- |\n| 1 |\n\nAfter",
    "> | a | b |\n> | --- | --- |\n> | 1 | 2 |",
  ])("are saved as the same table: %j", (value) => {
    expect(serializeMarkdown(parseMarkdown(value))).toBe(value);
  });

  it("take only left, right and center from a pasted table's alignment, nothing else a page could put in a style", () => {
    const spec = editorSchema.nodes.table_cell!.spec;
    const read = (value: string) => {
      const dom = { getAttribute: () => null, style: { textAlign: value } } as unknown as HTMLElement;
      const rule = spec.parseDOM![0] as unknown as { getAttrs: (dom: HTMLElement) => { align?: unknown } };
      return rule.getAttrs(dom).align;
    };
    expect(read("center")).toBe("center");
    expect(read("justify; background: url(https://x.example/a)")).toBeUndefined();
    expect(read("")).toBeUndefined();
    const written = (align: string) => {
      const node = editorSchema.nodes.table_cell!.create({ align });
      return (spec.toDOM!(node) as unknown as [string, Record<string, string>])[1];
    };
    expect(written("right").style).toBe("text-align: right");
    expect(written("right; background: red").style).toBeUndefined();
  });

  it("keep the column alignment", () => {
    const row = tableOf("| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |").table.child(0);
    expect([0, 1, 2].map((column) => row.child(column).attrs.align)).toEqual(["left", "center", "right"]);
  });

  it("are tidied when read: padding goes, the rule row becomes short", () => {
    const padded = "| Scenario | Behavior |\n|----------|----------|\n| A | B |";
    expect(serializeMarkdown(parseMarkdown(padded))).toBe("| Scenario | Behavior |\n| --- | --- |\n| A | B |");
  });

  it("read a row with too few cells as having empty ones", () => {
    expect(serializeMarkdown(parseMarkdown("| a | b |\n| --- | --- |\n| only |"))).toBe(
      "| a | b |\n| --- | --- |\n| only |  |",
    );
  });

  it("read a table written without outer pipes", () => {
    expect(serializeMarkdown(parseMarkdown("x | y\n--|--\n1 | 2"))).toBe("| x | y |\n| --- | --- |\n| 1 | 2 |");
  });

  it("do not turn up where the text only has a pipe in it", () => {
    expect(parseMarkdown("a | b\n\nsecond").firstChild?.type.name).toBe("paragraph");
  });

  it("cannot hold a line break, so a pasted one is dropped from the cell", () => {
    const doc = parseMarkdown(TABLE);
    expect(() => doc.check()).not.toThrow();
    expect(editorSchema.nodes.table_cell!.spec.content).toBe("(text | image)*");
  });
});

function press(editor: ReturnType<typeof editing>, key: string, shift = false): boolean {
  const view = {
    get state() {
      return editor.state;
    },
    dispatch: editor.dispatch,
  } as unknown as EditorView;
  const event = { key, shiftKey: shift, ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent;
  return editor.state.plugins.some((plugin) => plugin.props.handleKeyDown?.call(plugin, view, event) === true);
}

describe("editing a table", () => {
  const grid = "| a | b |\n| --- | --- |\n| A | B |";
  const cellOf = (editor: ReturnType<typeof editing>) => editor.state.selection.$from.parent.textContent;

  it("inserts a table of three columns with a header row, below the paragraph, and a paragraph to keep typing in", () => {
    const editor = editing("Intro");
    editor.select("Intro");
    expect(editor.command({ kind: "table", action: "insert" })).toBe(true);
    const names: string[] = [];
    editor.state.doc.forEach((node) => names.push(node.type.name));
    expect(names).toEqual(["paragraph", "table", "paragraph"]);
    expect(editor.state.doc.child(1).childCount).toBe(3);
    expect(editor.state.doc.child(1).firstChild?.childCount).toBe(3);
    expect(editor.state.selection.$from.parent.type.name).toBe("table_header");
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(parseMarkdown(editor.markdown()).child(1).type.name).toBe("table");
  });

  it("replaces an empty paragraph with the table", () => {
    const editor = editing("");
    expect(editor.command({ kind: "table", action: "insert" })).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("table");
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
  });

  it("puts a table inside a list item below its first paragraph", () => {
    const editor = editing("- item");
    editor.select("item");
    expect(editor.command({ kind: "table", action: "insert" })).toBe(true);
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(editor.state.doc.firstChild?.firstChild?.child(1).type.name).toBe("table");
  });

  it("does not put a table inside a table", () => {
    const editor = editing(grid);
    editor.select("A");
    expect(editor.command({ kind: "table", action: "insert" })).toBe(false);
  });

  it("adds and removes rows and columns where the cursor is, and removes the table", () => {
    const editor = editing(grid);
    editor.select("A");
    editor.command({ kind: "table", action: "addRow" });
    expect(tableOf(editor.markdown()).rows).toBe(3);
    editor.command({ kind: "table", action: "addColumn" });
    expect(tableOf(editor.markdown()).columns).toBe(3);
    editor.command({ kind: "table", action: "deleteRow" });
    expect(tableOf(editor.markdown()).rows).toBe(2);
    editor.select("a");
    editor.command({ kind: "table", action: "deleteColumn" });
    expect(tableOf(editor.markdown()).columns).toBe(2);
    editor.command({ kind: "table", action: "deleteTable" });
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("offers the table commands only inside a table", () => {
    const editor = editing(`${grid}\n\nOutside`);
    editor.select("Outside");
    expect(editor.command({ kind: "table", action: "addRow" })).toBe(false);
    expect(activeFormats(editor.state).table).toBe(false);
    editor.select("A");
    expect(activeFormats(editor.state).table).toBe(true);
  });

  it("moves to the next cell on Tab and the previous on Shift-Tab", () => {
    const editor = editing(grid);
    editor.select("A");
    expect(press(editor, "Tab")).toBe(true);
    expect(cellOf(editor)).toBe("B");
    expect(press(editor, "Tab", true)).toBe(true);
    expect(cellOf(editor)).toBe("A");
  });

  it("adds a row when Tab is pressed in the last cell, and puts the cursor in it", () => {
    const editor = editing(grid);
    editor.select("B");
    expect(press(editor, "Tab")).toBe(true);
    expect(tableOf(editor.markdown()).rows).toBe(3);
    expect(editor.state.selection.$from.parent.type.name).toBe("table_cell");
    expect(cellOf(editor)).toBe("");
    expect(editor.state.selection.$from.index(-1)).toBe(0);
    expect(editor.state.selection.$from.index(-2)).toBe(2);
  });

  it("uses Enter like Tab, and Shift-Enter makes no line break, since a cell cannot hold one", () => {
    const editor = editing(grid);
    editor.select("A");
    expect(press(editor, "Enter")).toBe(true);
    expect(cellOf(editor)).toBe("B");
    const before = editor.markdown();
    expect(press(editor, "Enter", true)).toBe(true);
    expect(editor.markdown()).toBe(before);
  });

  it("keeps typed text containing a pipe inside its cell", () => {
    const editor = editing(grid);
    editor.select("A");
    editor.dispatch(editor.state.tr.insertText("x | y"));
    expect(editor.markdown()).toContain("| x \\| y |");
    expect(tableOf(editor.markdown()).columns).toBe(2);
  });

  it("goes back to the same table after undo", () => {
    const editor = editing(grid);
    editor.select("A");
    editor.command({ kind: "table", action: "deleteTable" });
    expect(undo(editor.state, editor.dispatch)).toBe(true);
    expect(editor.markdown()).toBe(grid);
  });
});

describe("pasting", () => {
  it("reads pasted Markdown, tables included", () => {
    const slice = parseClipboardText(TABLE, false);
    expect(slice.content.firstChild?.type.name).toBe("table");
  });

  it("makes a paragraph of each pasted line when pasted as plain text", () => {
    const slice = parseClipboardText("one\n\ntwo", true);
    expect(slice.content.childCount).toBe(3);
    expect(slice.content.textBetween(0, slice.content.size, "|")).toBe("one||two");
  });

  it("never lets a pasted top heading start a new section of the agent file", () => {
    const slice = pastedSlice(parseClipboardText("# Title\n\n## Sub\n\n### Small\n\n> # Quoted", false));
    const levels: number[] = [];
    slice.content.descendants((node) => {
      if (node.type.name === "heading") levels.push(node.attrs.level);
    });
    expect(levels).toEqual([2, 2, 3, 2]);
  });
});

describe("a table with cells that span rows", () => {
  const { doc, table, table_row: row, table_header: header, table_cell: cell } = editorSchema.nodes;
  const text = (value: string) => editorSchema.text(value);
  const made = (rows: ProseNode[]) => doc!.create(null, [table!.create(null, rows)]);

  it("keeps the cells after a cell that reaches into the next row in their own columns", () => {
    const pasted = made([
      row!.create(null, [header!.create(null, [text("A")]), header!.create(null, [text("B")])]),
      row!.create(null, [cell!.create({ rowspan: 2 }, [text("x")]), cell!.create(null, [text("1")])]),
      row!.create(null, [cell!.create(null, [text("2")])]),
    ]);
    const saved = serializeMarkdown(pasted);
    expect(saved).toBe("| A | B |\n| --- | --- |\n| x | 1 |\n|  | 2 |");
    const again = parseMarkdown(saved).firstChild!;
    expect(again.child(2).child(0).textContent).toBe("");
    expect(again.child(2).child(1).textContent).toBe("2");
  });

  it("handles a cell that spans rows and columns", () => {
    const pasted = made([
      row!.create(null, [header!.create(null, [text("A")]), header!.create(null, [text("B")]), header!.create(null, [text("C")])]),
      row!.create(null, [cell!.create({ rowspan: 2, colspan: 2 }, [text("big")]), cell!.create(null, [text("1")])]),
      row!.create(null, [cell!.create(null, [text("2")])]),
    ]);
    expect(serializeMarkdown(pasted)).toBe("| A | B | C |\n| --- | --- | --- |\n| big |  | 1 |\n|  |  | 2 |");
  });

  it("leaves a table without spans as it was", () => {
    const value = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(serializeMarkdown(parseMarkdown(value))).toBe(value);
  });

  it("does not fail on a row that has fewer cells than the first row", () => {
    expect(() => serializeMarkdown(parseMarkdown("| a | b |\n| --- | --- |\n| 1 |"))).not.toThrow();
  });
});

describe("Shift+Enter", () => {
  const applied = (value: string, at: number) => {
    const start = createEditorState(value);
    const state = start.apply(start.tr.setSelection(TextSelection.create(start.doc, at)));
    let next: EditorState = state;
    const handled = softBreak(state, (tr) => {
      next = state.apply(tr);
    });
    return { handled, next };
  };

  it("adds a new line inside a code block", () => {
    const { handled, next } = applied("```\nab\n```", 2);
    expect(handled).toBe(true);
    expect(next.doc.firstChild!.type.name).toBe("code_block");
    expect(next.doc.firstChild!.textContent).toBe("a\nb");
  });

  it("adds a line break inside a paragraph", () => {
    const { handled, next } = applied("ab", 2);
    expect(handled).toBe(true);
    expect(next.doc.firstChild!.childCount).toBe(3);
    expect(next.doc.firstChild!.child(1).type.name).toBe("hard_break");
  });

  it("does nothing inside a table cell", () => {
    const { handled, next } = applied("| a | b |\n| --- | --- |\n| 1 | 2 |", 4);
    expect(handled).toBe(true);
    expect(serializeMarkdown(next.doc)).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });
});
