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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL(".", import.meta.url));
const ALLOWED = new Set<string>();
const SINK =
  /\.(?:inner|outer)HTML\s*[+\-*/]?=|dangerouslySetInnerHTML|insertAdjacentHTML|document\.write\(|(?:^|[^a-zA-Z0-9_.])eval\(|new Function\(/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("no new raw-HTML or eval sink", () => {
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file).split("\\").join("/");
    it(`${rel} stays clean`, () => {
      const hit = SINK.test(readFileSync(file, "utf8"));
      expect(hit && !ALLOWED.has(rel)).toBe(false);
    });
  }

  it("the allowlist itself still points at a real sink", () => {
    for (const rel of ALLOWED) {
      expect(SINK.test(readFileSync(join(SRC, rel), "utf8"))).toBe(true);
    }
  });
});
