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

import { asSchema, type Tool } from "ai";
import { describe, it, expect } from "vitest";
import { FILE_TOOL_NAMES, fileToolSource, listFilesText, readFileText, searchFilesText } from "./files";
import type { ToolOutput } from "./run";
import { createToolGuard } from "./tool-guard";
import type { FileInfo } from "./files";

function filesMap(entries: FileInfo[]): Map<string, FileInfo> {
  return new Map(entries.map((info) => [info.path, info]));
}

const guard = createToolGuard({ request: async () => "allow" });

async function toolsOf(files: Map<string, FileInfo>) {
  const tools = await fileToolSource(files, guard).tools();
  const run = async (name: string, args: unknown): Promise<ToolOutput> =>
    (await (tools[name] as Tool).execute?.(args, { toolCallId: "1", messages: [], abortSignal: new AbortController().signal })) as ToolOutput;
  return { tools, run };
}

describe("listFilesText", () => {
  it("explains how to attach files when nothing is attached", () => {
    expect(listFilesText(new Map())).toContain("No files are currently attached");
  });

  it("lists every attached file with its size", () => {
    const files = filesMap([
      { name: "notes.md", path: "notes.md", text: "hello world" },
      { name: "report.pdf", path: "report.pdf", text: "a".repeat(100), pages: 3 },
    ]);
    const text = listFilesText(files);
    expect(text).toContain("2 file(s) attached");
    expect(text).toContain("notes.md (11 characters)");
    expect(text).toContain("report.pdf (100 characters, 3 pages)");
  });

  it("says next to a file's name when only part of it was read, so the model knows the text is incomplete", () => {
    const files = filesMap([{ name: "big.pdf", path: "big.pdf", text: "a".repeat(100), pages: 812, note: "stopped after page 500 of 812" }]);
    expect(listFilesText(files)).toContain("big.pdf (100 characters, 812 pages, stopped after page 500 of 812)");
  });

  it("singularizes a single page", () => {
    const files = filesMap([{ name: "a.pdf", path: "a.pdf", text: "x", pages: 1 }]);
    expect(listFilesText(files)).toContain("1 page)");
  });
});

describe("readFileText", () => {
  const files = filesMap([{ name: "notes.md", path: "notes.md", text: "0123456789" }]);

  it("reads the whole file when it fits in one page", () => {
    expect(readFileText("notes.md", files)).toBe("0123456789");
  });

  it("paginates when the content exceeds the limit, with a resumable offset hint", () => {
    const result = readFileText("notes.md", files, { offset: 0, limit: 4 });
    expect(result).toBe("0123\n\n[4 of 10 characters read - call read_file again with offset=4 for more]");
  });

  it("resumes from the given offset", () => {
    expect(readFileText("notes.md", files, { offset: 4, limit: 4 })).toBe("4567\n\n[8 of 10 characters read - call read_file again with offset=8 for more]");
  });

  it("returns the final chunk with no pagination hint once it reaches the end", () => {
    expect(readFileText("notes.md", files, { offset: 8, limit: 4 })).toBe("89");
  });

  it("throws a clear error for an unknown path, listing what's available", () => {
    expect(() => readFileText("missing.md", files)).toThrow(/Attached files: notes\.md/);
  });

  it("throws for an out-of-range offset", () => {
    expect(() => readFileText("notes.md", files, { offset: 999 })).toThrow(/out of range/);
  });

  it("handles an empty file", () => {
    const empty = filesMap([{ name: "e.txt", path: "e.txt", text: "" }]);
    expect(readFileText("e.txt", empty)).toBe("(empty file)");
  });
});

describe("searchFilesText", () => {
  const files = filesMap([
    { name: "a.md", path: "a.md", text: "The quarterly revenue grew by 12% year over year, driven by strong sales." },
    { name: "b.md", path: "b.md", text: "Revenue projections for next quarter look promising." },
    { name: "c.md", path: "c.md", text: "Nothing relevant here." },
  ]);

  it("finds case-insensitive matches across multiple files with snippets and offsets", () => {
    const result = searchFilesText("revenue", files);
    expect(result).toContain("2 match(es)");
    expect(result).toContain("a.md @ offset 14:");
    expect(result).toContain("b.md @ offset 0:");
    expect(result).not.toContain("c.md");
  });

  it("returns a clear no-matches message", () => {
    expect(searchFilesText("nonexistent-term", files)).toBe('No matches found for "nonexistent-term".');
  });

  it("rejects an empty query", () => {
    expect(() => searchFilesText("   ", files)).toThrow(/must not be empty/);
  });

  it("truncates to at most 20 matches", () => {
    const repeated = "needle ".repeat(50);
    const many = filesMap([{ name: "big.md", path: "big.md", text: repeated }]);
    const result = searchFilesText("needle", many);
    const matchCount = result.match(/@ offset/g)?.length ?? 0;
    expect(matchCount).toBe(20);
  });
});

