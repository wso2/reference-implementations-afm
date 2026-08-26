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

export type TokenKind =
  | "plain"
  | "delimiter"
  | "root-key"
  | "key"
  | "punct"
  | "string"
  | "number"
  | "literal"
  | "comment"
  | "variable"
  | "url"
  | "heading"
  | "emphasis"
  | "italic"
  | "code"
  | "link"
  | "marker";

export interface Token {
  kind: TokenKind;
  text: string;
}

const FENCE = /^---[ \t]*$/;
const CODE_FENCE = /^[ \t]*(?:```|~~~)/;
const VARIABLE = /\$\{[^}\n]*\}/g;

const YAML = new RegExp(
  [
    "(?<comment>(?:^|[ \\t])#.*)",
    "(?<variable>\\$\\{[^}\\n]*\\})",
    "(?<key>^[ \\t]*(?:-[ \\t]+)?[A-Za-z_][A-Za-z0-9_.\\-]*(?=[ \\t]*:(?:[ \\t]|$)))",
    "(?<url>https?://\\S+)",
    "(?<string>\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\n]|'')*')",
    "(?<literal>\\b(?:true|false|null|yes|no)\\b)",
    "(?<number>\\b\\d[\\d.]*\\b)",
    "(?<punct>^[ \\t]*-(?=[ \\t]|$)|:)",
  ].join("|"),
  "g",
);

const MARKDOWN = new RegExp(
  [
    "(?<heading>^#{1,6}[ \\t].*)",
    "(?<marker>^[ \\t]*(?:[-*+]|\\d+\\.)(?=[ \\t]))",
    "(?<variable>\\$\\{[^}\\n]*\\})",
    "(?<code>`[^`\\n]+`)",
    "(?<emphasis>\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__)",
    "(?<link>\\[[^\\]\\n]*\\]\\([^)\\n]*\\))",
    "(?<italic>\\*[^*\\n]+\\*|(?<![A-Za-z0-9_])_[^_\\n]+_(?![A-Za-z0-9_]))",
    "(?<url>https?://\\S+)",
  ].join("|"),
  "g",
);

const KEY_DASH = /^([ \t]*-[ \t]+)(.*)$/;

function pushText(tokens: Token[], kind: TokenKind, text: string): void {
  if (text === "") return;
  if (kind === "key") {
    const nested = /^[ \t]/.test(text);
    const named: TokenKind = nested ? "key" : "root-key";
    const dash = KEY_DASH.exec(text);
    if (dash !== null) {
      tokens.push({ kind: "punct", text: dash[1] ?? "" });
      tokens.push({ kind: named, text: dash[2] ?? "" });
      return;
    }
    tokens.push({ kind: named, text });
    return;
  }
  if (kind !== "string") {
    tokens.push({ kind, text });
    return;
  }
  VARIABLE.lastIndex = 0;
  let index = 0;
  for (let match = VARIABLE.exec(text); match !== null; match = VARIABLE.exec(text)) {
    if (match.index > index) tokens.push({ kind, text: text.slice(index, match.index) });
    tokens.push({ kind: "variable", text: match[0] });
    index = match.index + match[0].length;
  }
  if (index < text.length) tokens.push({ kind, text: text.slice(index) });
}

function matchedKind(groups: Record<string, string | undefined>): TokenKind {
  for (const [name, value] of Object.entries(groups)) {
    if (value !== undefined) return name as TokenKind;
  }
  return "plain";
}

function scanLine(line: string, pattern: RegExp, tokens: Token[]): void {
  pattern.lastIndex = 0;
  let index = 0;
  for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
    if (match[0] === "") {
      pattern.lastIndex += 1;
      continue;
    }
    if (match.index > index) tokens.push({ kind: "plain", text: line.slice(index, match.index) });
    pushText(tokens, matchedKind(match.groups ?? {}), match[0]);
    index = match.index + match[0].length;
  }
  if (index < line.length) tokens.push({ kind: "plain", text: line.slice(index) });
}

export function highlightAfm(source: string): Token[] {
  const lines = source.split("\n");
  const tokens: Token[] = [];
  const opening = lines.findIndex((line) => line.trim() !== "");
  let inFrontmatter = opening !== -1 && FENCE.test(lines[opening] ?? "");
  let inCodeFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (i > 0) tokens.push({ kind: "plain", text: "\n" });

    if (inFrontmatter) {
      if (i === opening || FENCE.test(line)) {
        if (i !== opening) inFrontmatter = false;
        tokens.push({ kind: "delimiter", text: line });
        continue;
      }
      scanLine(line, YAML, tokens);
      continue;
    }

    if (CODE_FENCE.test(line)) {
      inCodeFence = !inCodeFence;
      tokens.push({ kind: "code", text: line });
      continue;
    }
    if (inCodeFence) {
      pushText(tokens, "code", line);
      continue;
    }
    scanLine(line, MARKDOWN, tokens);
  }

  return tokens;
}
