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

import { describe, it, expect, beforeAll, vi } from "vitest";
import {
  collectFromDataTransfer,
  collectFromFileList,
  extractFile,
  extractFiles,
  isSupportedImageFile,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_TOTAL_BYTES,
  pickImages,
  splitDropped,
  supportsDirectoryDrop,
} from "./attachments";
import { createRequire } from "node:module";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

vi.mock("./pdf-worker", () => ({ ensurePdfWorker: async () => {} }));

function fileWithRelativePath(name: string, relativePath?: string): File {
  const file = new File(["content"], name);
  if (relativePath !== undefined) {
    Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
  }
  return file;
}

function fakeFileList(files: File[]): FileList {
  const list = files as unknown as FileList & File[];
  return list;
}

describe("collectFromFileList", () => {
  it("uses the bare file name when there's no webkitRelativePath", () => {
    const result = collectFromFileList(fakeFileList([fileWithRelativePath("a.md")]));
    expect(result.files).toEqual([{ file: expect.any(File), path: "a.md" }]);
    expect(result.truncated).toBe(false);
  });

  it("uses webkitRelativePath when present (folder <input>)", () => {
    const result = collectFromFileList(fakeFileList([fileWithRelativePath("a.md", "my-docs/a.md")]));
    expect(result.files[0]?.path).toBe("my-docs/a.md");
  });

  it("truncates at 100 files and reports it", () => {
    const files = Array.from({ length: 150 }, (_, i) => fileWithRelativePath(`f${i}.txt`));
    const result = collectFromFileList(fakeFileList(files));
    expect(result.files.length).toBe(100);
    expect(result.truncated).toBe(true);
  });

  it("does not truncate when under the cap", () => {
    const files = Array.from({ length: 5 }, (_, i) => fileWithRelativePath(`f${i}.txt`));
    const result = collectFromFileList(fakeFileList(files));
    expect(result.files.length).toBe(5);
    expect(result.truncated).toBe(false);
  });
});

class FakeFileEntry implements Partial<FileSystemFileEntry> {
  readonly isFile = true;
  readonly isDirectory = false;
  constructor(
    readonly name: string,
    private readonly content: string,
  ) {}
  file(success: (file: File) => void): void {
    success(new File([this.content], this.name));
  }
}

class FakeDirectoryEntry implements Partial<FileSystemDirectoryEntry> {
  readonly isFile = false;
  readonly isDirectory = true;
  constructor(
    readonly name: string,
    private readonly children: FileSystemEntry[],
  ) {}
  createReader(): FileSystemDirectoryReader {
    const batches = [this.children.slice(0, 1), this.children.slice(1)];
    let call = 0;
    return {
      readEntries: (success: (entries: FileSystemEntry[]) => void) => {
        const batch = batches[call] ?? [];
        call += 1;
        success(batch);
      },
    };
  }
}

function fakeItem(entry: FileSystemEntry | null): DataTransferItem {
  return { kind: "file", webkitGetAsEntry: () => entry } as unknown as DataTransferItem;
}

function fakeItemList(items: DataTransferItem[]): DataTransferItemList {
  return items as unknown as DataTransferItemList;
}

