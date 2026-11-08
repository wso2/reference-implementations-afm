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


import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));

describe("the interpreter stays independent of its host", () => {
  it.each(["packages/engine/src/index.ts", "packages/runtime/src/index.ts"])("builds %s for a page, so no Node.js module is needed", async (entry) => {
    const result = await build({ entryPoints: [join(root, entry)], bundle: true, platform: "browser", write: false, logLevel: "silent" });
    expect(result.errors).toEqual([]);
  });

  it("never names the page it might run in, in source, tests, documents or settings", async () => {
    const skipped = ["node_modules", "dist", "pnpm-lock.yaml", "guards.test.ts"];
    const found: string[] = [];
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (skipped.includes(entry.name)) continue;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && /browser/i.test(await readFile(path, "utf-8"))) found.push(path.slice(root.length));
      }
    };
    await walk(root);
    expect(found).toEqual([]);
  });
});
