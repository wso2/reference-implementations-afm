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
import { highlightAfm } from "./afm-highlight";
import type { Token, TokenKind } from "./afm-highlight";

function kindOf(tokens: Token[], text: string): TokenKind | undefined {
  return tokens.find((token) => token.text === text)?.kind;
}

const SAMPLE = `---
name: "Paper Navigator"
max_iterations: 12
model:
  provider: openai
  authentication:
    api_key: \${env:OPENAI_API_KEY}
tools:
  mcp:
    - name: deepwiki
      transport:
        url: https://mcp.deepwiki.com/mcp   # no auth needed
---

# Role

You are **Paper Navigator**, a research assistant.

- Call \`list_files\` first.
- See [the spec](https://example.com/spec).
`;

describe("highlightAfm", () => {
  it("never loses or duplicates a character", () => {
    expect(
      highlightAfm(SAMPLE)
        .map((token) => token.text)
        .join(""),
    ).toBe(SAMPLE);
  });

  it("marks both frontmatter fences as delimiters and nothing else", () => {
    const tokens = highlightAfm(SAMPLE);
    expect(tokens.filter((token) => token.kind === "delimiter")).toHaveLength(2);
  });

  it("reads the frontmatter when blank lines come before the opening fence", () => {
    const source = `\n\n${SAMPLE}`;
    const tokens = highlightAfm(source);
    expect(tokens.map((token) => token.text).join("")).toBe(source);
    expect(tokens.filter((token) => token.kind === "delimiter")).toHaveLength(2);
    expect(kindOf(tokens, "max_iterations")).toBe("root-key");
  });

  it("separates the agent's own top-level fields from nested detail", () => {
    const tokens = highlightAfm(SAMPLE);
    expect(kindOf(tokens, "max_iterations")).toBe("root-key");
    expect(kindOf(tokens, "model")).toBe("root-key");
    expect(kindOf(tokens, "  provider")).toBe("key");
    expect(kindOf(tokens, "    api_key")).toBe("key");
    expect(kindOf(tokens, "name")).toBe("root-key");
    const dash = tokens.findIndex((token) => token.kind === "punct" && token.text === "    - ");
    expect(dash).toBeGreaterThan(-1);
    expect(tokens[dash + 1]).toEqual({ kind: "key", text: "name" });
  });

  it("picks out URLs in values", () => {
    const tokens = highlightAfm(SAMPLE);
    expect(kindOf(tokens, "https://mcp.deepwiki.com/mcp")).toBe("url");
  });

  it("reads single asterisks as italic without breaking bold", () => {
    const tokens = highlightAfm("# Role\n\nUse *care* and **precision**.\n");
    expect(kindOf(tokens, "*care*")).toBe("italic");
    expect(kindOf(tokens, "**precision**")).toBe("emphasis");
    expect(tokens.filter((token) => token.kind === "italic")).toHaveLength(1);
  });

  it("leaves snake_case identifiers alone rather than reading them as italic", () => {
    const tokens = highlightAfm("# Role\n\nCall read_file then search_files.\n");
    expect(tokens.some((token) => token.kind === "italic")).toBe(false);
  });

  it("reads a URL as a value, not as a key, and keeps its # fragment out of comments", () => {
    const tokens = highlightAfm("---\nurl: https://mcp.deepwiki.com/mcp#frag\n---\n");
    expect(kindOf(tokens, "https")).toBeUndefined();
    expect(tokens.some((token) => token.kind === "comment")).toBe(false);
  });

  it("still treats a real trailing comment as a comment", () => {
    const tokens = highlightAfm(SAMPLE);
    expect(tokens.some((token) => token.kind === "comment" && token.text.includes("no auth needed"))).toBe(true);
  });

  it("picks out ${env:...} references, including inside a quoted value", () => {
    expect(kindOf(highlightAfm(SAMPLE), "${env:OPENAI_API_KEY}")).toBe("variable");
    const quoted = highlightAfm('---\napi_key: "${env:HF_TOKEN}"\n---\n');
    expect(kindOf(quoted, "${env:HF_TOKEN}")).toBe("variable");
    expect(kindOf(quoted, '"')).toBe("string");
  });

  it("classifies scalar value types", () => {
    const tokens = highlightAfm('---\nname: "x"\ncount: 12\nenabled: true\n---\n');
    expect(kindOf(tokens, '"x"')).toBe("string");
    expect(kindOf(tokens, "12")).toBe("number");
    expect(kindOf(tokens, "true")).toBe("literal");
  });

  it("switches to Markdown rules after the closing fence", () => {
    const tokens = highlightAfm(SAMPLE);
    expect(kindOf(tokens, "# Role")).toBe("heading");
    expect(kindOf(tokens, "**Paper Navigator**")).toBe("emphasis");
    expect(kindOf(tokens, "`list_files`")).toBe("code");
    expect(kindOf(tokens, "[the spec](https://example.com/spec)")).toBe("link");
    expect(kindOf(tokens, "-")).toBe("marker");
  });

  it("does not treat a body heading as YAML, or a body line as a comment", () => {
    const tokens = highlightAfm(SAMPLE);
    expect(tokens.some((token) => token.kind === "key")).toBe(true);
    const headings = tokens.filter((token) => token.kind === "heading");
    expect(headings.map((token) => token.text)).toEqual(["# Role"]);
  });

  it("holds a fenced code block until it closes", () => {
    const tokens = highlightAfm("# Role\n\n```yaml\nname: not-a-key\n```\n\ndone\n");
    expect(kindOf(tokens, "name: not-a-key")).toBe("code");
    expect(kindOf(tokens, "done")).toBe("plain");
  });

  it("handles a file with no frontmatter at all", () => {
    const tokens = highlightAfm("# Role\n\nJust prose.\n");
    expect(tokens.some((token) => token.kind === "delimiter")).toBe(false);
    expect(kindOf(tokens, "# Role")).toBe("heading");
  });

  it("handles empty and whitespace-only input without throwing", () => {
    expect(highlightAfm("")).toEqual([]);
    expect(
      highlightAfm("\n\n\n")
        .map((token) => token.text)
        .join(""),
    ).toBe("\n\n\n");
  });
});
