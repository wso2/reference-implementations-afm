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

import { frontmatterEndOffset } from "@afm/engine";

function frontmatterEnd(content: string): number | null {
  const closing = frontmatterEndOffset(content);
  if (closing === 0) return null;
  const closingBreak = content.indexOf("\n", closing);
  return closingBreak === -1 ? content.length : closingBreak;
}

function frontmatterLines(content: string): string[] | null {
  const end = frontmatterEnd(content);
  return end === null ? null : content.slice(0, end).split(/\r?\n/);
}

function editFrontmatter(content: string, edit: (lines: string[]) => string[] | null): string {
  const end = frontmatterEnd(content);
  if (end === null) {
    const lines = edit(["---", "---"]);
    return lines === null ? content : `${lines.join("\n")}\n${content.replace(/^\n+/, "")}`;
  }
  const lines = edit(content.slice(0, end).split(/\r?\n/));
  const lineBreak = content.includes("\r\n") ? "\r\n" : "\n";
  return lines === null ? content : lines.join(lineBreak) + content.slice(end);
}

interface Span {
  start: number;
  end: number;
}

function indentOf(line: string | undefined, fallback = ""): string {
  return line?.match(/^[ \t]*/)?.[0] ?? fallback;
}

function keyIndent(lines: string[], block: Span, fallback: string): string {
  return indentOf(
    lines.slice(block.start + 1, block.end).find((line) => line.trim() !== ""),
    fallback,
  );
}

function blockEnd(lines: string[], from: number, parentIndent: number, limit = lines.length): number {
  let end = from;
  while (end < limit && (lines[end]?.trim() === "" || indentOf(lines[end]).length > parentIndent)) end += 1;
  return end;
}

function valueOf(line: string): string {
  return line.slice(line.indexOf(":") + 1).trim();
}

function withValue(line: string, value: string): string {
  return `${line.slice(0, line.indexOf(":"))}: ${value}`;
}

export function agentBrief(content: string): string {
  const end = frontmatterEnd(content);
  return (end === null ? content : content.slice(end)).trim();
}

function unquoteScalar(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw;
    }
  }
  return raw;
}

export function getFrontmatterScalar(content: string, key: string): string {
  const end = frontmatterEnd(content);
  if (end === null) return "";
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(content.slice(0, end));
  if (match === null) return "";
  const raw = (match[1] ?? "").trim();
  return unquoteScalar(raw);
}

function keyLines(key: string, value: string | string[] | Record<string, string>): string[] {
  if (typeof value === "string") return value === "" ? [] : [`${key}: ${yamlValue(value)}`];
  const rows = Array.isArray(value)
    ? value.map((item) => `  - ${yamlValue(item)}`)
    : Object.entries(value)
        .filter(([, item]) => item !== "")
        .map(([name, item]) => `  ${name}: ${yamlValue(item)}`);
  return rows.length === 0 ? [] : [`${key}:`, ...rows];
}

export function setFrontmatterValue(
  content: string,
  key: string,
  value: string | string[] | Record<string, string>,
): string {
  return editFrontmatter(content, (lines) => {
    const next = keyLines(key, value);
    const start = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (start === -1) {
      lines.splice(lines.findIndex((line) => line.trim() === "---") + 1, 0, ...next);
      return lines;
    }
    let end = start + 1;
    while (end < lines.length && /^(\s|- |$)/.test(lines[end] ?? "")) end += 1;
    while (end > start + 1 && (lines[end - 1] ?? "").trim() === "") end -= 1;
    lines.splice(start, end - start, ...next);
    return lines;
  });
}

type ModelField = "provider" | "name";

const MODEL_LINE = /^model:[ \t]*$/;
const BLOCK_LINE = /^[ \t]/;

function modelBlock(lines: string[]): Span | null {
  const start = lines.findIndex((line) => MODEL_LINE.test(line));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || BLOCK_LINE.test(lines[end] ?? ""))) end += 1;
  return { start, end };
}

