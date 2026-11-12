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

import type { AgentMetadata } from "@afm/engine";
import { describe, expect, it } from "vitest";
import { aboutRows, applyAbout, startingDraft, versionError } from "./about";
import { buildableAgent } from "./agent-validation";

const value = (rows: ReturnType<typeof aboutRows>, label: string) => rows.find((row) => row.label === label)?.value;

describe("aboutRows", () => {
  it("identifies editable fields without deriving keys from display labels", () => {
    expect(aboutRows(null).map(({ field, label }) => [field, label])).toEqual([
      ["version", "Version"],
      ["authors", "Authors"],
      ["provider", "Provider"],
      ["license", "License"],
    ]);
  });

  it("has nothing to show when the settings cannot be read", () => {
    expect(aboutRows(null).map((row) => row.value)).toEqual([null, null, null, null]);
  });

  it("reads each detail from the file", () => {
    const metadata = {
      name: "A",
      version: "1.2.0",
      authors: ["Ada", "Lin"],
      provider: { name: "Example Co", url: "https://example.com" },
      license: "Apache-2.0",
    } as AgentMetadata;
    const rows = aboutRows(metadata);
    expect(value(rows, "Version")).toBe("1.2.0");
    expect(value(rows, "Authors")).toBe("Ada, Lin");
    expect(value(rows, "Provider")).toBe("Example Co");
    expect(value(rows, "License")).toBe("Apache-2.0");
  });

  it("falls back to the provider's host when it has no name", () => {
    const metadata = { name: "A", provider: { url: "https://example.com/about" } } as AgentMetadata;
    expect(value(aboutRows(metadata), "Provider")).toBe("example.com");
  });

  it("counts blank or empty details as not set", () => {
    const metadata = { name: "A", version: "  ", authors: [], license: "" } as AgentMetadata;
    expect(aboutRows(metadata).map((row) => row.value)).toEqual([null, null, null, null]);
  });
});

describe("editing the details", () => {
  const FILE = `---
name: Paper Navigator
description: Reads papers
version: "1.0.0"
authors:
  - Ada
provider:
  name: Example Co
  url: https://example.com
license: MIT
model:
  provider: openai
  name: gpt-4o
---

# Role
r
`;

  function edit(change: Partial<ReturnType<typeof startingDraft>>, providerUrl = "https://example.com") {
    const metadata = {
      name: "Paper Navigator",
      description: "Reads papers",
      version: "1.0.0",
      authors: ["Ada"],
      provider: { name: "Example Co", url: providerUrl },
      license: "MIT",
    } as AgentMetadata;
    const start = startingDraft(metadata);
    return applyAbout(FILE, start, { ...start, ...change }, providerUrl);
  }

  it("starts from what the file says, blank where it says nothing", () => {
    expect(startingDraft(null)).toEqual({
      name: "",
      description: "",
      icon: "",
      version: "",
      authors: "",
      provider: "",
      license: "",
    });
    expect(startingDraft({ name: "A", icon_url: "https://x.example/i.png", version: "2.0.0" })).toMatchObject({
      name: "A",
      icon: "https://x.example/i.png",
      version: "2.0.0",
    });
  });

  it("leaves the file untouched when nothing was edited", () => {
    expect(edit({})).toBe(FILE);
  });

  it("writes the name, icon and version under the keys the spec defines", () => {
    const next = edit({ name: "Paper Guide", icon: "https://x.example/i.png", version: "1.1.0" });
    const read = buildableAgent(next);
    expect(read.ok && read.metadata.name).toBe("Paper Guide");
    expect(read.ok && read.metadata.icon_url).toBe("https://x.example/i.png");
    expect(read.ok && read.metadata.version).toBe("1.1.0");
    expect(next).toContain("version: 1.1.0");
  });

  it("changes one detail without touching the others", () => {
    const next = edit({ license: "Apache-2.0" });
    expect(next).toBe(FILE.replace("license: MIT", "license: Apache-2.0"));
  });

  it("writes the authors as a list and keeps the provider's link when the name changes", () => {
    const next = edit({ authors: "Ada, Grace , ", provider: "Other Co" });
    const read = buildableAgent(next);
    expect(read.ok && read.metadata.authors).toEqual(["Ada", "Grace"]);
    expect(read.ok && read.metadata.provider).toEqual({ name: "Other Co", url: "https://example.com" });
  });

  it("removes a detail that was cleared", () => {
    const next = edit({ icon: "", license: "" });
    expect(next).not.toContain("icon_url");
    expect(next).not.toContain("license");
  });
});

describe("versionError", () => {
  it("accepts a blank version and semantic versions", () => {
    for (const ok of ["", "  ", "0.0.0", "1.2.3", "1.0.0-beta.1", "2.0.0+build.5"]) expect(versionError(ok)).toBeNull();
  });

  it("says what shape is expected otherwise", () => {
    for (const bad of ["1", "1.0", "v1.0.0", "one", "1.0.0.0"])
      expect(versionError(bad)).toMatch(/MAJOR\.MINOR\.PATCH/);
  });
});
