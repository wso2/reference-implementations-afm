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

import type { JsonSchema, ToolPort } from "@afm/engine";
import { inPageToolPort } from "./tool-ports";

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

interface FileToolSpec {
  description: string;
  inputSchema: JsonSchema;
  run(args: unknown, files: AttachedFiles): string;
}

export class FileToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileToolError";
  }
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

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
  return `${start > 0 ? "..." : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "..." : ""}`;
}

interface LowerCased {
  text: string;
  startOf(index: number): number;
  endOf(index: number): number;
}

function lowerCased(original: string): LowerCased {
  const text = original.toLowerCase();
  const sameLength: LowerCased = { text, startOf: (index) => index, endOf: (index) => index + 1 };
  if (text.length === original.length) return sameLength;

  const starts: number[] = [];
  const ends: number[] = [];
  for (let at = 0; at < original.length; ) {
    const character = String.fromCodePoint(original.codePointAt(at)!);
    for (let unit = character.toLowerCase().length; unit > 0; unit--) {
      starts.push(at);
      ends.push(at + character.length);
    }
    at += character.length;
  }
  if (starts.length !== text.length) return sameLength;
  return { text, startOf: (index) => starts[index]!, endOf: (index) => ends[index]! };
}

function* matchLines(info: FileInfo, needle: string): Generator<string> {
  const lowered = lowerCased(info.text);
  const haystack = lowered.text;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
    const start = lowered.startOf(index);
    const length = lowered.endOf(index + needle.length - 1) - start;
    yield `- ${info.path} @ offset ${start}: "${snippetAround(info.text, start, length)}"`;
  }
}

function* allMatchLines(files: AttachedFiles, needle: string): Generator<string> {
  for (const info of files.values()) yield* matchLines(info, needle);
}

export function searchFilesText(query: string, files: AttachedFiles): string {
  const trimmed = query.trim();
  if (trimmed === "") {
    throw new FileToolError("Search query must not be empty.");
  }
  const lines: string[] = [];
  for (const line of allMatchLines(files, trimmed.toLowerCase())) {
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

function argument(args: unknown, key: string): unknown {
  return (args as Record<string, unknown> | null)?.[key];
}

function stringArg(args: unknown, key: string): string {
  const value = argument(args, key);
  if (typeof value !== "string") {
    throw new FileToolError(`'${key}' is required and must be a string`);
  }
  return value;
}

function optionalNumberArg(args: unknown, key: string): number | undefined {
  const value = argument(args, key);
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FileToolError(`'${key}' must be a number`);
  }
  return value;
}

const FILE_TOOLS: Record<string, FileToolSpec> = {
  list_files: {
    description: "List the files currently attached to this conversation, with their size (and page count for PDFs).",
    inputSchema: { type: "object", properties: {} },
    run: (_args, files) => listFilesText(files),
  },
  read_file: {
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
    run: (args, files) =>
      readFileText(stringArg(args, "path"), files, { offset: optionalNumberArg(args, "offset"), limit: optionalNumberArg(args, "limit") }),
  },
  search_files: {
    description:
      "Search across every attached file's text for a keyword or phrase. " +
      "Returns matching snippets with their file and offset - use read_file with that offset for more context.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "the text to search for" } },
      required: ["query"],
    },
    run: (args, files) => searchFilesText(stringArg(args, "query"), files),
  },
};

export const FILE_TOOL_NAMES = Object.keys(FILE_TOOLS);

export function filesToolPort(files: AttachedFiles): ToolPort {
  return inPageToolPort(
    Object.entries(FILE_TOOLS).map(([name, { description, inputSchema, run }]) => ({
      name,
      description,
      inputSchema,
      run: (args) => run(args, files),
    })),
  );
}
