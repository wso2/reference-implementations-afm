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

import { type ComponentPropsWithoutRef, useRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useCopyFeedback } from "../../ui/hooks";

function PreBlock(props: ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const { copied, copy } = useCopyFeedback();

  return (
    <div className="code-wrap">
      <button className="code-copy" onClick={() => copy(ref.current?.innerText ?? "")} title="Copy code">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={ref} {...props} />
    </div>
  );
}

function BlockedImage(props: ComponentPropsWithoutRef<"img">) {
  const src = typeof props.src === "string" ? props.src : "";
  let host = "";
  try {
    host = new URL(src, window.location.href).host;
  } catch {
    host = "";
  }
  const label = typeof props.alt === "string" && props.alt !== "" ? props.alt : "image";

  return (
    <span className="md-img-blocked" title={src}>
      <span aria-hidden="true">🚫</span>
      {label}
      {host !== "" && <span className="md-img-host">{host}</span>}
    </span>
  );
}

// A link inside the reply, such as a footnote and its way back, moves within the reply. Following it as an address would
// change the address of the page, which the app reads. Any other link opens in a new tab, without access to the app.
// Like a real jump, it also moves the keyboard focus to the target, so the next Tab continues from there.
export function jumpWithin(from: Element, id: string): void {
  const reply = from.closest(".md");
  const target = Array.from(reply?.querySelectorAll("[id]") ?? []).find((element) => element.id === id) as
    | HTMLElement
    | undefined;
  if (target === undefined) return;
  target.scrollIntoView({ block: "nearest" });
  if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
}

function SafeLink(props: ComponentPropsWithoutRef<"a"> & { node?: unknown }) {
  // The footnote attributes the reply generated (an id, a label, what describes what) are kept. The renderer's own node is not.
  const { node: _node, href, children, ...rest } = props;
  if (href !== undefined && href.startsWith("#")) {
    return (
      <a
        {...rest}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          jumpWithin(event.currentTarget, href.slice(1));
        }}
      >
        {children}
      </a>
    );
  }
  return (
    <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

// These live outside the component on purpose. A new function on every render is a new
// component type for React, so every link would be thrown away and built again with each
// streamed word.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];
const COMPONENTS = { a: SafeLink, pre: PreBlock, img: BlockedImage };

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
