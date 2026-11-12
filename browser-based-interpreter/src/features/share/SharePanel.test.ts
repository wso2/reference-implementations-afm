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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentMetadata } from "@afm/engine";
import { keyNoticeKind, SharePanel, shareChecks } from "./SharePanel";

const done = (checks: ReturnType<typeof shareChecks>) =>
  checks.filter((check) => check.done).map((check) => check.label);

describe("shareChecks", () => {
  it("has nothing done for an empty file", () => {
    expect(done(shareChecks(null))).toEqual([]);
  });

  it("marks each detail the file already gives", () => {
    const metadata = {
      description: "Reads papers",
      icon_url: "https://example.com/i.png",
      version: "1.0.0",
      authors: ["Ada"],
      provider: { name: "Example Co" },
      license: "MIT",
    } as AgentMetadata;
    expect(done(shareChecks(metadata))).toHaveLength(6);
  });

  it("counts blank details as missing", () => {
    const metadata = { description: "  ", authors: [], license: "", provider: {} } as AgentMetadata;
    expect(done(shareChecks(metadata))).toEqual([]);
  });
});

describe("the share panel", () => {
  const file = (apiKey: string) => `---
name: Demo
model:
  provider: openai
  authentication:
    type: api-key
    api_key: ${apiKey}
---

# Role
r

# Instructions
i
`;
  const panel = (agentSource: string) => renderToStaticMarkup(createElement(SharePanel, { agentSource }));

  beforeEach(() => vi.stubGlobal("window", { location: { origin: "https://afm.example" } }));
  afterEach(() => vi.unstubAllGlobals());

  it("warns about a key written into the file, because anyone with the link can read it", () => {
    const html = panel(file("sk-typed-in"));
    expect(html).toContain("This file has a key written into it (api_key), and anyone with the link can read it.");
    expect(html).not.toContain("keys saved in this app are never included");
  });

  it("opens on the recommended way, with a link ready to copy", () => {
    const html = panel(file("\${env:OPENAI_API_KEY}"));
    expect(html).toMatch(/class="on" aria-pressed="true">In the link</);
    expect(html).toContain("https://afm.example/?view=chat#afm=");
    expect(html).not.toContain("Add the file&#x27;s address above to get a link.");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Copy link/);
  });

  it("says no key is included when the file only refers to one", () => {
    const html = panel(file("\${env:OPENAI_API_KEY}"));
    expect(html).toContain("No key is written into the settings, and keys saved in this app are never included.");
    expect(html).not.toContain("written into it");
  });
});

describe("what the share panel says about keys", () => {
  it("names a key written into the file before anything else", () => {
    expect(keyNoticeKind(true, ["api_key"], false)).toBe("written");
    expect(keyNoticeKind(false, ["api_key"], true)).toBe("written");
  });

  it("does not call a file clean when it could not be checked", () => {
    expect(keyNoticeKind(false, [], false)).toBe("unchecked");
    expect(keyNoticeKind(false, [], true)).toBe("unchecked");
  });

  it("does not promise anything about a file that is hosted somewhere else", () => {
    expect(keyNoticeKind(true, [], true)).toBe("hosted");
    expect(keyNoticeKind(true, [], false)).toBe("clean");
  });

  it("shows the unchecked notice, not the promise, for settings that cannot be read", () => {
    vi.stubGlobal("window", { location: { origin: "https://afm.example" } });
    try {
      const html = renderToStaticMarkup(
        createElement(SharePanel, { agentSource: "---\nname: [not closed\napi_key: sk-live-1\n---\n\n# Role\nr\n" }),
      );
      expect(html).toContain("This file could not be checked for keys.");
      expect(html).not.toContain("keys saved in this app are never included");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