function fieldLine(lines: string[], block: Span, field: ModelField): number {
  const pattern = new RegExp(`^${keyIndent(lines, block, "  ")}${field}:`);
  for (let i = block.start + 1; i < block.end; i += 1) {
    if (pattern.test(lines[i] ?? "")) return i;
  }
  return -1;
}

export function getModelField(content: string, field: ModelField): string {
  const lines = frontmatterLines(content);
  if (lines === null) return "";
  const block = modelBlock(lines);
  if (block === null) return "";
  const index = fieldLine(lines, block, field);
  return index === -1 ? "" : unquoteScalar(valueOf(lines[index] ?? ""));
}

export function setModelField(content: string, field: ModelField, value: string): string {
  const escaped = yamlValue(value);
  return editFrontmatter(content, (lines) => {
    const block = modelBlock(lines);
    if (block === null) {
      const fenceIndex = lines.findIndex((line) => line.trim() === "---");
      lines.splice(fenceIndex + 1, 0, "model:", `  ${field}: ${escaped}`);
      return lines;
    }

    const index = fieldLine(lines, block, field);
    if (index === -1) {
      lines.splice(block.start + 1, 0, `${keyIndent(lines, block, "  ")}${field}: ${escaped}`);
      return lines;
    }

    lines[index] = withValue(lines[index] ?? "", escaped);
    return lines;
  });
}

function apiKeyLine(lines: string[], block: Span): number {
  let authIndent: string | null = null;
  for (let i = block.start + 1; i < block.end; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const indent = indentOf(line);
    if (authIndent !== null) {
      if (indent.length <= authIndent.length) return -1;
      if (/^[ \t]*api_key:/.test(line)) return i;
      continue;
    }
    if (/^[ \t]*authentication:[ \t]*$/.test(line)) authIndent = indent;
  }
  return -1;
}

export function getModelApiKey(content: string): string {
  const lines = frontmatterLines(content);
  if (lines === null) return "";
  const block = modelBlock(lines);
  if (block === null) return "";
  const index = apiKeyLine(lines, block);
  return index === -1 ? "" : unquoteScalar(valueOf(lines[index] ?? ""));
}

export function setModelApiKey(content: string, value: string): string {
  return editFrontmatter(content, (lines) => {
    const block = modelBlock(lines);
    if (block === null) return null;
    const index = apiKeyLine(lines, block);
    if (index === -1) {
      const indent = keyIndent(lines, block, "  ");
      const authAt = findAuthenticationLine(lines, block);
      if (authAt === -1) {
        lines.splice(
          block.end,
          0,
          `${indent}authentication:`,
          `${indent}  type: api-key`,
          `${indent}  api_key: ${value}`,
        );
      } else {
        lines.splice(authAt + 1, 0, `${indentOf(lines[authAt], indent)}  api_key: ${value}`);
      }
      return lines;
    }

    const line = lines[index] ?? "";
    const existing = valueOf(line);
    const quoted = existing.startsWith('"') || existing.startsWith("'");
    lines[index] = withValue(line, quoted ? JSON.stringify(value) : value);
    return lines;
  });
}

function findAuthenticationLine(lines: string[], block: Span): number {
  for (let i = block.start + 1; i < block.end; i += 1) {
    if (/^[ \t]*authentication:[ \t]*$/.test(lines[i] ?? "")) return i;
  }
  return -1;
}

interface Fence {
  marker: string;
  length: number;
}

function closesFence(fence: Fence, marker: string, line: string): boolean {
  return (
    marker[0] === fence.marker &&
    marker.length >= fence.length &&
    /^\s*$/.test(line.slice(line.indexOf(marker) + marker.length))
  );
}

