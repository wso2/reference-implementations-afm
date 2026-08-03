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
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("index.html", () => {
  it("sends no referrer with anything the page requests", () => {
    const html = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
  });

  it("names an icon in each format, and every one of them is shipped", () => {
    const html = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");
    const icons = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="\/([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(icons).toEqual(["favicon.svg"]);
    for (const icon of icons) {
      expect(existsSync(fileURLToPath(new URL(`./public/${icon}`, import.meta.url)))).toBe(true);
    }
  });
});
