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
import { BuildPane } from "./BuildPane";
import { TrustScreen } from "../setup/TrustScreen";
import { displayName, rowLabel } from "../../core/setup/setup-check";

const metadata = (names: string[]) =>
  ({
    name: "A",
    model: { provider: "openai", name: "gpt-4o" },
    tools: {
      mcp: names.map((name) => ({ name, transport: { type: "http", url: `https://${name}.example.com/mcp` } })),
    },
  }) as AgentMetadata;

const rail = (names: string[], model = true) =>
  renderToStaticMarkup(
    createElement(BuildPane, {
      content: "---\nname: A\n---\n\n# Role\nr\n\n# Instructions\ni\n",
      onChange: () => {},
      metadata: model ? metadata(names) : { ...metadata(names), model: undefined },
      onOpenModel: () => {},
      onOpenServer: () => {},
      activity: { phase: "idle", brokenServerIds: [], modelBroken: false },
      reach: { ok: [], failed: {} },
    }),
  );

describe("how a tool server's name is written", () => {
  it("starts with a capital letter and keeps the rest as it was", () => {
    expect(displayName("notion")).toBe("Notion");
    expect(displayName("githubcopilot")).toBe("Githubcopilot");
    expect(displayName("DeepWiki")).toBe("DeepWiki");
    expect(displayName("")).toBe("");
  });

  it("is used for a server's row in Setup, and not for the model's", () => {
    expect(rowLabel({ kind: "server", name: "exa" })).toBe("Exa");
    expect(rowLabel({ kind: "model", name: "GPT-4o" })).toBe("GPT-4o");
  });

  it("is used for each tool box beside the editor", () => {
    const html = rail(["notion", "ai", "canva"]);
    for (const name of ["Notion", "Ai", "Canva"]) expect(html).toContain(`<span class="u-node-name">${name}</span>`);
    expect(html).not.toMatch(/u-node-name">(notion|ai|canva)</);
  });

  it("starts the small lines under the names with a capital too", () => {
    expect(rail(["notion"])).toContain("All tools");
    expect(rail(["notion"], false)).not.toContain("Choose one");
    expect(rail(["notion"])).not.toMatch(/>(all tools|choose one|no answer)</);
  });

  it("shows a model box with no model like the Connect tools box, with only Choose a model on it", () => {
    const html = rail([], false);
    expect(html).toContain("Choose a model</button>");
    expect(html).toContain("Connect tools</button>");
    expect(html.match(/<button class="u-node add"/g)).toHaveLength(2);
    expect(html).not.toContain("Required");
  });

  it("is used in the list a shared agent shows before it runs", () => {
    const html = renderToStaticMarkup(
      createElement(TrustScreen, {
        metadata: metadata(["notion"]),
        source: "---\nname: A\n---\n",
        savedSecrets: [],
        fileUrl: null,
        onRun: () => {},
        onOpenBuilder: () => {},
      }),
    );
    expect(html).toContain("Notion");
    expect(html).not.toMatch(/>notion</);
  });
});
