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

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { jumpWithin, Markdown } from "./Markdown";

const shown = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

// A stand-in for the page: this suite runs without a browser, so it records what a jump does to an element.
function target(id: string, tabIndex: number, withTabindex = false) {
  const calls: string[] = [];
  const element = {
    id,
    tabIndex,
    hasAttribute: (name: string) => name === "tabindex" && withTabindex,
    setAttribute: (name: string, value: string) => calls.push(`set ${name}=${value}`),
    scrollIntoView: () => calls.push("scroll"),
    focus: (options: unknown) => calls.push(`focus ${JSON.stringify(options)}`),
  };
  return { element, calls };
}
const insideReply = (elements: unknown[]) =>
  ({ closest: () => ({ querySelectorAll: () => elements }) }) as unknown as Element;

describe("a model reply is shown without giving anything away", () => {
  it("never loads a picture a reply points at, and names the host instead", () => {
    const html = shown("![look](https://tracker.example/pixel.png?conversation=secret)");
    expect(html).not.toContain("<img");
    expect(html).toContain("md-img-blocked");
    expect(html).toContain("tracker.example");
  });

  it("blocks a picture written as a reference as well", () => {
    const html = shown("![x][ref]\n\n[ref]: https://tracker.example/p.png?d=secret");
    expect(html).not.toContain("<img");
    expect(html).toContain("md-img-blocked");
  });

  it("keeps raw HTML in a reply as text, so none of it becomes part of the page", () => {
    for (const raw of [
      '<img src="https://tracker.example/p.png" onerror="alert(1)">',
      "<script>alert(1)</script>",
      '<iframe src="https://evil.example"></iframe>',
      '<a href="javascript:alert(1)" onclick="x()">hi</a>',
    ]) {
      const html = shown(raw);
      expect(html).not.toMatch(/<(img|script|iframe)\b/);
      expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
    }
  });

  it("drops a link that would run code, and keeps a real one", () => {
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html;base64,PHM+", "vbscript:x"]) {
      expect(shown(`[click](${bad})`)).not.toMatch(/href="\s*(javascript|data|vbscript):/i);
    }
    expect(shown("[ok](https://example.com/a)")).toContain('href="https://example.com/a"');
  });

  it("opens a link in a new tab without telling the other site where it came from", () => {
    const html = shown("[ok](https://example.com/a)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("still shows ordinary writing, code and tables", () => {
    const html = shown("# Title\n\nSome **text**.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n");
    expect(html).toContain("Title");
    expect(html).toContain("<strong>text</strong>");
    expect(html).toContain("<table>");
    expect(html.replace(/<[^>]+>/g, "")).toContain("const x = 1;");
  });
});

describe("a reply that is still being written", () => {
  // The renderer is given the same parts on every render. A new function each time would be a new
  // component type for React, so every link and code block would be built again for each word.
  const partsOf = (text: string) => {
    const wrapper = Markdown({ text }) as ReactElement<{ children: ReactElement<Record<string, unknown>> }>;
    return wrapper.props.children.props;
  };

  it("hands the renderer the same plugins and components for every word", () => {
    const first = partsOf("Hello [link](https://example.com)");
    const next = partsOf("Hello [link](https://example.com) and more");
    expect(next.components).toBe(first.components);
    expect(next.remarkPlugins).toBe(first.remarkPlugins);
    expect(next.rehypePlugins).toBe(first.rehypePlugins);
  });

  it("still handles links, code blocks and pictures through those parts", () => {
    const components = partsOf("x").components as Record<string, unknown>;
    expect(Object.keys(components).sort()).toEqual(["a", "img", "pre"]);
  });
});

describe("footnotes and links in a reply", () => {
  const note = "A note[^1] and more.\n\n[^1]: The note.";

  it("keeps the anchors of a footnote, and its way back", () => {
    const html = shown(note);
    expect(html).toContain('id="user-content-fnref-1"');
    expect(html).toContain('id="user-content-fn-1"');
    expect(html).toContain("data-footnote-ref");
    expect(html).toContain("data-footnote-backref");
    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).toContain('href="#user-content-fnref-1"');
  });

  it("keeps a footnote link in the page and opens no new tab for it", () => {
    const link = /<a [^>]*data-footnote-ref[^>]*>/.exec(shown(note))![0];
    expect(link).not.toContain("target=");
    expect(link).not.toContain("_blank");
  });

  it("still opens an ordinary link in a new tab, without access to the app", () => {
    const html = shown("see [docs](https://example.com/a)");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("moves the keyboard to the footnote, so the next Tab continues from there", () => {
    const note = target("user-content-fn-1", -1);
    jumpWithin(insideReply([note.element]), "user-content-fn-1");
    expect(note.calls).toEqual(["scroll", "set tabindex=-1", 'focus {"preventScroll":true}']);
  });

  it("moves the keyboard back to the reference on the way back, without a tab stop it did not need", () => {
    const reference = target("user-content-fnref-1", 0);
    jumpWithin(insideReply([reference.element]), "user-content-fnref-1");
    expect(reference.calls).toEqual(["scroll", 'focus {"preventScroll":true}']);
  });

  it("does not change a target that is already focusable by script", () => {
    const note = target("user-content-fn-2", -1, true);
    jumpWithin(insideReply([note.element]), "user-content-fn-2");
    expect(note.calls).toEqual(["scroll", 'focus {"preventScroll":true}']);
  });

  it("goes to the target with that id and leaves the others alone", () => {
    const other = target("user-content-fn-1", -1);
    const wanted = target("user-content-fn-2", -1);
    jumpWithin(insideReply([other.element, wanted.element]), "user-content-fn-2");
    expect(other.calls).toEqual([]);
    expect(wanted.calls).toContain("scroll");
  });

  it("does nothing when the target is not in the reply", () => {
    const other = target("elsewhere", -1);
    expect(() => jumpWithin(insideReply([other.element]), "user-content-fn-9")).not.toThrow();
    expect(other.calls).toEqual([]);
    expect(() => jumpWithin({ closest: () => null } as unknown as Element, "x")).not.toThrow();
  });

  it("does not hand the renderer's own node to the page", () => {
    expect(shown(note)).not.toContain("[object Object]");
    expect(shown("[a](https://example.com)")).not.toContain("node=");
  });
});
