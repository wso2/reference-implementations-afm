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

import { isMap, isNode, isScalar, isSeq, LineCounter, type Node, parseDocument } from "yaml";

type PathSegment = string | number;

const LEADING_DASHES = /^(?:-(?:\s+|$))+/;
export const MAX_SETTINGS_LINES = 2000;
export const SETTINGS_TOO_LONG = `The settings block at the top of the file is longer than ${MAX_SETTINGS_LINES.toLocaleString("en-US")} lines, so it was not read.`;

export function pathFromText(text: string | undefined): PathSegment[] {
  const parts = text?.match(/[^.[\]]+|\[\d+\]/g) ?? [];
  return parts.map((part) => (part.startsWith("[") ? Number(part.slice(1, -1)) : part));
}

function settingsSpan(content: string): { lines: string[]; open: number; close: number | null } | null {
  const lines = content.split("\n");
  const open = lines.findIndex((line) => line.trim() !== "");
  if (open === -1 || lines[open]!.trimEnd() !== "---") return null;
  const close = lines.findIndex((line, at) => at > open && line.trimEnd() === "---");
  return { lines, open, close: close === -1 ? null : close };
}

function settingsBlock(content: string): { lines: string[]; open: number; close: number } | null {
  const span = settingsSpan(content);
  return span === null || span.close === null ? null : { ...span, close: span.close };
}

export function settingsTooLong(content: string): boolean {
  const span = settingsSpan(content);
  return span !== null && (span.close ?? span.lines.length) - span.open - 1 > MAX_SETTINGS_LINES;
}

export function settingsRows(content: string): { line: number; text: string }[] {
  const block = settingsBlock(content);
  if (block === null) return [];
  const rows: { line: number; text: string }[] = [];
  for (let at = block.open + 1; at < block.close; at += 1) {
    const text = (block.lines[at] ?? "").trim();
    if (text === "" || text.startsWith("#")) continue;
    rows.push({ line: at + 1, text: text.replace(LEADING_DASHES, "") });
  }
  return rows;
}

function childOf(node: unknown, segment: PathSegment): { value: unknown; at: Node } | null {
  if (isMap(node)) {
    const pair = node.items.find(({ key }) => isScalar(key) && String(key.value) === String(segment));
    return pair !== undefined && isScalar(pair.key) ? { value: pair.value, at: pair.key } : null;
  }
  const item = isSeq(node) && typeof segment === "number" ? node.items[segment] : undefined;
  return isNode(item) ? { value: item, at: item } : null;
}

export function lineOfPath(content: string, path: readonly PathSegment[]): number | null {
  if (path.length === 0) return null;
  const found = settingsBlock(content);
  if (found === null) return null;

  const counter = new LineCounter();
  const { contents } = parseDocument(found.lines.slice(found.open + 1, found.close).join("\n"), { lineCounter: counter });
  let line = found.open + 1;
  let node: unknown = contents;
  for (const segment of path) {
    const child = childOf(node, segment);
    if (child === null || child.at.range == null) break;
    line = counter.linePos(child.at.range[0]).line + found.open + 1;
    node = child.value;
  }
  return line;
}
