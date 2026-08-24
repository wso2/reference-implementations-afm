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

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { attachFeedback, Composer } from "./Composer";

const composer = (disabled: boolean) =>
  renderToStaticMarkup(
    createElement(Composer, {
      onSend: () => {},
      onStop: () => {},
      streaming: false,
      disabled,
    }),
  );

describe("the message box", () => {
  it("has a name of its own, whatever the hint inside it says", () => {
    for (const disabled of [false, true]) {
      expect(composer(disabled)).toMatch(/<textarea[^>]*aria-label="Message the agent"/);
    }
  });
});

describe("the image box behind the Attach button", () => {
  const inputs = composer(false).match(/<input[^>]*type="file"[^>]*>/g) ?? [];

  it("is one, and invisible, and takes images only", () => {
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain("image/png");
    expect(inputs[0]).not.toContain(".pdf");
  });

  it("stay out of the Tab order and away from screen readers", () => {
    for (const input of inputs) {
      expect(input).toContain('tabindex="-1"');
      expect(input).toContain('aria-hidden="true"');
    }
  });
});

describe("the line about attached images", () => {
  it("is always there for a screen reader to speak into, and hidden from sight until it has something to say", () => {
    const html = composer(false);
    expect(html).toContain('<span class="visually-hidden" role="status"></span>');
    expect(html).not.toContain("composer-attach-status");
  });
});

describe("what the message box says after images are added", () => {
  it("says nothing when nothing was added or skipped", () => {
    expect(attachFeedback([], [])).toBeNull();
  });

  it("names the images that were attached", () => {
    expect(attachFeedback(["notes.png", "plan.png"], [])).toBe("Attached notes.png, plan.png.");
  });

  it("names a skipped image and gives the reason", () => {
    expect(attachFeedback([], [{ name: "big.png", reason: "is larger than 8 MB" }])).toBe("big.png is larger than 8 MB.");
  });

  it("does not end a sentence with two full stops", () => {
    expect(attachFeedback([], [{ name: "x.png", reason: "is not a supported image type." }])).toBe(
      "x.png is not a supported image type.",
    );
  });

  it("says what was attached and what was not", () => {
    expect(
      attachFeedback(["a.png"], [{ name: "notes.txt", reason: "is not a supported image type (PNG, JPEG, WEBP, or GIF)" }]),
    ).toBe("Attached a.png. notes.txt is not a supported image type (PNG, JPEG, WEBP, or GIF).");
  });

  it("keeps a long list short", () => {
    expect(attachFeedback(["a", "b", "c", "d", "e"], [])).toBe("Attached a, b, c and 2 more.");
    const skipped = ["1", "2", "3", "4"].map((name) => ({ name, reason: "is too big" }));
    expect(attachFeedback([], skipped)).toBe("1 is too big. 2 is too big. 2 more skipped.");
  });
});
