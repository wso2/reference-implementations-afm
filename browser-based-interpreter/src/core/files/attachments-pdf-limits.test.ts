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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { MAX_PDF_MS, MAX_PDF_PAGES, extractFile, extractFiles } from "./attachments";

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ GlobalWorkerOptions: {}, getDocument: vi.fn() }));
vi.mock("./pdf-worker", () => ({ ensurePdfWorker: async () => {} }));

const getDocument = vi.mocked(pdfjsLib.getDocument);

function pdf(name = "report.pdf"): File {
  return new File(["%PDF-1.4"], name, { type: "application/pdf" });
}

function fakeTask(pages: number, { hangAfter }: { hangAfter?: number } = {}) {
  let rejectHang: (error: Error) => void = () => {};
  const destroy = vi.fn(async () => rejectHang(new Error("destroyed")));
  const doc = {
    numPages: pages,
    getPage: async (number: number) => {
      if (hangAfter !== undefined && number > hangAfter) await new Promise((_, reject) => (rejectHang = reject));
      return { getTextContent: async () => ({ items: [{ str: `text of page ${number}` }] }) };
    },
  };
  return { promise: Promise.resolve(doc), destroy };
}

beforeEach(() => getDocument.mockReset());
afterEach(() => vi.useRealTimers());

describe("reading a PDF", () => {
  it("reads every page of a short document and says nothing is missing", async () => {
    const task = fakeTask(3);
    getDocument.mockReturnValue(task as never);
    const result = await extractFile(pdf());
    expect(result.ok && result.file.text).toContain("--- Page 3 ---");
    expect(result.ok && result.file.note).toBeUndefined();
    expect(result.ok && result.file.pages).toBe(3);
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });

  it("reads exactly the page limit and no more", async () => {
    expect(MAX_PDF_PAGES).toBe(500);
    getDocument.mockReturnValue(fakeTask(500) as never);
    const result = await extractFile(pdf());
    expect(result.ok && result.file.note).toBeUndefined();
  });

  it("stops after 500 pages, keeps what it read, and says where it stopped", async () => {
    getDocument.mockReturnValue(fakeTask(812) as never);
    const result = await extractFile(pdf());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.text).toContain("--- Page 500 ---");
    expect(result.file.text).not.toContain("--- Page 501 ---");
    expect(result.file.pages).toBe(812);
    expect(result.file.note).toBe("stopped after page 500 of 812");
  });

  it("stops after 30 seconds, keeps the pages read so far, and says where it stopped", async () => {
    vi.useFakeTimers();
    expect(MAX_PDF_MS).toBe(30_000);
    const task = fakeTask(5, { hangAfter: 2 });
    getDocument.mockReturnValue(task as never);
    const reading = extractFile(pdf());
    await vi.advanceTimersByTimeAsync(MAX_PDF_MS);
    const result = await reading;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.text).toContain("--- Page 2 ---");
    expect(result.file.text).not.toContain("--- Page 3 ---");
    expect(result.file.note).toBe("stopped after page 2 of 5");
    expect(task.destroy).toHaveBeenCalled();
  });

  it("gives up on a document that has not opened after 30 seconds", async () => {
    vi.useFakeTimers();
    let rejectOpen: (error: Error) => void = () => {};
    const task = {
      promise: new Promise((_, reject) => (rejectOpen = reject)),
      destroy: vi.fn(async () => rejectOpen(new Error("destroyed"))),
    };
    getDocument.mockReturnValue(task as never);
    const reading = extractFile(pdf());
    await vi.advanceTimersByTimeAsync(MAX_PDF_MS);
    expect(await reading).toEqual({
      ok: false,
      name: "report.pdf",
      reason: expect.stringContaining("took longer than 30 seconds"),
    });
  });

  it("stops the clock once it has finished", async () => {
    vi.useFakeTimers();
    getDocument.mockReturnValue(fakeTask(2) as never);
    await extractFile(pdf());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still reports a document that cannot be read for another reason", async () => {
    getDocument.mockReturnValue({
      promise: Promise.reject(new Error("Invalid PDF structure")),
      destroy: vi.fn(),
    } as never);
    expect(await extractFile(pdf())).toEqual({
      ok: false,
      name: "report.pdf",
      reason: "couldn't be read: Invalid PDF structure",
    });
  });
});

describe("reading several files", () => {
  it("reads PDFs one at a time", async () => {
    let open = 0;
    let most = 0;
    getDocument.mockImplementation(() => {
      open += 1;
      most = Math.max(most, open);
      const task = fakeTask(2);
      return {
        promise: task.promise.then(async (doc) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return doc;
        }),
        destroy: async () => void (open -= 1),
      } as never;
    });
    const result = await extractFiles(
      [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")].map((file) => ({ file, path: file.name })),
    );
    expect(result.attached).toHaveLength(3);
    expect(most).toBe(1);
  });

  it("keeps a partly read file attached and reports the note with it", async () => {
    getDocument.mockReturnValue(fakeTask(812) as never);
    const result = await extractFiles([{ file: pdf(), path: "report.pdf" }]);
    expect(result.attached[0]?.note).toBe("stopped after page 500 of 812");
    expect(result.skipped).toEqual([]);
  });
});