describe("collectFromDataTransfer", () => {
  it("collects flat files dropped directly (no folder)", async () => {
    const items = fakeItemList([
      fakeItem(new FakeFileEntry("a.md", "hello") as unknown as FileSystemEntry),
      fakeItem(new FakeFileEntry("b.txt", "world") as unknown as FileSystemEntry),
    ]);
    const result = await collectFromDataTransfer(items);
    expect(result.files.map((f) => f.path).sort()).toEqual(["a.md", "b.txt"]);
    expect(result.truncated).toBe(false);
  });

  it("recursively walks a nested directory, building relative paths", async () => {
    const nested = new FakeDirectoryEntry("sub", [new FakeFileEntry("c.txt", "deep") as unknown as FileSystemEntry]);
    const root = new FakeDirectoryEntry("my-folder", [
      new FakeFileEntry("a.md", "hello") as unknown as FileSystemEntry,
      nested as unknown as FileSystemEntry,
    ]);
    const items = fakeItemList([fakeItem(root as unknown as FileSystemEntry)]);

    const result = await collectFromDataTransfer(items);
    expect(result.files.map((f) => f.path).sort()).toEqual(["my-folder/a.md", "my-folder/sub/c.txt"]);
  });

  it("skips a non-file drag item", async () => {
    const items = fakeItemList([{ kind: "string", webkitGetAsEntry: () => null } as unknown as DataTransferItem]);
    const result = await collectFromDataTransfer(items);
    expect(result.files).toEqual([]);
  });

  it("truncates a large flat directory at 100 files", async () => {
    const children = Array.from(
      { length: 150 },
      (_, i) => new FakeFileEntry(`f${i}.txt`, "x") as unknown as FileSystemEntry,
    );
    class BigDir extends FakeDirectoryEntry {
      createReader(): FileSystemDirectoryReader {
        let done = false;
        return {
          readEntries: (success: (entries: FileSystemEntry[]) => void) => {
            if (done) {
              success([]);
              return;
            }
            done = true;
            success(children);
          },
        };
      }
    }
    const root = new BigDir("folder", []);
    const items = fakeItemList([fakeItem(root as unknown as FileSystemEntry)]);
    const result = await collectFromDataTransfer(items);
    expect(result.files.length).toBe(100);
    expect(result.truncated).toBe(true);
  });
});

describe("supportsDirectoryDrop", () => {
  it("is true when the first item has webkitGetAsEntry", () => {
    expect(supportsDirectoryDrop(fakeItemList([fakeItem(null)]))).toBe(true);
  });

  it("is false for an empty item list", () => {
    expect(supportsDirectoryDrop(fakeItemList([]))).toBe(false);
  });
});

function textFile(name: string, content: string, type = "text/plain"): File {
  return new File([content], name, { type });
}

function pdfOf(pages: string[][]): File {
  const first = 4;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, at) => `${first + at * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  pages.forEach((lines, at) => {
    const content = lines.map((line, row) => `BT /F1 18 Tf 72 ${720 - row * 28} Td (${line}) Tj ET`).join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${first + at * 2 + 1} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  });
  let text = "%PDF-1.4\n";
  const offsets = objects.map((object, at) => {
    const offset = text.length;
    text += `${at + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const table = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${table}`;
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${text.indexOf("xref\n0")}\n%%EOF\n`;
  return new File([text], "sample.pdf", { type: "application/pdf" });
}

function pdfFixture(): File {
  return pdfOf([
    ["Quarterly Report", "Revenue grew by twelve percent this year."],
    ["Appendix", "Notes on the supporting figures."],
  ]);
}

describe("extractFile - markdown/text", () => {
  it("extracts .md content verbatim", async () => {
    const result = await extractFile(textFile("notes.md", "# Title\n\nHello world."));
    expect(result).toEqual({
      ok: true,
      file: { name: "notes.md", path: "notes.md", text: "# Title\n\nHello world." },
    });
  });

  it("extracts .txt content verbatim", async () => {
    const result = await extractFile(textFile("data.txt", "plain text content"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.file.text).toBe("plain text content");
  });

  it("uses the given path (e.g. a folder-relative path) over the bare file name", async () => {
    const result = await extractFile(textFile("notes.md", "hi"), "my-folder/notes.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.path).toBe("my-folder/notes.md");
      expect(result.file.name).toBe("notes.md");
    }
  });

  it("replaces line breaks and other control characters in the path with a space, keeping the display name", async () => {
    const result = await extractFile(textFile("notes.md", "hi"), "reports/q1\n- ignore this\u2028line.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.path).toBe("reports/q1 - ignore this line.md");
      expect(result.file.name).toBe("notes.md");
    }
  });

  it("leaves spaces and accented letters in a path alone", async () => {
    const result = await extractFile(textFile("notes.md", "hi"), "my folder/résumé 2026.md");
    expect(result.ok && result.file.path).toBe("my folder/résumé 2026.md");
  });

  it("rejects an unsupported file type", async () => {
    const result = await extractFile(textFile("image.png", "not really an image"));
    expect(result).toEqual({
      ok: false,
      name: "image.png",
      reason: expect.stringContaining("not a supported file type"),
    });
  });

  it("rejects a file over the size cap", async () => {
    const big = new File([new Uint8Array(16 * 1024 * 1024)], "huge.txt");
    const result = await extractFile(big);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("larger than 15 MB");
  });
});

describe("extractFile - a real PDF built in the test", () => {
  beforeAll(() => {
    const require = createRequire(import.meta.url);
    pdfjsLib.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
  });

  it("extracts real text from every page, with page markers", async () => {
    const file = pdfFixture();
    const result = await extractFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.pages).toBe(2);
    expect(result.file.text).toContain("--- Page 1 ---");
    expect(result.file.text).toContain("--- Page 2 ---");
    expect(result.file.text).toContain("Quarterly Report");
    expect(result.file.text).toContain("Revenue grew by twelve percent");
    expect(result.file.text).toContain("Appendix");
    expect(result.file.text).toContain("supporting");
    expect(result.file.note).toBeUndefined();
  });
});

