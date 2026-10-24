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
import type { AgentMetadata } from "@afm/engine";
import { InfoPanel } from "./InfoPanel";

describe("the About panel", () => {
  const metadata = {
    name: "Paper Navigator",
    description: "Reads a paper and answers questions about it.",
  } as AgentMetadata;
  const panel = (over: { metadata?: AgentMetadata | null } = {}) =>
    renderToStaticMarkup(
      createElement(InfoPanel, {
        content: "",
        metadata: over.metadata === undefined ? metadata : over.metadata,
        saved: undefined,
        onApply: () => {},
        onClose: () => {},
      }),
    );

  it("gives the description a label of its own, with the file's text in it", () => {
    const html = panel();
    expect(html).toContain(">Description</label>");
    expect(html).toContain("Reads a paper and answers questions about it.");
  });

  it("says where the description is shown, and what happens when it is left empty", () => {
    expect(panel()).toContain("Shown at the top of a new chat. Left empty, it is drawn from the role.");
  });

  it("ties the hint to the field for people who use a screen reader", () => {
    const html = panel();
    const id = /<textarea id="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeDefined();
    expect(html).toContain(`aria-describedby="${id}-hint"`);
    expect(html).toContain(`id="${id}-hint"`);
  });

  it("has no favourite button", () => {
    expect(panel().toLowerCase()).not.toContain("favorite");
    expect(panel().toLowerCase()).not.toContain("favourite");
  });

  it("locks the description when the settings cannot be read", () => {
    const html = panel({ metadata: null });
    expect(html).toContain("is-off");
    expect(html).toMatch(/<textarea[^>]*disabled/);
  });
});
