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

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ GlobalWorkerOptions: {} as Record<string, unknown> }));
vi.mock("./blob-worker", () => ({ startBlobWorker: vi.fn() }));

import { startBlobWorker } from "./blob-worker";

const options = pdfjsLib.GlobalWorkerOptions as unknown as Record<string, unknown>;

beforeEach(() => {
  vi.resetModules();
  vi.mocked(startBlobWorker).mockReset();
  delete options.workerPort;
});

describe("ensurePdfWorker", () => {
  it("starts the pdf.js worker from a blob and hands it to pdf.js", async () => {
    const worker = { name: "pdf" };
    vi.mocked(startBlobWorker).mockResolvedValue(worker as unknown as Worker);
    const { ensurePdfWorker } = await import("./pdf-worker");
    await ensurePdfWorker();
    expect(options.workerPort).toBe(worker);
    expect(String(vi.mocked(startBlobWorker).mock.calls[0]?.[0])).toContain("pdf.worker.min");
  });

  it("starts it only once, however many files ask", async () => {
    vi.mocked(startBlobWorker).mockResolvedValue({} as Worker);
    const { ensurePdfWorker } = await import("./pdf-worker");
    await Promise.all([ensurePdfWorker(), ensurePdfWorker(), ensurePdfWorker()]);
    expect(startBlobWorker).toHaveBeenCalledTimes(1);
  });

  it("lets the next file try again after a start failed, and sets no worker meanwhile", async () => {
    vi.mocked(startBlobWorker)
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValue({} as Worker);
    const { ensurePdfWorker } = await import("./pdf-worker");
    await expect(ensurePdfWorker()).rejects.toThrow("blocked");
    expect(options.workerPort).toBeUndefined();
    await ensurePdfWorker();
    expect(startBlobWorker).toHaveBeenCalledTimes(2);
  });
});