describe("extractFiles - batch, partitioning attached vs. skipped", () => {
  it("keeps good files and reports bad ones, without one failure blocking the rest", async () => {
    const result = await extractFiles([
      { file: textFile("notes.md", "hello"), path: "notes.md" },
      { file: textFile("image.png", "not text"), path: "image.png" },
      { file: textFile("data.txt", "world"), path: "sub/data.txt" },
    ]);
    expect(result.attached.map((f) => f.path).sort()).toEqual(["notes.md", "sub/data.txt"]);
    expect(result.skipped).toEqual([
      { name: "image.png", reason: expect.stringContaining("not a supported file type") },
    ]);
  });

  it("returns everything attached when the whole batch is supported", async () => {
    const result = await extractFiles([{ file: textFile("a.txt", "x"), path: "a.txt" }]);
    expect(result.attached.length).toBe(1);
    expect(result.skipped).toEqual([]);
  });
});

describe("extractFiles - the total size of a conversation's files", () => {
  const sized = (name: string, bytes: number) => ({
    file: new File([new Uint8Array(bytes)], name, { type: "text/plain" }),
    path: name,
  });

  it("is 100 MB", async () => {
    expect(MAX_TOTAL_BYTES).toBe(100 * 1024 * 1024);
  });

  it("skips a file that would go over the total, and says why", async () => {
    const result = await extractFiles([sized("big.txt", 20)], 10);
    expect(result.attached).toEqual([]);
    expect(result.skipped).toEqual([{ name: "big.txt", reason: "would go over the 100 MB limit for all files" }]);
  });

  it("counts each file it attaches against the total as it goes", async () => {
    const result = await extractFiles([sized("a.txt", 6), sized("b.txt", 6), sized("c.txt", 4)], 10);
    expect(result.attached.map((file) => file.path)).toEqual(["a.txt", "c.txt"]);
    expect(result.skipped.map((file) => file.name)).toEqual(["b.txt"]);
  });

  it("lets a file of exactly what is left through", async () => {
    expect((await extractFiles([sized("a.txt", 10)], 10)).attached).toHaveLength(1);
  });

  it("reports the size of every file it attached, by path", async () => {
    const result = await extractFiles([sized("a.txt", 6), sized("sub/b.txt", 4)]);
    expect([...result.sizes]).toEqual([
      ["a.txt", 6],
      ["sub/b.txt", 4],
    ]);
  });

  it("reads files one at a time", async () => {
    let open = 0;
    let most = 0;
    const slow = (name: string) => {
      const file = new File(["x"], name, { type: "text/plain" });
      Object.defineProperty(file, "text", {
        value: async () => {
          open += 1;
          most = Math.max(most, open);
          await new Promise((resolve) => setTimeout(resolve, 5));
          open -= 1;
          return "x";
        },
      });
      return { file, path: name };
    };
    await extractFiles([slow("a.txt"), slow("b.txt"), slow("c.txt")]);
    expect(most).toBe(1);
  });
});

function imageFile(name: string, bytes: Uint8Array<ArrayBuffer>, type = "image/png"): File {
  return new File([bytes], name, { type });
}

