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

import type { ToolPort } from "@afm/engine";
import { inPageToolPort } from "./tool-ports";
import type { InPageTool } from "./tool-ports";

export interface FileInfo {
  name: string;
  path: string;
  text: string;
  pages?: number;
  note?: string;
}

export class FileToolError extends Error {}

export const FILE_TOOL_NAMES = ["list_files", "read_file", "search_files"];

const DEFAULT_PAGE_SIZE = 8000;
const SNIPPET_RADIUS = 80;
const MAX_MATCHES = 20;

function formatSize(info: FileInfo): string {
  const base = `${info.text.length.toLocaleString()} characters`;
  const sized = info.pages !== undefined ? `${base}, ${info.pages} page${info.pages === 1 ? "" : "s"}` : base;
  return info.note !== undefined ? `${sized}, ${info.note}` : sized;
}

export function listFilesText(files: Map<string, FileInfo>): string {
  if (files.size === 0) {
    return "No files are currently attached. The user can attach files by dragging them onto the message box or using the attach button.";
  }
  const lines = [...files.values()].map((info) => `- ${info.path} (${formatSize(info)})`);
  return `${files.size} file(s) attached:\n${lines.join("\n")}`;
}

export function readFileText(path: string, files: Map<string, FileInfo>, offset = 0, limit = DEFAULT_PAGE_SIZE): string {
  const info = files.get(path);
  if (info === undefined) {
    const available = [...files.keys()].join(", ");
    throw new FileToolError(`File '${path}' not found. Attached files: ${available || "(none)"}`);
  }
  if (info.text.length === 0) {
    return "(empty file)";
  }
  if (offset < 0 || offset >= info.text.length) {
    throw new FileToolError(`offset ${offset} is out of range - '${path}' is ${info.text.length} characters long`);
  }
  const size = Math.floor(limit);
  if (!Number.isFinite(size) || size < 1) {
    throw new FileToolError(`limit must be a positive number of characters - got ${limit}`);
  }
  const chunk = info.text.slice(offset, offset + size);
  const nextOffset = offset + chunk.length;
  if (nextOffset < info.text.length) {
    return `${chunk}\n\n[${nextOffset} of ${info.text.length} characters read - call read_file again with offset=${nextOffset} for more]`;
  }
  return chunk;
}

export function searchFilesText(query: string, files: Map<string, FileInfo>): string {
  const trimmed = query.trim();
  if (trimmed === "") {
    throw new FileToolError("Search query must not be empty.");
  }
  const needle = trimmed.toLowerCase();
  const lines: string[] = [];
  let truncated = false;

  outer: for (const info of files.values()) {
    const haystack = info.text.toLowerCase();
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index === -1) break;
      const start = Math.max(0, index - SNIPPET_RADIUS);
      const end = Math.min(info.text.length, index + needle.length + SNIPPET_RADIUS);
      const snippet = `${start > 0 ? "..." : ""}${info.text.slice(start, end).replace(/\s+/g, " ")}${end < info.text.length ? "..." : ""}`;
      lines.push(`- ${info.path} @ offset ${index}: "${snippet}"`);
      if (lines.length >= MAX_MATCHES) {
        truncated = true;
        break outer;
      }
      from = index + needle.length;
    }
  }

  if (lines.length === 0) {
    return `No matches found for "${trimmed}".`;
  }
  const header = truncated
    ? `First ${lines.length} matches for "${trimmed}" (there are more - narrow the query to see the rest):`
    : `${lines.length} match(es) for "${trimmed}":`;
  return `${header}\n${lines.join("\n")}`;
}

function stringArg(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | null)?.[key];
  if (typeof value !== "string") {
    throw new FileToolError(`'${key}' is required and must be a string`);
  }
  return value;
}

function optionalNumberArg(args: unknown, key: string): number | undefined {
  const value = (args as Record<string, unknown> | null)?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FileToolError(`'${key}' must be a number`);
  }
  return value;
}

export function filesToolPort(files: Map<string, FileInfo>): ToolPort {
  const tools: InPageTool[] = [
    {
      name: "list_files",
      description: "List the files currently attached to this conversation, with their size (and page count for PDFs).",
      inputSchema: { type: "object", properties: {} },
      run: () => listFilesText(files),
    },
    {
      name: "read_file",
      description:
        "Read an attached file's text content. Paginated for long documents - if the result says more remains, call again with the given offset.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "the file's path, from list_files" },
          offset: { type: "number", description: "character offset to start reading from (default 0)" },
          limit: { type: "number", description: "maximum characters to read (default 8000)" },
        },
        required: ["path"],
      },
      run: (args) =>
        readFileText(stringArg(args, "path"), files, optionalNumberArg(args, "offset"), optionalNumberArg(args, "limit")),
    },
    {
      name: "search_files",
      description:
        "Search across every attached file's text for a keyword or phrase. Returns matching snippets with their file and offset - use read_file with that offset for more context.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "the text to search for" } },
        required: ["query"],
      },
      run: (args) => searchFilesText(stringArg(args, "query"), files),
    },
  ];
  return inPageToolPort(tools);
}
