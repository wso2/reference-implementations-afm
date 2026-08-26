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

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { TextSelection } from "prosemirror-state";
import type { SelectionBookmark } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import {
  activeFormats,
  commandFor,
  createEditorState,
  parseClipboardText,
  parseMarkdown,
  pastedSlice,
  serializeMarkdown,
} from "./rich-text";
import type { Command } from "./rich-text";
import "prosemirror-gapcursor/style/gapcursor.css";
import "prosemirror-view/style/prosemirror.css";

export interface RichTextHandle {
  command(command: Command, href?: string): void;
  replaceMarkdown(value: string): void;
  bookmark(): SelectionBookmark | null;
  restore(bookmark: SelectionBookmark | null): void;
}
interface Props {
  value: string;
  placeholder: string;
  className?: string;
  onChange: (markdown: string) => void;
  onFormats?: (formats: Record<string, boolean>) => void;
  docKey?: string;
  rewindOnBlur?: boolean;
  ariaLabel: string;
  hidden?: boolean;
}

export const RichText = forwardRef<RichTextHandle, Props>(function RichText(props, ref) {
  const box = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const lastEmitted = useRef(props.value);

  function decorate(view: EditorView): void {
    const node = view.dom;
    node.classList.toggle(
      "is-empty",
      view.state.doc.textContent === "" &&
        view.state.doc.childCount === 1 &&
        view.state.doc.firstChild?.type.name === "paragraph",
    );
    node.classList.toggle("has-more", node.scrollHeight - node.scrollTop - node.clientHeight > 1);
    node.classList.toggle("has-less", node.scrollTop > 1);
  }

  useImperativeHandle(
    ref,
    () => ({
      command(command, href) {
        const view = editor.current;
        if (view === null) return;
        commandFor(command, href)(view.state, view.dispatch, view);
        view.focus();
      },
      replaceMarkdown(value) {
        const view = editor.current;
        if (view === null) return;
        view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parseMarkdown(value).content));
        view.focus();
      },
      bookmark: () => editor.current?.state.selection.getBookmark() ?? null,
      restore(bookmark) {
        const view = editor.current;
        if (view === null || bookmark === null) return;
        try {
          view.dispatch(view.state.tr.setSelection(bookmark.resolve(view.state.doc)));
        } catch {
          view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
        }
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    if (box.current === null) return;
    lastEmitted.current = latest.current.value;
    const view: EditorView = new EditorView(
      { mount: box.current },
      {
        state: createEditorState(latest.current.value),
        attributes: { role: "textbox", "aria-multiline": "true", "aria-label": latest.current.ariaLabel },
        dispatchTransaction(transaction) {
          const updated = view.state.applyTransaction(transaction);
          view.updateState(updated.state);
          decorate(view);
          if (updated.transactions.some((change) => change.docChanged)) {
            const value = serializeMarkdown(view.state.doc);
            if (value !== lastEmitted.current) {
              lastEmitted.current = value;
              latest.current.onChange(value);
            }
          }
          latest.current.onFormats?.(activeFormats(view.state));
        },
        clipboardTextParser: (text, _context, plain) => parseClipboardText(text, plain),
        transformPasted: pastedSlice,
        handleDOMEvents: {
          blur() {
            if (latest.current.rewindOnBlur) view.dom.scrollTop = 0;
            decorate(view);
            return false;
          },
          scroll() {
            decorate(view);
            return false;
          },
          click(_view, event) {
            if ((event.target as Element).closest("a")) event.preventDefault();
            return false;
          },
        },
      },
    );
    editor.current = view;
    decorate(view);
    latest.current.onFormats?.(activeFormats(view.state));
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, [props.docKey]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (view === null || props.value === lastEmitted.current) return;
    lastEmitted.current = props.value;
    const document = parseMarkdown(props.value);
    if (!document.eq(view.state.doc)) view.updateState(createEditorState(props.value));
    decorate(view);
    latest.current.onFormats?.(activeFormats(view.state));
  }, [props.value, props.docKey]);

  return (
    <div
      ref={box}
      className={`rich-text ${props.className ?? ""}`}
      hidden={props.hidden}
      data-placeholder={props.placeholder}
    />
  );
});