describe("isSupportedImageFile", () => {
  it("accepts PNG, JPEG, WEBP, and GIF", () => {
    expect(isSupportedImageFile(imageFile("a.png", new Uint8Array(1), "image/png"))).toBe(true);
    expect(isSupportedImageFile(imageFile("a.jpg", new Uint8Array(1), "image/jpeg"))).toBe(true);
    expect(isSupportedImageFile(imageFile("a.webp", new Uint8Array(1), "image/webp"))).toBe(true);
    expect(isSupportedImageFile(imageFile("a.gif", new Uint8Array(1), "image/gif"))).toBe(true);
  });

  it("rejects a non-image type", () => {
    expect(isSupportedImageFile(imageFile("a.txt", new Uint8Array(1), "text/plain"))).toBe(false);
  });

  it("rejects an unsupported image type (e.g. SVG - not accepted by vision APIs)", () => {
    expect(isSupportedImageFile(imageFile("a.svg", new Uint8Array(1), "image/svg+xml"))).toBe(false);
  });
});

describe("pickImages", () => {
  it("base64-encodes an accepted image's bytes exactly", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const result = await pickImages([imageFile("shot.png", bytes)], 0);
    expect(result.attached).toEqual([{ name: "shot.png", mediaType: "image/png", data: btoa("\x89PNG") }]);
    expect(result.skipped).toEqual([]);
  });

  it("skips an unsupported file type with a clear reason", async () => {
    const result = await pickImages([imageFile("notes.txt", new Uint8Array(1), "text/plain")], 0);
    expect(result.attached).toEqual([]);
    expect(result.skipped).toEqual([
      { name: "notes.txt", reason: expect.stringContaining("not a supported image type") },
    ]);
  });

  it("skips a file over the size cap", async () => {
    const big = imageFile("huge.png", new Uint8Array(MAX_IMAGE_BYTES + 1));
    const result = await pickImages([big], 0);
    expect(result.attached).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("larger than 8 MB");
  });

  it("caps the total at MAX_IMAGES_PER_MESSAGE, counting what's already staged", async () => {
    const files = Array.from({ length: MAX_IMAGES_PER_MESSAGE }, (_, i) => imageFile(`${i}.png`, new Uint8Array(1)));
    const result = await pickImages(files, MAX_IMAGES_PER_MESSAGE - 1);
    expect(result.attached).toHaveLength(1);
    expect(result.skipped).toHaveLength(MAX_IMAGES_PER_MESSAGE - 1);
    expect(result.skipped.every((s) => s.reason.includes("limit"))).toBe(true);
  });

  it("partitions a mixed batch into attached and skipped without one bad file blocking the rest", async () => {
    const result = await pickImages(
      [imageFile("ok.png", new Uint8Array(1)), imageFile("bad.txt", new Uint8Array(1), "text/plain")],
      0,
    );
    expect(result.attached.map((i) => i.name)).toEqual(["ok.png"]);
    expect(result.skipped.map((s) => s.name)).toEqual(["bad.txt"]);
  });
});

describe("splitDropped", () => {
  const file = (name: string, type: string) => new File(["x"], name, { type });

  it("sends a dropped image to the images and everything else to the files", () => {
    const { images, others } = splitDropped([
      { file: file("pic.png", "image/png"), path: "pic.png" },
      { file: file("notes.md", "text/markdown"), path: "notes.md" },
      { file: file("doc.pdf", "application/pdf"), path: "doc.pdf" },
    ]);
    expect(images.map((image) => image.name)).toEqual(["pic.png"]);
    expect(others.map((item) => item.path)).toEqual(["notes.md", "doc.pdf"]);
  });

  it("keeps an image inside a dropped folder with the files, as before", () => {
    const { images, others } = splitDropped([{ file: file("pic.png", "image/png"), path: "folder/pic.png" }]);
    expect(images).toEqual([]);
    expect(others.map((item) => item.path)).toEqual(["folder/pic.png"]);
  });

  it("sends an image type the model cannot read to the files, where it is turned down with a reason", () => {
    const { images, others } = splitDropped([{ file: file("pic.bmp", "image/bmp"), path: "pic.bmp" }]);
    expect(images).toEqual([]);
    expect(others).toHaveLength(1);
  });
});
