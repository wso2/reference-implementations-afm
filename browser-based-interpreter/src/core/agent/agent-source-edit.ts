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
import { type Document, isMap, isScalar, isSeq, parseDocument, Scalar, type YAMLMap } from "yaml";

const OPENING_FENCE = /^\uFEFF?(?:[ \t]*\r?\n)*---[ \t]*\r?\n/;

const toLf = (text: string): string => text.replace(/\r\n/g, "\n");

interface Parts {
  head: string;
  yaml: string;
  tail: string;
}

function split(content: string): Parts | null {
  const closing = frontmatterEndOffset(content);
  const opening = OPENING_FENCE.exec(content);
  if (closing === 0 || opening === null) return null;
  return { head: opening[0], yaml: toLf(content.slice(opening[0].length, closing)), tail: content.slice(closing) };
}

function readSettings(content: string): Document | null {
  const parts = split(content);
  const doc = parts === null ? null : parseDocument(parts.yaml);
  return doc === null || doc.errors.length > 0 ? null : doc;
}

type BlockScalar = { value: unknown; start: number; end: number };

function blockScalars(text: string): Map<string, BlockScalar> {
  const found = new Map<string, BlockScalar>();
  function walk(node: unknown, path: (string | number)[]): void {
    if (isScalar(node) && (node.type === Scalar.BLOCK_FOLDED || node.type === Scalar.BLOCK_LITERAL) && node.range) {
      found.set(JSON.stringify(path), { value: node.value, start: node.range[0], end: node.range[2] });
    } else if (isMap(node)) {
      for (const pair of node.items) walk(pair.value, [...path, String(isScalar(pair.key) ? pair.key.value : "")]);
    } else if (isSeq(node)) {
      node.items.forEach((item, at) => walk(item, [...path, at]));
    }
  }
  walk(parseDocument(text).contents, []);
  return found;
}

function sameData(a: string, b: string): boolean {
  try {
    return JSON.stringify(parseDocument(a).toJS()) === JSON.stringify(parseDocument(b).toJS());
  } catch {
    return false;
  }
}

function keepBlockScalars(before: string, after: string): string {
  const original = blockScalars(before);
  let result = after;
  for (const [path, now] of [...blockScalars(after)].sort((a, b) => b[1].start - a[1].start)) {
    const old = original.get(path);
    if (old === undefined || old.value !== now.value) continue;
    const restored = result.slice(0, now.start) + before.slice(old.start, old.end) + result.slice(now.end);
    if (sameData(restored, result)) result = restored;
  }
  return result;
}

function edit(content: string, change: (doc: Document) => boolean | void): string {
  const lineBreak = content.includes("\r\n") ? "\r\n" : "\n";
  const parts = split(content) ?? { head: `---${lineBreak}`, yaml: "", tail: `---${lineBreak}${content.replace(/^(\r?\n)+/, "")}` };
  const doc = parseDocument(parts.yaml);
  if (doc.errors.length > 0 || change(doc) === false) return content;
  const indent = /^( +)\S/m.exec(parts.yaml)?.[1]?.length ?? 2;
  const indentSeq = !/^( *)[^\s#-][^\n]*:[ \t]*\n\1- /m.test(parts.yaml);
  const empty = doc.contents === null || (isMap(doc.contents) && doc.contents.items.length === 0);
  const printed = doc.toString({ lineWidth: 0, indent, indentSeq, flowCollectionPadding: false, nullStr: "" });
  const settings = empty ? "" : keepBlockScalars(parts.yaml, printed);
  return parts.head + settings.replace(/\n/g, lineBreak) + parts.tail;
}

function textOf(value: unknown): string {
  return value === null || value === undefined || typeof value === "object" ? "" : String(value);
}

function quotedIfMultiline(value: string): Scalar {
  const node = new Scalar(value);
  if (value.includes("\n")) node.type = Scalar.QUOTE_DOUBLE;
  return node;
}

function putFirst(doc: Document, key: string, value: unknown, map: unknown = doc.contents): void {
  if (isMap(map) && !map.has(key)) map.items.unshift(doc.createPair(key, value));
  else if (isMap(map)) map.set(key, value);
  else doc.set(key, value);
}

export function agentBrief(content: string): string {
  const parts = split(content);
  return (parts === null ? content : parts.tail.replace(/^[^\n]*/, "")).trim();
}

export function getFrontmatterScalar(content: string, key: string): string {
  return textOf(readSettings(content)?.get(key));
}

export function setFrontmatterValue(content: string, key: string, value: string | string[] | Record<string, string>): string {
  const next = typeof value === "string" || Array.isArray(value) ? value : Object.fromEntries(Object.entries(value).filter(([, item]) => item !== ""));
  const empty = next === "" || (typeof next === "object" && Object.keys(next).length === 0);
  return edit(content, (doc) => {
    if (!empty) putFirst(doc, key, doc.createNode(typeof next === "string" ? quotedIfMultiline(next) : next));
    else if (isMap(doc.contents)) doc.delete(key);
  });
}

type ModelField = "provider" | "name";

export function getModelField(content: string, field: ModelField): string {
  return textOf(readSettings(content)?.getIn(["model", field]));
}

export function setModelField(content: string, field: ModelField, value: string): string {
  return edit(content, (doc) => {
    const model = doc.get("model", true);
    if (model === undefined) putFirst(doc, "model", doc.createNode({ [field]: quotedIfMultiline(value) }));
    else if (isMap(model)) putFirst(doc, field, quotedIfMultiline(value), model);
    else return false;
  });
}

const API_KEY = ["model", "authentication", "api_key"];

export function getModelApiKey(content: string): string {
  return textOf(readSettings(content)?.getIn(API_KEY));
}

export function setModelApiKey(content: string, value: string): string {
  return edit(content, (doc) => {
    const model = doc.get("model", true);
    if (isScalar(model) && model.value === null) doc.set("model", doc.createNode({}));
    else if (!isMap(model)) return false;
    const key = doc.getIn(API_KEY, true);
    if (isScalar(key)) {
      key.value = value === "" ? null : value;
      return;
    }
    if (!isMap(doc.getIn(["model", "authentication"], true))) doc.setIn(["model", "authentication"], doc.createNode({ type: "api-key" }));
    const reference = new Scalar(value === "" ? null : value);
    reference.type = Scalar.PLAIN;
    doc.setIn(API_KEY, reference);
  });
}

function sectionBounds(content: string, heading: string): { start: number | null; end: number; fence: string | null } {
  const parts = split(content);
  const bodyStart = parts === null ? 0 : Math.min(content.length, content.indexOf("\n", content.length - parts.tail.length) + 1 || content.length);
  let offset = 0;
  let start: number | null = null;
  let fence: string | null = null;
  for (const line of content.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (lineStart < bodyStart) continue;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      continue;
    }
    const found = fence === null ? /^ {0,3}#\s+(\S.*)$/.exec(line) : null;
    if (found === null) continue;
    if (start !== null) return { start, end: lineStart, fence };
    if (found[1]?.trimEnd().toLowerCase() === heading.toLowerCase()) start = lineStart + line.length;
  }
  return { start, end: content.length, fence };
}

