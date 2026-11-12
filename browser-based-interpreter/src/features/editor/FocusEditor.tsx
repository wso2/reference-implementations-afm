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

import { type SelectionBookmark } from "prosemirror-state";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { canTidy, tidyIntoBullets } from "../../core/agent/tidy-bullets";
import { useModalPage } from "../../ui/hooks";
import { Icon } from "../../ui/Icon";
import { type WriteMode, WriteModeSwitch } from "../../ui/ViewControls";
import { RichText, type RichTextHandle } from "./RichText";
import { type Command, safeHref } from "./rich-text";

interface Props {
  title: string;
  hint: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onClose: () => void;
}

interface Tool {
  key: string;
  label: string;
  command: Command;
  icon: ReactNode;
}

const TOOLS: Tool[][] = [
  [
    {
      key: "bold",
      label: "Bold",
      command: { kind: "inline", command: "bold" },
      icon: <path d="M7 5h6a3.5 3.5 0 010 7H7zM7 12h7a3.5 3.5 0 010 7H7z" />,
    },
    {
      key: "italic",
      label: "Italic",
      command: { kind: "inline", command: "italic" },
      icon: <path d="M15 5h-5M14 19H9M14 5l-4 14" />,
    },
    {
      key: "strike",
      label: "Strikethrough",
      command: { kind: "inline", command: "strikeThrough" },
      icon: <path d="M5 12h14M16 7a4 4 0 00-8 .5c0 1.5 1 2.3 3 3M8.5 17a4 4 0 007-2" />,
    },
    { key: "code", label: "Code", command: { kind: "code" }, icon: <path d="M9 18l-6-6 6-6M15 6l6 6-6 6" /> },
  ],
  [
    { key: "h2", label: "Heading", command: { kind: "block", tag: "h2" }, icon: <path d="M6 5v14M16 5v14M6 12h10" /> },
    {
      key: "h3",
      label: "Small heading",
      command: { kind: "block", tag: "h3" },
      icon: <path d="M5 6v12M14 6v12M5 12h9M19 9v6" />,
    },
    {
      key: "quote",
      label: "Quote",
      command: { kind: "block", tag: "blockquote" },
      icon: <path d="M7 7h4v6H7zM13 7h4v6h-4M9 13v4M15 13v4" />,
    },
  ],
  [
    {
      key: "bullet",
      label: "Bulleted list",
      command: { kind: "list", command: "insertUnorderedList" },
      icon: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
    },
    {
      key: "number",
      label: "Numbered list",
      command: { kind: "list", command: "insertOrderedList" },
      icon: <path d="M10 6h10M10 12h10M10 18h10M4 6h2M4 12h2l-2 3h2M4 18h2v3H4" />,
    },
  ],
  [
    {
      key: "table",
      label: "Table",
      command: { kind: "table", action: "insert" },
      icon: <path d="M4 5h16v14H4zM4 10h16M4 15h16M10 5v14" />,
    },
  ],
  [
    {
      key: "clear",
      label: "Clear inline formatting",
      command: { kind: "clear" },
      icon: <path d="M4 7h16M7 7l1.5 12h7L17 7M10 11v4M14 11v4" />,
    },
  ],
];

const TABLE_TOOLS: Tool[] = [
  {
    key: "addRow",
    label: "Add row below",
    command: { kind: "table", action: "addRow" },
    icon: <path d="M4 4h16v9H4zM4 8.5h16M12 16v5M9.5 18.5h5" />,
  },
  {
    key: "addColumn",
    label: "Add column on the right",
    command: { kind: "table", action: "addColumn" },
    icon: <path d="M4 4h9v16H4zM8.5 4v16M16 12h5M18.5 9.5v5" />,
  },
  {
    key: "deleteRow",
    label: "Delete row",
    command: { kind: "table", action: "deleteRow" },
    icon: <path d="M4 4h16v9H4zM4 8.5h16M9.5 16l5 5M14.5 16l-5 5" />,
  },
  {
    key: "deleteColumn",
    label: "Delete column",
    command: { kind: "table", action: "deleteColumn" },
    icon: <path d="M4 4h9v16H4zM8.5 4v16M16 9.5l5 5M21 9.5l-5 5" />,
  },
  {
    key: "deleteTable",
    label: "Delete table",
    command: { kind: "table", action: "deleteTable" },
    icon: <path d="M4 5h16v14H4zM9 9.5l6 5M15 9.5l-6 5" />,
  },
];

interface ToolGroupProps {
  tools: Tool[];
  formats: Record<string, boolean>;
  onRun: (command: Command) => void;
}