describe("fileToolSource", () => {
  it("exposes list_files, read_file, and search_files as real tools", async () => {
    const { tools } = await toolsOf(filesMap([{ name: "a.md", path: "a.md", text: "hello" }]));
    expect(Object.keys(tools).sort()).toEqual(["list_files", "read_file", "search_files"]);
  });

  it("reflects a live mutation to the underlying map with no rebuild needed", async () => {
    const files = filesMap([]);
    const { run } = await toolsOf(files);
    expect((await run("list_files", {})).content).toContain("No files are currently attached");
    files.set("new.md", { name: "new.md", path: "new.md", text: "just attached" });
    expect((await run("list_files", {})).content).toContain("new.md");
  });

  it("read_file executes end-to-end with offset/limit args", async () => {
    const { run } = await toolsOf(filesMap([{ name: "a.md", path: "a.md", text: "0123456789" }]));
    const result = await run("read_file", { path: "a.md", offset: 2, limit: 3 });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("234");
  });

  it("search_files executes end-to-end", async () => {
    const { run } = await toolsOf(filesMap([{ name: "a.md", path: "a.md", text: "the answer is 42" }]));
    const result = await run("search_files", { query: "answer" });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("a.md @ offset 4");
  });

  it("turns a failure into a failed tool result, not a crash", async () => {
    const { run } = await toolsOf(filesMap([]));
    const result = await run("read_file", { path: "missing.md" });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("File 'missing.md' not found");
  });

  it("asks for the path and the query before it runs", async () => {
    const { tools } = await toolsOf(filesMap([]));
    for (const [name, args] of [["read_file", {}], ["search_files", {}], ["read_file", { path: 3 }]] as const) {
      const checked = await asSchema((tools[name] as Tool).inputSchema).validate?.(args);
      expect(checked?.success).toBe(false);
    }
  });

  it("says a capped result is capped, rather than reporting the cap as the total", () => {
    const many = filesMap([{ name: "big.md", path: "big.md", text: "hit ".repeat(100) }]);
    const result = searchFilesText("hit", many);
    expect(result).toMatch(/^First 20 matches/);
    expect(result).toContain("there are more");
    expect(result).not.toContain("20 match(es)");
  });

  it("does not claim there are more when there are exactly 20", () => {
    const exact = filesMap([{ name: "e.md", path: "e.md", text: "hit ".repeat(20) }]);
    const result = searchFilesText("hit", exact);
    expect(result).toMatch(/^20 match\(es\)/);
    expect(result).not.toContain("there are more");
    expect(result.match(/@ offset/g)?.length).toBe(20);
  });

  it("caps at 20 and says so as soon as a 21st match exists", () => {
    const over = filesMap([{ name: "o.md", path: "o.md", text: "hit ".repeat(21) }]);
    const result = searchFilesText("hit", over);
    expect(result).toMatch(/^First 20 matches/);
    expect(result.match(/@ offset/g)?.length).toBe(20);
  });

  it("reports offsets in the original text, also after letters that lowercase to more than one", () => {
    const files = filesMap([{ name: "t.md", path: "t.md", text: "İx and İİx" }]);
    const result = searchFilesText("x", files);
    expect(result).toContain("@ offset 1:");
    expect(result).toContain("@ offset 9:");
    expect(result).not.toContain("@ offset 2:");
    for (const offset of [1, 9]) expect(readFileText("t.md", files, { offset, limit: 1 }).startsWith("x")).toBe(true);
  });

  it("treats the query as plain text, not as a pattern", () => {
    const files = filesMap([{ name: "p.md", path: "p.md", text: "cost (a+b)? yes. cost aab no" }]);
    expect(searchFilesText("(a+b)?", files)).toContain("1 match(es)");
    expect(searchFilesText("a.b", files)).toContain("No matches found");
  });

  it("still reports an exact count when nothing was cut off", () => {
    const few = filesMap([{ name: "s.md", path: "s.md", text: "hit and hit" }]);
    expect(searchFilesText("hit", few)).toContain("2 match(es)");
  });
});

describe("FILE_TOOL_NAMES", () => {
  it("names exactly the tools the file source offers", async () => {
    const { tools } = await toolsOf(new Map());
    expect(Object.keys(tools)).toEqual(FILE_TOOL_NAMES);
  });
});
