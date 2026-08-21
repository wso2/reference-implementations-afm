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
import { startBlobWorker } from "./blob-worker";

const SCRIPT = new URL("https://afm.example/assets/worker-abc123.js");

class FakeWorker {
  static created: { url: string; options?: WorkerOptions }[] = [];
  constructor(url: string | URL, options?: WorkerOptions) {
    FakeWorker.created.push({ url: String(url), options });
  }
}

beforeEach(() => {
  FakeWorker.created = [];
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("startBlobWorker on the dev server", () => {
  it("starts the worker from its own address, because the dev server's modules cannot load from a blob", async () => {
    vi.stubEnv("DEV", true);
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await startBlobWorker(SCRIPT);
    expect(FakeWorker.created).toEqual([{ url: SCRIPT.href, options: { type: "module" } }]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("startBlobWorker in the production build", () => {
  beforeEach(() => vi.stubEnv("DEV", false));

  it("fetches the script from its own address and starts the worker from a blob: URL, so it runs under the page's policy", async () => {
    const fetchFn = vi.fn(async () => new Response("self.onmessage = () => {};"));
    const createObjectURL = vi.fn((blob: Blob) => `blob:https://afm.example/${blob.size}`);
    vi.stubGlobal("fetch", fetchFn);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL }));
    await startBlobWorker(SCRIPT);
    expect(fetchFn).toHaveBeenCalledWith(SCRIPT);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0];
    expect(await blob.text()).toBe("self.onmessage = () => {};");
    expect(FakeWorker.created).toEqual([{ url: "blob:https://afm.example/26", options: { type: "module" } }]);
  });

  it("does not start a worker from the script's address when the script cannot be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    await expect(startBlobWorker(SCRIPT)).rejects.toThrow(/404/);
    expect(FakeWorker.created).toEqual([]);
  });

  it("does not start a worker from the script's address when the fetch fails outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await expect(startBlobWorker(SCRIPT)).rejects.toThrow(/Failed to fetch/);
    expect(FakeWorker.created).toEqual([]);
  });

  it("does not fall back to the script's address when the blob worker cannot be created", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("self.onmessage = () => {};")),
    );
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:https://afm.example/x" }));
    vi.stubGlobal(
      "Worker",
      class {
        constructor(url: string) {
          FakeWorker.created.push({ url });
          throw new DOMException("blocked", "SecurityError");
        }
      },
    );
    await expect(startBlobWorker(SCRIPT)).rejects.toThrow(/blocked/);
    expect(FakeWorker.created).toHaveLength(1);
    expect(FakeWorker.created[0]?.url.startsWith("blob:")).toBe(true);
  });
});