function ToolGroup({ tools, formats, onRun }: ToolGroupProps) {
  return (
    <div className="u-tool-group">
      {tools.map((tool) => (
        <button
          key={tool.key}
          className="u-tbtn"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onRun(tool.command)}
          aria-pressed={formats[tool.key] ?? false}
          data-tip={tool.label}
          aria-label={tool.label}
        >
          <Icon size={15}>{tool.icon}</Icon>
        </button>
      ))}
    </div>
  );
}

export function FocusEditor({ title, hint, value, placeholder, onChange, onClose }: Props) {
  const [mode, setMode] = useState<WriteMode>("rich");
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState("");
  const editor = useRef<RichTextHandle>(null);
  const panel = useRef<HTMLDivElement>(null);
  const savedRange = useRef<SelectionBookmark | null>(null);
  const [formats, setFormats] = useState<Record<string, boolean>>({});

  // The page behind cannot be reached while this is open, and the focus returns to the button that opened it.
  useModalPage();
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('[role="textbox"], textarea')?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (viewport === null) return;
    const root = document.documentElement;
    const follow = () => {
      root.style.setProperty("--visible-height", `${viewport.height}px`);
      root.style.setProperty("--visible-top", `${viewport.offsetTop}px`);
    };
    follow();
    viewport.addEventListener("resize", follow);
    viewport.addEventListener("scroll", follow);
    return () => {
      viewport.removeEventListener("resize", follow);
      viewport.removeEventListener("scroll", follow);
      root.style.removeProperty("--visible-height");
      root.style.removeProperty("--visible-top");
    };
  }, []);

  function startLink() {
    savedRange.current = editor.current?.bookmark() ?? null;
    setHref("");
    setLinking(true);
  }

  function finishLink() {
    if (safeHref(href) === null) return;
    editor.current?.restore(savedRange.current);
    editor.current?.command({ kind: "link" }, href);
    setLinking(false);
  }

  const dialog = (
    <div className="u-focus" onMouseDown={onClose} role="presentation">
      <div
        ref={panel}
        className="u-focus-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="u-focus-head">
          <span className="u-focus-title">{title}</span>
          <span className="u-focus-hint">{hint}</span>
          <WriteModeSwitch mode={mode} onMode={setMode} />
          <button className="u-ico" onClick={onClose} aria-label="Done" data-tip="Done">
            <Icon
              size={15}
              weight={2}
              path="M9 9L4 4M9 9V4M9 9H4M15 9l5-5M15 9V4M15 9h5M9 15l-5 5M9 15v5M9 15H4M15 15l5 5M15 15v5M15 15h5"
            />
          </button>
        </div>

        {mode === "rich" && (
          <div className="u-tools" role="toolbar" aria-label="Formatting">
            {TOOLS.map((group, index) => (
              <ToolGroup
                key={index}
                tools={group}
                formats={formats}
                onRun={(command) => editor.current?.command(command)}
              />
            ))}
            {formats.table && (
              <ToolGroup tools={TABLE_TOOLS} formats={formats} onRun={(command) => editor.current?.command(command)} />
            )}
            <div className="u-tool-group">
              <button
                className="u-tbtn"
                onMouseDown={(event) => event.preventDefault()}
                onClick={startLink}
                data-tip="Link"
                aria-label="Link"
              >
                <Icon
                  size={15}
                  path="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.5 1.5M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7L12 19"
                />
              </button>
            </div>

            <span className="u-spacer" />
            <button
              className="u-btn ghost sm"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => editor.current?.replaceMarkdown(tidyIntoBullets(value))}
              disabled={!canTidy(value)}
              title="Put each sentence on its own line. Your words are not changed."
            >
              <Icon size={14} path="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
              Tidy up
            </button>
          </div>
        )}

        {linking && (
          <form
            className="u-focus-link"
            onSubmit={(event) => {
              event.preventDefault();
              finishLink();
            }}
          >
            <input
              className="u-input"
              autoFocus
              value={href}
              placeholder="https://…"
              onChange={(event) => setHref(event.target.value)}
            />
            <button className="u-btn primary" type="submit" disabled={safeHref(href) === null}>
              Link it
            </button>
            <button
              className="u-btn ghost"
              type="button"
              onClick={() => {
                setLinking(false);
                editor.current?.restore(savedRange.current);
              }}
            >
              Cancel
            </button>
          </form>
        )}

        <div className="u-focus-scroll">
          <RichText
            ref={editor}
            hidden={mode !== "rich"}
            onFormats={setFormats}
            value={value}
            placeholder={placeholder}
            className="u-focus-body"
            docKey={title}
            ariaLabel={title}
            onChange={onChange}
          />
          {mode === "raw" && (
            <textarea
              className="u-focus-body u-focus-raw"
              value={value}
              placeholder={placeholder}
              aria-label={`${title} as Markdown`}
              spellCheck={false}
              onChange={(event) => onChange(event.target.value)}
            />
          )}
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
