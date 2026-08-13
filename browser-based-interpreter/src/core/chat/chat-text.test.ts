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
import { type ImageAttachment } from "../runtime/protocol";
import { agentInitial, selfDescription, userContent } from "./chat-text";

const first: ImageAttachment = { name: "one.png", data: "first", mediaType: "image/png" };
const second: ImageAttachment = { name: "two.jpg", data: "second", mediaType: "image/jpeg" };

describe("userContent", () => {
  it.each(["", " \n\t", " hello ", "සිංහල 🦀", "a\r\nb"])("preserves text without images: %j", (text) => {
    expect(userContent(text)).toBe(text);
    expect(userContent(text, [])).toBe(text);
  });

  it("preserves text and image order, but omits UI-only filenames", () => {
    expect(userContent(" hello ", [first, second])).toEqual([
      { type: "text", text: " hello " },
      { type: "image", image: "first", mediaType: "image/png" },
      { type: "image", image: "second", mediaType: "image/jpeg" },
    ]);
  });

  it.each(["", " \n\t", "\u00a0"])("omits blank text only when images are present: %j", (text) => {
    expect(userContent(text, [first])).toEqual([{ type: "image", image: "first", mediaType: "image/png" }]);
  });

  it("does not mutate or retain an image object from the UI", () => {
    const images = [Object.freeze({ ...first })];
    Object.freeze(images);
    const result = userContent("hello", images);
    expect(images).toEqual([first]);
    expect(Array.isArray(result) && result[1]).not.toBe(images[0]);
  });
});

describe("selfDescription", () => {
  it("prefers what the author wrote", () => {
    expect(selfDescription("I answer questions about beans.", "You work the counter.")).toBe(
      "I answer questions about beans.",
    );
  });

  it("turns the role around when there is no description", () => {
    expect(selfDescription("", "You are a helpful assistant. You never guess.")).toBe("I am a helpful assistant.");
  });

  it("swaps the pronouns inside the sentence too", () => {
    expect(selfDescription("", "You know your beans.")).toBe("I know my beans.");
  });

  it("says nothing rather than something empty", () => {
    expect(selfDescription("  ", "   ")).toBe("");
  });
});

describe("agentInitial", () => {
  it("takes the first letter of the name", () => {
    expect(agentInitial("Roastery Helper")).toBe("R");
  });

  it("skips punctuation", () => {
    expect(agentInitial("  ~ nightly build")).toBe("N");
  });

  it("falls back when there is no name", () => {
    expect(agentInitial("")).toBe("A");
    expect(agentInitial("---")).toBe("A");
  });
});
