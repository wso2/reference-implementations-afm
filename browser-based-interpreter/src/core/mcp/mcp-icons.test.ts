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

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIRECTORY_ENTRIES } from "./mcp-directory";
import { serverIcon } from "./mcp-servers";

const dir = new URL("../../../public/mcp-icons/", import.meta.url);
const file = (name: string) => new URL(name, dir);
const PNG_SIGNATURE = "89504e470d0a1a0a";
const MAX_BYTES = 40_000;

describe("the server icons", () => {
  it("has a PNG for every server in the directory", () => {
    const missing = DIRECTORY_ENTRIES.filter((entry) => !existsSync(file(`${entry.id}.png`)));
    expect(missing.map((entry) => entry.id)).toEqual([]);
  });

  it("is a real 96 by 96 PNG each time, not a page or another format saved under the name", () => {
    const wrong = DIRECTORY_ENTRIES.filter((entry) => {
      const bytes = readFileSync(file(`${entry.id}.png`));
      const isPng = bytes.subarray(0, 8).toString("hex") === PNG_SIGNATURE;
      return !isPng || bytes.readUInt32BE(16) !== 96 || bytes.readUInt32BE(20) !== 96;
    });
    expect(wrong.map((entry) => entry.id)).toEqual([]);
  });

  it("is small enough that the directory opens quickly", () => {
    const heavy = DIRECTORY_ENTRIES.filter((entry) => readFileSync(file(`${entry.id}.png`)).length > MAX_BYTES);
    expect(heavy.map((entry) => entry.id)).toEqual([]);
  });

  it("says in SOURCES.md where each one came from", () => {
    const sources = readFileSync(file("SOURCES.md"), "utf8");
    const unsourced = DIRECTORY_ENTRIES.filter((entry) => !sources.includes(`\`${entry.id}.png\``));
    expect(unsourced.map((entry) => entry.id)).toEqual([]);
  });
});

describe("serverIcon", () => {
  it("finds the icon of a server in the directory by its address", () => {
    expect(serverIcon("https://mcp.linear.app/mcp")).toBe("/mcp-icons/linear.png");
  });

  it("finds an icon for every address the directory lists", () => {
    const none = DIRECTORY_ENTRIES.filter((entry) => serverIcon(entry.url) !== `/mcp-icons/${entry.id}.png`);
    expect(none.map((entry) => entry.id)).toEqual([]);
  });

  it("has none for an address the directory does not list", () => {
    expect(serverIcon("https://mcp.example.com/mcp")).toBeUndefined();
  });

  it("has none for the listed address with something added, so a different server never borrows a logo", () => {
    expect(serverIcon("https://mcp.linear.app/mcp/")).toBeUndefined();
    expect(serverIcon("https://mcp.linear.app/mcp?x=1")).toBeUndefined();
  });

  it("has none when there is no address", () => {
    expect(serverIcon(undefined)).toBeUndefined();
  });
});