function sectionBounds(content: string, heading: string): Span | null {
  const end = frontmatterEnd(content);
  const bodyStart = end === null ? 0 : end + 1;
  let offset = 0;
  let start: number | null = null;
  let fence: Fence | null = null;
  for (const line of content.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (lineStart < bodyStart) continue;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = { marker: marker[0]!, length: marker.length };
      else if (closesFence(fence, marker, line)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const found = /^ {0,3}#\s+(\S.*)$/.exec(line.replace(/\r$/, ""));
    if (found === null) continue;
    if (start !== null) return { start, end: lineStart };
    if (found[1]?.trimEnd().toLowerCase() === heading.toLowerCase()) start = lineStart + line.length;
  }
  return start === null ? null : { start, end: content.length };
}

export function getSection(content: string, heading: string): string {
  const bounds = sectionBounds(content, heading);
  if (bounds === null) return "";
  return content.slice(bounds.start, bounds.end).replace(/^\n+/, "").replace(/\n+$/, "");
}

export function setSection(content: string, heading: string, body: string): string {
  const bounds = sectionBounds(content, heading);
  if (bounds === null) {
    return `${content.replace(/\n+$/, "")}\n\n# ${heading}\n\n${body}\n`;
  }
  const before = content.slice(0, bounds.start);
  const after = content.slice(bounds.end);
  return `${before}\n${body}\n\n${after.replace(/^\n+/, "")}`;
}

function serverItemOf(line: string): { indent: string; name: string } | null {
  const head = /^([ \t]*)-[ \t]+name:[ \t]*/.exec(line);
  if (head === null) return null;
  let end = line.length;
  while (end > head[0].length && (line[end - 1] === " " || line[end - 1] === "\t")) end -= 1;
  return { indent: head[1] ?? "", name: unquoteScalar(line.slice(head[0].length, end)) };
}

function mcpServerRange(lines: string[], serverName: string): (Span & { indent: string }) | null {
  const toolsAt = lines.findIndex((line) => /^tools:[ \t]*$/.test(line));
  if (toolsAt === -1) return null;

  let start = -1;
  let itemIndent = "";
  for (let i = toolsAt + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() !== "" && !/^[ \t]/.test(line)) break;
    const item = serverItemOf(line);
    if (item === null) continue;
    if (start !== -1) {
      if (item.indent.length <= itemIndent.length) return { start, end: i, indent: itemIndent };
      continue;
    }
    if (item.name === serverName) {
      start = i;
      itemIndent = item.indent;
    }
  }
  if (start === -1) return null;
  return { start, end: blockEnd(lines, start + 1, itemIndent.length), indent: itemIndent };
}

export function setServerToolFilter(
  content: string,
  serverName: string,
  allow: string[] | null,
  deny: string[] = [],
): string {
  return editFrontmatter(content, (lines) => {
    const range = mcpServerRange(lines, serverName);
    if (range === null) return null;

    const prop = `${range.indent}  `;
    const filterPattern = new RegExp(`^${prop}tool_filter:`);
    let filterAt = -1;
    for (let i = range.start + 1; i < range.end && filterAt === -1; i += 1) {
      if (filterPattern.test(lines[i] ?? "")) filterAt = i;
    }

    const list = (key: string, names: string[]) =>
      names.length === 0
        ? [`${prop}  ${key}: []`]
        : [`${prop}  ${key}:`, ...names.map((name) => `${prop}    - ${yamlValue(name)}`)];
    const block =
      allow === null
        ? []
        : [`${prop}tool_filter:`, ...list("allow", allow), ...(deny.length === 0 ? [] : list("deny", deny))];

    return filterAt !== -1
      ? [...lines.slice(0, filterAt), ...block, ...lines.slice(blockEnd(lines, filterAt + 1, prop.length, range.end))]
      : [...lines.slice(0, range.start + 1), ...block, ...lines.slice(range.start + 1)];
  });
}

export interface NewMcpServer {
  name: string;
  url: string;
  auth?: { type: string; fields: Record<string, string>; scopes?: string[] };
}

