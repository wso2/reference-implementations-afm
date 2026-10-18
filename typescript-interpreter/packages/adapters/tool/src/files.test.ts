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
import { FILE_TOOL_NAMES, FileToolError, listFilesText, readFileText, searchFilesText, filesToolPort } from "./files";
import type { FileInfo } from "./files";

function filesMap(entries: FileInfo[]): Map<string, FileInfo> {
  return new Map(entries.map((info) => [info.path, info]));
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
    const result = readFileText("notes.md", files, 0, 4);
    expect(result).toBe("0123\n\n[4 of 10 characters read - call read_file again with offset=4 for more]");
  });

  it("resumes from the given offset", () => {
    expect(readFileText("notes.md", files, 4, 4)).toBe("4567\n\n[8 of 10 characters read - call read_file again with offset=8 for more]");
  });

  it("returns the final chunk with no pagination hint once it reaches the end", () => {
    expect(readFileText("notes.md", files, 8, 4)).toBe("89");
  });

  it("throws a clear error for an unknown path, listing what's available", () => {
    expect(() => readFileText("missing.md", files)).toThrow(/Attached files: notes\.md/);
  });

  it("throws for an out-of-range offset", () => {
    expect(() => readFileText("notes.md", files, 999)).toThrow(/out of range/);
  });

  it("handles an empty file", () => {
    const empty = filesMap([{ name: "e.txt", path: "e.txt", text: "" }]);
    expect(readFileText("e.txt", empty)).toBe("(empty file)");
  });

  it("throws FileToolError instances specifically", () => {
    expect(() => readFileText("missing.md", files)).toThrow(FileToolError);
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

describe("filesToolPort", () => {
  it("exposes list_files, read_file, and search_files as real tools", async () => {
    const files = filesMap([{ name: "a.md", path: "a.md", text: "hello" }]);
    const port = filesToolPort(files);
    const descriptors = await port.list();
    expect(descriptors.map((d) => d.name).sort()).toEqual(["list_files", "read_file", "search_files"]);
  });

  it("reflects a live mutation to the underlying map with no rebuild needed", async () => {
    const files = filesMap([]);
    const port = filesToolPort(files);

    const before = await port.execute({ id: "1", name: "list_files", args: {} }, new AbortController().signal);
    expect(before.content).toContain("No files are currently attached");

    files.set("new.md", { name: "new.md", path: "new.md", text: "just attached" });

    const after = await port.execute({ id: "2", name: "list_files", args: {} }, new AbortController().signal);
    expect(after.content).toContain("new.md");
  });

  it("read_file executes end-to-end through the tool port with offset/limit args", async () => {
    const files = filesMap([{ name: "a.md", path: "a.md", text: "0123456789" }]);
    const port = filesToolPort(files);
    const result = await port.execute(
      { id: "1", name: "read_file", args: { path: "a.md", offset: 2, limit: 3 } },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("234");
  });

  it("search_files executes end-to-end through the tool port", async () => {
    const files = filesMap([{ name: "a.md", path: "a.md", text: "the answer is 42" }]);
    const port = filesToolPort(files);
    const result = await port.execute(
      { id: "1", name: "search_files", args: { query: "answer" } },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("a.md @ offset 4");
  });

  it("turns a missing required arg into a failed tool result, not a crash", async () => {
    const port = filesToolPort(filesMap([]));
    const result = await port.execute({ id: "1", name: "read_file", args: {} }, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("'path' is required");
  });

  it("says a capped result is capped, rather than reporting the cap as the total", () => {
    const many = filesMap([{ name: "big.md", path: "big.md", text: "hit ".repeat(100) }]);
    const result = searchFilesText("hit", many);
    expect(result).toMatch(/^First 20 matches/);
    expect(result).toContain("there are more");
    expect(result).not.toContain("20 match(es)");
  });

  it("still reports an exact count when nothing was cut off", () => {
    const few = filesMap([{ name: "s.md", path: "s.md", text: "hit and hit" }]);
    expect(searchFilesText("hit", few)).toContain("2 match(es)");
  });
});

describe("FILE_TOOL_NAMES", () => {
  it("names exactly the tools the file port offers", async () => {
    const offered = (await filesToolPort(new Map()).list()).map((tool) => tool.name);
    expect(offered).toEqual(FILE_TOOL_NAMES);
  });
});
