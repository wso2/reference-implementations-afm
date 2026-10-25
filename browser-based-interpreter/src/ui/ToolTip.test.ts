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
import { tipFor, tipPosition, shorten } from "./ToolTip";

const row = { top: 300, left: 1240, height: 32 };

describe("placing the description bubble", () => {
  it("sits level with the middle of the row it belongs to", () => {
    expect(tipPosition(tipFor("ask_question", "Ask anything.", row)).top).toBe(316);
  });

  it("opens to the left of the row, clear of its edge", () => {
    expect(tipPosition(tipFor("ask_question", "Ask anything.", row)).left).toBe(1228);
  });

  it("carries the tool's name and its own words", () => {
    const tip = tipFor("read_wiki_contents", "View documentation.", row);
    expect(tip.title).toBe("read_wiki_contents");
    expect(tip.body).toBe("View documentation.");
  });
});

describe("keeping the bubble a bubble", () => {
  it("leaves a short description alone", () => {
    expect(shorten("Search the web.")).toBe("Search the web.");
  });

  it("cuts a very long one and says there is more", () => {
    const long = `Resolves a name. ${"and more detail ".repeat(60)}`;
    const out = shorten(long);
    expect(out.length).toBeLessThanOrEqual(261);
    expect(out.endsWith("…")).toBe(true);
  });

  it("never breaks in the middle of a word", () => {
    const out = shorten("word ".repeat(200));
    expect(out).not.toMatch(/wor…$/);
    expect(
      out
        .replace("…", "")
        .trim()
        .split(" ")
        .every((w) => w === "word"),
    ).toBe(true);
  });

  it("does not leave a stray comma before the mark", () => {
    expect(shorten(`${"alpha, ".repeat(60)}`)).not.toMatch(/[,;:]…$/);
  });
});
