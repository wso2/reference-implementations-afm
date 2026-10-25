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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmNote } from "./ConfirmNote";

const note = (align?: "start" | "end") =>
  renderToStaticMarkup(
    createElement(ConfirmNote, {
      title: "Forget this key?",
      text: "OPENAI_API_KEY will be removed.",
      secondary: { label: "Cancel", onPick: () => {} },
      primary: { label: "Forget", onPick: () => {} },
      focus: "secondary",
      onDismiss: () => {},
      wrap: { current: null },
      align,
    }),
  );

describe("the confirmation box", () => {
  const html = note();

  it("is a dialog named by its title, with the question and a short line under it", () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Forget this key?"');
    expect(html).toContain("<b>Forget this key?</b>");
    expect(html).toContain("<p>OPENAI_API_KEY will be removed.</p>");
  });

  it("puts the quiet choice first and the main choice last", () => {
    expect(html).toMatch(/class="u-btn ghost sm">Cancel<\/button><button class="u-btn primary sm">Forget</);
  });

  it("opens under its button, or lines up with the end of it", () => {
    expect(html).not.toContain("is-end");
    expect(note("end")).toContain("u-confirm is-end");
  });
});