export function getSection(content: string, heading: string): string {
  const text = toLf(content);
  const { start, end } = sectionBounds(text, heading);
  return start === null ? "" : text.slice(start, end).replace(/^\n+/, "").replace(/\n+$/, "");
}

export function setSection(content: string, heading: string, body: string): string {
  const text = toLf(content);
  const { start, end, fence } = sectionBounds(text, heading);
  const closing = fence === null ? "" : `\n${fence}`;
  const next =
    start === null
      ? `${text.replace(/\n+$/, "")}${closing}\n\n# ${heading}\n\n${toLf(body)}\n`
      : `${text.slice(0, start)}\n${toLf(body)}\n\n${text.slice(end)}`;
  return content.includes("\r\n") ? next.replace(/\n/g, "\r\n") : next;
}

function serverNamed(doc: Document, name: string): YAMLMap | undefined {
  const servers = doc.getIn(["tools", "mcp"]);
  return isSeq(servers) ? (servers.items.find((item) => isMap(item) && item.get("name") === name) as YAMLMap | undefined) : undefined;
}

export function setServerToolFilter(content: string, serverName: string, allow: string[] | null, deny: string[] = []): string {
  return edit(content, (doc) => {
    const server = serverNamed(doc, serverName);
    if (server === undefined) return false;
    if (allow === null) {
      server.delete("tool_filter");
      return;
    }
    const filter = doc.createNode(deny.length === 0 ? { allow } : { allow, deny });
    if (server.has("tool_filter")) server.set("tool_filter", filter);
    else server.items.splice(1, 0, doc.createPair("tool_filter", filter));
  });
}

export interface NewMcpServer {
  name: string;
  url: string;
  auth?: { type: string; fields: Record<string, string>; scopes?: string[] };
}

export function addMcpServer(content: string, { name, url, auth }: NewMcpServer): string {
  const fields = Object.entries(auth?.fields ?? {}).filter(([, value]) => value.trim() !== "");
  const authentication = auth === undefined ? {} : { authentication: { type: auth.type, ...Object.fromEntries(fields), ...(auth.scopes?.length ? { scopes: auth.scopes } : {}) } };
  return edit(content, (doc) => {
    const server = doc.createNode({ name, transport: { type: "http", url, ...authentication } });
    const servers = doc.getIn(["tools", "mcp"]);
    if (isSeq(servers)) servers.items.push(server);
    else doc.setIn(["tools", "mcp"], doc.createNode([server]));
  });
}

export function removeMcpServer(content: string, serverName: string): string {
  return edit(content, (doc) => {
    const servers = doc.getIn(["tools", "mcp"]);
    const at = isSeq(servers) ? servers.items.findIndex((item) => isMap(item) && item.get("name") === serverName) : -1;
    if (!isSeq(servers) || at === -1) return false;
    servers.items.splice(at, 1);
    if (servers.items.length === 0) doc.deleteIn(["tools", "mcp"]);
    const tools = doc.get("tools");
    if (isMap(tools) && tools.items.length === 0) doc.delete("tools");
  });
}
