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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SECRET_INPUT } from "./inputs";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return pages(full);
    return /\.tsx$/.test(entry) && !/\.test\.tsx$/.test(entry) ? [full] : [];
  });
}

describe("the hints on a box that holds a key", () => {
  it("name the value that browsers honour, and the three common password managers", () => {
    expect(SECRET_INPUT.autoComplete).toBe("new-password");
    expect(SECRET_INPUT["data-1p-ignore"]).toBe(true);
    expect(SECRET_INPUT["data-lpignore"]).toBe("true");
    expect(SECRET_INPUT["data-bwignore"]).toBe("true");
    expect(SECRET_INPUT["data-form-type"]).toBe("other");
    expect(SECRET_INPUT.spellCheck).toBe(false);
  });

  it("are on every password box in the app", () => {
    const missing: string[] = [];
    for (const file of pages(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, at) => {
        if (
          line.includes('type="password"') &&
          !lines.slice(at, at + 3).some((near) => near.includes("{...SECRET_INPUT}"))
        ) {
          missing.push(`${relative(SRC, file)}:${at + 1}`);
        }
      });
    }
    expect(missing).toEqual([]);
  });
});
