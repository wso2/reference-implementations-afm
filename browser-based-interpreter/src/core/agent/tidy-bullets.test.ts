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

import { describe, expect, it } from "vitest";
import { canTidy, sentences, tidyIntoBullets } from "./tidy-bullets";

describe("finding where the sentences end", () => {
  it("splits on full stops, questions and exclamations", () => {
    expect(sentences("One. Two? Three!")).toEqual(["One.", "Two?", "Three!"]);
  });

  it("does not split on an abbreviation", () => {
    expect(sentences("Use short words, e.g. this one. Then stop.")).toEqual([
      "Use short words, e.g. this one.",
      "Then stop.",
    ]);
  });

  it("does not split on a numbered point", () => {
    expect(sentences("Do 1. this and 2. that.")).toEqual(["Do 1. this and 2. that."]);
  });
});

describe("tidying a paragraph into bullets", () => {
  it("gives every sentence its own bullet", () => {
    expect(tidyIntoBullets("Be brief. Cite sources. Ask when unsure.")).toBe(
      "- Be brief.\n- Cite sources.\n- Ask when unsure.",
    );
  });

  it("never changes a single word", () => {
    const before = "Answer clearly and keep replies short. Always say where you found it.";
    const after = tidyIntoBullets(before);
    const words = (text: string) => text.replace(/^-\s+/gm, "").replace(/\s+/g, " ").trim();
    expect(words(after)).toBe(words(before));
  });

  it("leaves a single sentence as a sentence", () => {
    expect(tidyIntoBullets("Answer clearly.")).toBe("Answer clearly.");
  });

  it("leaves headings, quotes and existing lists alone", () => {
    const already = "## Tone\n\n- one\n- two\n\n> a quote";
    expect(tidyIntoBullets(already)).toBe(already);
  });

  it("tidies the paragraphs and keeps the rest, in place", () => {
    expect(tidyIntoBullets("## Tone\n\nBe brief. Be kind.\n\n- keep this")).toBe(
      "## Tone\n\n- Be brief.\n- Be kind.\n\n- keep this",
    );
  });

  it("joins a paragraph that was wrapped over several lines", () => {
    expect(tidyIntoBullets("Be brief.\nBe kind.")).toBe("- Be brief.\n- Be kind.");
  });

  it("does nothing to an empty field", () => {
    expect(tidyIntoBullets("")).toBe("");
  });

  it("leaves a table alone, written with or without outer pipes", () => {
    const table = "| Scenario | Behavior |\n| --- | --- |\n| Signed out. | Ask for the date. Be brief. |";
    expect(tidyIntoBullets(table)).toBe(table);
    const bare = "Scenario | Behavior\n--- | ---\nA. | B. Be brief.";
    expect(tidyIntoBullets(bare)).toBe(bare);
  });

  it("leaves a code block alone, even one with an empty line inside", () => {
    const code = "```\nrun this. then that.\n\nand this. and more.\n```";
    expect(tidyIntoBullets(code)).toBe(code);
    expect(tidyIntoBullets(`Be brief. Be kind.\n\n${code}`)).toBe(`- Be brief.\n- Be kind.\n\n${code}`);
  });

  it("leaves a rule and a plus or bracket list alone", () => {
    expect(tidyIntoBullets("Be brief. Be kind.\n\n---\n\nBe calm. Be clear.")).toBe(
      "- Be brief.\n- Be kind.\n\n---\n\n- Be calm.\n- Be clear.",
    );
    expect(tidyIntoBullets("+ Be brief. Be kind.")).toBe("+ Be brief. Be kind.");
    expect(tidyIntoBullets("1) Be brief. Be kind.")).toBe("1) Be brief. Be kind.");
  });

  it("is settled after one press", () => {
    const once = tidyIntoBullets("Be brief. Be kind.");
    expect(tidyIntoBullets(once)).toBe(once);
    expect(canTidy(once)).toBe(false);
  });

  it("knows when there is something to do", () => {
    expect(canTidy("Be brief. Be kind.")).toBe(true);
    expect(canTidy("- Be brief.\n- Be kind.")).toBe(false);
  });
});

describe("lines that are mostly spaces", () => {
  const spaces = " ".repeat(200_000);

  it("decide in a moment whether a block can be tidied, when a line is a long run of spaces", () => {
    const started = Date.now();
    expect(canTidy(`${spaces}x`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("still leave a table's rule line alone", () => {
    expect(tidyIntoBullets("| a | b |\n| --- | :---: |\n| 1 | 2 |")).toBe("| a | b |\n| --- | :---: |\n| 1 | 2 |");
    expect(tidyIntoBullets("a | b\n- | -\n1 | 2")).toBe("a | b\n- | -\n1 | 2");
  });
});