const READ_AS_NOT_TEXT = /^(~|null|true|false|yes|no|on|off)$/i;
const READ_AS_NUMBER = /^[-+]?(\.\d+|\d+\.?\d*)([eE][-+]?\d+)?$|^0[xo][0-9a-f]+$|^[-+]?\.(inf|nan)$/i;
const STARTS_AN_INDICATOR = /^([[\]{}>|*&!%@`'",#]|[-?:](\s|$))/;
const LINE_BREAKS_AND_CONTROLS = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

function yamlValue(value: string): string {
  const plain =
    value !== "" &&
    !/^\s|\s$/.test(value) &&
    !LINE_BREAKS_AND_CONTROLS.test(value) &&
    !/:(\s|$)|\s#/.test(value) &&
    !STARTS_AN_INDICATOR.test(value) &&
    !READ_AS_NOT_TEXT.test(value) &&
    !READ_AS_NUMBER.test(value);
  return plain
    ? value
    : JSON.stringify(value)
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}

function serverLines(server: NewMcpServer, indent: string): string[] {
  const lines = [
    `${indent}- name: ${yamlValue(server.name)}`,
    `${indent}  transport:`,
    `${indent}    type: http`,
    `${indent}    url: ${yamlValue(server.url)}`,
  ];
  if (server.auth !== undefined) {
    lines.push(`${indent}    authentication:`, `${indent}      type: ${yamlValue(server.auth.type)}`);
    for (const [key, value] of Object.entries(server.auth.fields)) {
      if (value.trim() === "") continue;
      lines.push(`${indent}      ${key}: ${yamlValue(value)}`);
    }
    if (server.auth.scopes !== undefined && server.auth.scopes.length > 0) {
      lines.push(`${indent}      scopes:`);
      for (const scope of server.auth.scopes) lines.push(`${indent}        - ${yamlValue(scope)}`);
    }
  }
  return lines;
}

export function addMcpServer(content: string, server: NewMcpServer): string {
  return editFrontmatter(content, (lines) => {
    const toolsAt = lines.findIndex((line) => /^tools:[ \t]*$/.test(line));
    if (toolsAt === -1) {
      const closing = Math.max(0, lines.length - 1);
      lines.splice(closing, 0, "tools:", "  mcp:", ...serverLines(server, "    "));
      return lines;
    }

    let mcpAt = -1;
    let end = lines.length;
    for (let i = toolsAt + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.trim() !== "" && !/^[ \t]/.test(line)) {
        end = i;
        break;
      }
      if (/^[ \t]+mcp:[ \t]*$/.test(line)) mcpAt = i;
    }
    if (mcpAt === -1) {
      lines.splice(toolsAt + 1, 0, "  mcp:", ...serverLines(server, "    "));
      return lines;
    }

    const first = lines.slice(mcpAt + 1, end).find((line) => /^([ \t]*)-[ \t]+name:/.test(line));
    const indent = indentOf(first, "    ");
    let insertAt = mcpAt + 1;
    for (let i = mcpAt + 1; i < end; i += 1) {
      if ((lines[i] ?? "").trim() !== "") insertAt = i + 1;
    }
    lines.splice(insertAt, 0, ...serverLines(server, indent));
    return lines;
  });
}

export function removeMcpServer(content: string, serverName: string): string {
  return editFrontmatter(content, (lines) => {
    const range = mcpServerRange(lines, serverName);
    if (range === null) return null;
    lines.splice(range.start, range.end - range.start);
    return dropEmptyToolsKeys(lines);
  });
}

function dropEmptyToolsKeys(lines: string[]): string[] {
  const hasChild = (at: number): boolean => {
    const indent = indentOf(lines[at]).length;
    for (let i = at + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.trim() === "") continue;
      return indentOf(line).length > indent;
    }
    return false;
  };

  const mcpAt = lines.findIndex((line) => /^[ \t]+mcp:[ \t]*$/.test(line));
  if (mcpAt !== -1 && !hasChild(mcpAt)) lines.splice(mcpAt, 1);

  const toolsAt = lines.findIndex((line) => /^tools:[ \t]*$/.test(line));
  if (toolsAt !== -1 && !hasChild(toolsAt)) lines.splice(toolsAt, 1);

  return lines;
}
