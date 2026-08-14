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

type PathSegment = string | number;

interface Row {
  line: number;
  indent: number;
  dash: number;
  text: string;
}

const DASH = /^-(?:\s+|$)/;
const KEY = /^(?:"([^"]*)"\s*|'([^']*)'\s*|([^\s:#"'][^:#]*)):(?:\s|$)/;
export const MAX_SETTINGS_LINES = 2000;
export const SETTINGS_TOO_LONG = `The settings block at the top of the file is longer than ${MAX_SETTINGS_LINES.toLocaleString("en-US")} lines, so it was not read.`;

function rowsOf(lines: string[], from: number, to: number): Row[] {
  const rows: Row[] = [];
  for (let i = from; i < to; i += 1) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    let text = raw.slice(indent);
    let dash = 0;
    for (let found = DASH.exec(text); found !== null; found = DASH.exec(text)) {
      dash += found[0].length;
      text = text.slice(found[0].length);
    }
    rows.push({ line: i + 1, indent, dash, text: text.trimEnd() });
  }
  return rows;
}

function keyOf(text: string): string | null {
  const found = KEY.exec(text);
  return found === null ? null : (found[1] ?? found[2] ?? found[3]?.trimEnd() ?? null);
}

function keyIndentOf(block: Row[]): number {
  const first = block[0]!;
  if (first.dash > 0 && first.text === "") return block[1]?.indent ?? first.indent + first.dash;
  return first.indent + first.dash;
}

function valueBlock(block: Row[], at: number, keyIndent: number): Row[] {
  const inner: Row[] = [];
  for (let i = at + 1; i < block.length; i += 1) {
    const row = block[i]!;
    if (row.indent > keyIndent || (row.indent === keyIndent && row.dash > 0)) inner.push(row);
    else break;
  }
  return inner;
}

function step(block: Row[], segment: PathSegment): { row: Row; inner: Row[] } | null {
  if (block.length === 0) return null;

  if (typeof segment === "number") {
    const first = block[0]!;
    if (first.dash === 0) return null;
    const items = block.flatMap((row, at) => (row.dash > 0 && row.indent === first.indent ? [{ row, at }] : []));
    const item = items[segment];
    if (item === undefined) return null;
    const next = items[segment + 1];
    return { row: item.row, inner: block.slice(item.at, next?.at) };
  }

  const keyIndent = keyIndentOf(block);
  for (let at = 0; at < block.length; at += 1) {
    const row = block[at]!;
    if (row.indent + row.dash !== keyIndent) continue;
    if (row.dash > 0 && at !== 0) continue;
    if (keyOf(row.text) !== segment) continue;
    return { row, inner: valueBlock(block, at, keyIndent) };
  }
  return null;
}

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
  return rowsOf(block.lines, block.open + 1, block.close).map(({ line, text }) => ({ line, text }));
}

export function lineOfPath(content: string, path: readonly PathSegment[]): number | null {
  if (path.length === 0) return null;
  const found = settingsBlock(content);
  if (found === null) return null;

  let block = rowsOf(found.lines, found.open + 1, found.close);
  let line = found.open + 1;
  for (const segment of path) {
    const hit = step(block, segment);
    if (hit === null) break;
    line = hit.row.line;
    block = hit.inner;
  }
  return line;
}
