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

import { z } from "zod";
import type { ToolGuard } from "./tool-guard";
import type { ToolSource } from "./toolbox";

export interface FileInfo {
  name: string;
  path: string;
  text: string;
  pages?: number;
  note?: string;
}

type AttachedFiles = Map<string, FileInfo>;

interface ReadRange {
  offset?: number;
  limit?: number;
}

const DEFAULT_PAGE_SIZE = 8000;
const SNIPPET_RADIUS = 80;
const MAX_MATCHES = 20;

function formatSize(info: FileInfo): string {
  const base = `${info.text.length.toLocaleString()} characters`;
  const sized = info.pages !== undefined ? `${base}, ${info.pages} page${info.pages === 1 ? "" : "s"}` : base;
  return info.note !== undefined ? `${sized}, ${info.note}` : sized;
}

export function listFilesText(files: AttachedFiles): string {
  if (files.size === 0) {
    return "No files are currently attached. The user can attach files by dragging them onto the message box or using the attach button.";
  }
  const lines = [...files.values()].map((info) => `- ${info.path} (${formatSize(info)})`);
  return `${files.size} file(s) attached:\n${lines.join("\n")}`;
}

export function readFileText(path: string, files: AttachedFiles, { offset = 0, limit = DEFAULT_PAGE_SIZE }: ReadRange = {}): string {
  const info = files.get(path);
  if (info === undefined) {
    const available = [...files.keys()].join(", ");
    throw new Error(`File '${path}' not found. Attached files: ${available || "(none)"}`);
  }
  if (info.text.length === 0) {
    return "(empty file)";
  }
  if (offset < 0 || offset >= info.text.length) {
    throw new Error(`offset ${offset} is out of range - '${path}' is ${info.text.length} characters long`);
  }
  const size = Math.floor(limit);
  if (!Number.isFinite(size) || size < 1) {
    throw new Error(`limit must be a positive number of characters - got ${limit}`);
  }
  const chunk = info.text.slice(offset, offset + size);
  const nextOffset = offset + chunk.length;
  if (nextOffset < info.text.length) {
    return `${chunk}\n\n[${nextOffset} of ${info.text.length} characters read - call read_file again with offset=${nextOffset} for more]`;
  }
  return chunk;
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
  return `${start > 0 ? "..." : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "..." : ""}`;
}

function* matchLines(info: FileInfo, pattern: RegExp): Generator<string> {
  for (const match of info.text.matchAll(pattern)) {
    yield `- ${info.path} @ offset ${match.index}: "${snippetAround(info.text, match.index, match[0].length)}"`;
  }
}

function* allMatchLines(files: AttachedFiles, pattern: RegExp): Generator<string> {
  for (const info of files.values()) yield* matchLines(info, pattern);
}

export function searchFilesText(query: string, files: AttachedFiles): string {
  const trimmed = query.trim();
  if (trimmed === "") {
    throw new Error("Search query must not be empty.");
  }
  const lines: string[] = [];
  for (const line of allMatchLines(files, new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"))) {
    lines.push(line);
    if (lines.length > MAX_MATCHES) break;
  }
  const truncated = lines.length > MAX_MATCHES;
  if (truncated) lines.pop();

  if (lines.length === 0) {
    return `No matches found for "${trimmed}".`;
  }
  const header = truncated
    ? `First ${lines.length} matches for "${trimmed}" (there are more - narrow the query to see the rest):`
    : `${lines.length} match(es) for "${trimmed}":`;
  return `${header}\n${lines.join("\n")}`;
}

export const FILE_TOOL_NAMES = ["list_files", "read_file", "search_files"];

export function fileToolSource(files: Map<string, FileInfo>, guard: ToolGuard): ToolSource {
  const tools = {
    list_files: guard({
      name: "list_files",
      description: "List the files currently attached to this conversation, with their size (and page count for PDFs).",
      inputSchema: z.object({}),
      run: async () => listFilesText(files),
    }),
    read_file: guard({
      name: "read_file",
      description:
        "Read an attached file's text content. Paginated for long documents - if the result says more remains, call again with the given offset.",
      inputSchema: z.object({
        path: z.string().describe("the file's path, from list_files"),
        offset: z.number().optional().describe("character offset to start reading from (default 0)"),
        limit: z.number().optional().describe("maximum characters to read (default 8000)"),
      }),
      run: async ({ path, offset, limit }) => readFileText(path, files, { offset, limit }),
    }),
    search_files: guard({
      name: "search_files",
      description:
        "Search across every attached file's text for a keyword or phrase. " +
        "Returns matching snippets with their file and offset - use read_file with that offset for more context.",
      inputSchema: z.object({ query: z.string().describe("the text to search for") }),
      run: async ({ query }) => searchFilesText(query, files),
    }),
  };
  return { label: "the file tools", tools: async () => tools, close: async () => {} };
}
