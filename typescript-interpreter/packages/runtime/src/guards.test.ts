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


import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packages = fileURLToPath(new URL("../..", import.meta.url));

async function engineFiles(): Promise<string[]> {
  const folder = join(packages, "engine/src");
  return (await readdir(folder)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts")).map((name) => join(folder, name));
}

describe("the library files", () => {
  it("import no Node.js module, so the packages can be used as libraries anywhere JavaScript runs", async () => {
    const runtime = ["index", "run", "mcp", "model", "auth-headers"].map((name) => join(packages, `runtime/src/${name}.ts`));
    const importing: string[] = [];
    for (const file of [...(await engineFiles()), ...runtime]) {
      if (/from "node:/.test(await readFile(file, "utf-8"))) importing.push(file.slice(packages.length));
    }
    expect(importing).toEqual([]);
  });
});
