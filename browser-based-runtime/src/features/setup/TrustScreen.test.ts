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
import type { AgentMetadata } from "@afm/engine";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TRUST_COPY,
  TrustScreen,
  countLine,
  filterTools,
  isListed,
  linkedFileHost,
  serverTools,
  toolCount,
  withTicks,
} from "./TrustScreen";

const withServers = (mcp: unknown[]) => ({ name: "A", tools: { mcp } }) as AgentMetadata;

describe("serverTools", () => {
  it("is empty when the file names no servers", () => {
    expect(serverTools({ name: "A" })).toEqual([]);
  });

  it("names each server with the host it talks to", () => {
    const metadata = withServers([
      { name: "notes", transport: { type: "http", url: "https://mcp.example.com/mcp" } },
      { name: "stock", transport: { type: "http", url: "https://sheets.example.org/v1" } },
    ]);
    expect(serverTools(metadata).map(({ name, host }) => [name, host])).toEqual([
      ["notes", "mcp.example.com"],
      ["stock", "sheets.example.org"],
    ]);
  });

  it("lists every tool the file allows to run without asking", () => {
    const metadata = withServers([
      {
        name: "notes",
        transport: { type: "http", url: "https://mcp.example.com/mcp" },
        tool_filter: { allow: ["a", "b"] },
      },
      {
        name: "stock",
        transport: { type: "http", url: "https://sheets.example.org/v1" },
        tool_filter: { allow: ["c"], deny: ["d"] },
      },
    ]);
    expect(serverTools(metadata).map(({ tools }) => tools)).toEqual([["a", "b"], ["c"]]);
  });

  it("lists no tools for a server whose file allows none", () => {
    const metadata = withServers([
      { name: "notes", transport: { type: "http", url: "https://mcp.example.com/mcp" } },
      {
        name: "stock",
        transport: { type: "http", url: "https://sheets.example.org/v1" },
        tool_filter: { deny: ["d"] },
      },
    ]);
    expect(serverTools(metadata).map(({ tools }) => tools)).toEqual([[], []]);
  });

  it("has no host for a server that is not reached over http", () => {
    const metadata = withServers([{ name: "local", transport: { type: "stdio", command: "run" } }]);
    expect(serverTools(metadata)).toEqual([{ name: "local", url: null, host: null, tools: [] }]);
  });
});

describe("linkedFileHost", () => {
  it("is the host a ?file= link points at, with its port", () => {
    expect(linkedFileHost("https://files.example.com/a/b.afm.md")).toBe("files.example.com");
    expect(linkedFileHost("https://files.example.com:8443/a.afm.md")).toBe("files.example.com:8443");
  });

  it("is nothing when the agent did not come from a ?file= link", () => {
    expect(linkedFileHost(null)).toBeNull();
  });

  it("is nothing for a link that is not an https address", () => {
    expect(linkedFileHost("http://files.example.com/a.afm.md")).toBeNull();
    expect(linkedFileHost("not a url")).toBeNull();
  });
});

const TOOLS = ["notion-search", "notion-fetch", "notion-create-pages", "notion-update-page"];

const SOURCE = `---
name: Interview partner
model:
  provider: openai
  name: gpt-6.1-sol
  authentication:
    type: api-key
    api_key: \${env:OPENAI_API_KEY}
---

# Role
r
`;

const agent = (servers: unknown[], extra: Record<string, unknown> = {}) =>
  ({
    name: "Interview partner",
    model: { provider: "openai", name: "gpt-6.1-sol" },
    tools: { mcp: servers },
    ...extra,
  }) as AgentMetadata;

const notion = {
  name: "notion",
  transport: { type: "http", url: "https://mcp.notion.com/mcp" },
  tool_filter: { allow: TOOLS },
};

function screen(
  options: {
    servers?: unknown[];
    savedSecrets?: string[];
    fileUrl?: string | null;
    initialStep?: "run" | "builder" | null;
    canRun?: boolean;
    source?: string;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(TrustScreen, {
      metadata: agent(options.servers ?? [notion]),
      source: options.source ?? SOURCE,
      savedSecrets: options.savedSecrets ?? [],
      fileUrl: options.fileUrl ?? null,
      onRun: () => {},
      onOpenBuilder: () => {},
      initialStep: options.initialStep ?? null,
      canRun: options.canRun ?? true,
    }),
  );
}

describe("filterTools", () => {
  it("keeps every tool for an empty or blank search", () => {
    expect(filterTools(TOOLS, "")).toEqual(TOOLS);
    expect(filterTools(TOOLS, "   ")).toEqual(TOOLS);
  });

  it("keeps the tools whose name has the word in it, whatever its case", () => {
    expect(filterTools(TOOLS, "PAGE")).toEqual(["notion-create-pages", "notion-update-page"]);
  });

  it("keeps none when nothing matches", () => {
    expect(filterTools(TOOLS, "calendar")).toEqual([]);
  });
});

describe("countLine", () => {
  it("says none run without asking, and that all ask first, when nothing is ticked", () => {
    expect(countLine(0, 17)).toBe("None run without asking · all 17 ask first");
  });

  it("says how many of the listed tools run without asking once some are ticked", () => {
    expect(countLine(6, 17)).toBe("6 of 17 run without asking");
    expect(countLine(1, 1)).toBe("1 of 1 run without asking");
  });
});

describe("withTicks", () => {
  it("adds the keys and leaves the others, without changing the set it was given", () => {
    const before = new Set(["a"]);
    const after = withTicks(before, ["b", "c"], true);
    expect([...after]).toEqual(["a", "b", "c"]);
    expect([...before]).toEqual(["a"]);
  });

  it("removes only the keys it is given", () => {
    expect([...withTicks(new Set(["a", "b", "c"]), ["b", "x"], false)]).toEqual(["a", "c"]);
  });
});

describe("isListed", () => {
  it("is true only for a server reached over http that lists tools", () => {
    expect(isListed({ name: "n", url: "https://x.example/mcp", host: "x.example", tools: ["a"] })).toBe(true);
    expect(isListed({ name: "n", url: "https://x.example/mcp", host: "x.example", tools: [] })).toBe(false);
    expect(isListed({ name: "n", url: null, host: null, tools: ["a"] })).toBe(false);
  });
});

describe("toolCount", () => {
  it("says tool once and tools otherwise", () => {
    expect(toolCount(1)).toBe("1 tool");
    expect(toolCount(0)).toBe("0 tools");
    expect(toolCount(38)).toBe("38 tools");
  });
});

describe("the window a shared agent opens in", () => {
  it("is a dialog named by the agent, with the sentence that says what it is", () => {
    const html = screen();
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Interview partner");
    expect(html).toContain(TRUST_COPY.lead);
  });

  it("shows the model with its provider written properly", () => {
    const html = screen();
    expect(html).toContain("GPT-6.1 Sol");
    expect(html).toContain("OpenAI");
    expect(html).not.toContain("· openai");
  });

  it("shows a server's tools as a plain count, not as buttons or a flood of names", () => {
    const html = screen();
    expect(html).toContain("Notion");
    expect(html).toContain("mcp.notion.com");
    expect(html).toContain("4 tools");
    expect(html).not.toContain("all ask first");
    expect(html).not.toContain("Choose tools");
    for (const tool of TOOLS) expect(html).not.toContain(tool);
  });

  it("says a server with no listed tools has none", () => {
    const html = screen({
      servers: [{ name: "github", transport: { type: "http", url: "https://api.githubcopilot.com/mcp" } }],
    });
    expect(html).toContain("No tools listed");
  });

  it("says None when the file names no server", () => {
    const html = screen({ servers: [] });
    expect(html).toContain(">None<");
    expect(html).not.toContain(TRUST_COPY.toolsNote);
  });

  it("puts the note about choosing tools under the tool servers when a server lists tools", () => {
    expect(screen()).toContain(TRUST_COPY.toolsNote);
  });

  it("says every tool asks first when no server lists tools", () => {
    const html = screen({
      servers: [{ name: "github", transport: { type: "http", url: "https://api.githubcopilot.com/mcp" } }],
    });
    expect(html).toContain(TRUST_COPY.noListNote);
    expect(html).not.toContain(TRUST_COPY.toolsNote);
  });

  it("marks a key Entered or Not entered, with the note about keys under it", () => {
    expect(screen()).toContain("Not entered");
    expect(screen()).toContain(TRUST_COPY.keysNote);
    expect(screen({ savedSecrets: ["OPENAI_API_KEY"] })).toContain(">Entered<");
    expect(screen({ savedSecrets: ["OPENAI_API_KEY"] })).not.toContain("Not entered");
  });

  it("says Nothing when the file needs no key", () => {
    const html = screen({ source: "---\nname: A\n---\n" });
    expect(html).toContain(">Nothing<");
    expect(html).not.toContain(TRUST_COPY.keysNote);
  });

  it("shows where the file came from when it was opened from a link", () => {
    expect(screen({ fileUrl: "https://raw.githubusercontent.com/a/b/agent.afm.md" })).toContain(
      "raw.githubusercontent.com",
    );
    expect(screen()).not.toContain("File from");
  });

  it("omits the step limit from the shared-agent review", () => {
    expect(screen()).not.toContain("Step limit");
    expect(screen()).not.toContain("steps per answer");
  });

  it("keeps both buttons in the footer, beside the sentence that says nothing has run", () => {
    const html = screen();
    expect(html).toContain("u-dlg-foot act");
    expect(html).toContain(TRUST_COPY.footer);
    expect(html.indexOf(">Open in builder<")).toBeGreaterThan(html.indexOf(TRUST_COPY.footer));
    expect(html.indexOf(">Run<")).toBeGreaterThan(html.indexOf(">Open in builder<"));
    expect(html).not.toContain("Run it");
    expect(html).not.toContain("disabled");
  });

  it("has no Close button and no Back link, so the two buttons are the two choices", () => {
    const html = screen();
    expect(html).not.toContain('aria-label="Close"');
    expect(html).not.toContain("u-dlg-back");
  });

  it("is a sheet from the bottom on a phone", () => {
    expect(screen()).toContain("is-sheet");
  });

  it("locks Run, and only Run, while the agent cannot run", () => {
    const html = screen({ canRun: false });
    expect(html).toMatch(/<button class="u-btn primary" disabled="">Run<\/button>/);
    expect(html).toMatch(/<button class="u-btn ghost">Open in builder<\/button>/);
  });
});

describe("the tool step", () => {
  const step = (options: Parameters<typeof screen>[0] = {}) => screen({ initialStep: "run", ...options });

  it("is titled by what it asks and says that every other tool asks first", () => {
    const html = step();
    expect(html).toContain(TRUST_COPY.stepTitle);
    expect(html).toContain(TRUST_COPY.stepSub);
    expect(html).toContain("u-dlg-back");
  });

  it("lists every tool by name, each with a tick box that starts unticked", () => {
    const html = step();
    for (const tool of TOOLS) expect(html).toContain(tool);
    expect(html.match(/type="checkbox"/g)).toHaveLength(TOOLS.length);
    expect(html).not.toContain("checked");
    expect(html).not.toContain("u-tr-name on");
  });

  it("names each server with its host and gives it a count and its own Select all and Unselect all", () => {
    const html = step({
      servers: [notion, { ...notion, name: "linear", transport: { type: "http", url: "https://mcp.linear.app/mcp" } }],
    });
    expect(html).toContain("mcp.notion.com");
    expect(html).toContain("mcp.linear.app");
    expect(html.match(/>Select all</g)).toHaveLength(2);
    expect(html.match(/>Unselect all</g)).toHaveLength(2);
    expect(html.match(/ of 4</g)).toHaveLength(2);
  });

  it("starts with Unselect all locked, because nothing is ticked, and Select all open", () => {
    const html = step();
    expect(html).toMatch(/<button class="u-btn ghost">Select all<\/button>/);
    expect(html).toMatch(/<button class="u-btn ghost" disabled="">Unselect all<\/button>/);
  });

  it("counts what runs without asking in the footer, with a dot that is off until something is ticked", () => {
    const html = step();
    expect(html).toContain("None run without asking · all 4 ask first");
    expect(html).toContain("<i></i>");
    expect(html).not.toContain('<i class="on">');
  });

  it("ends with Run when the person pressed Run, and has no Open in builder", () => {
    const html = step();
    expect(html).toContain(">Run<");
    expect(html).not.toContain(">Open in builder<");
    expect(html).not.toContain("Run it");
  });

  it("ends with Open in builder when the person pressed that, and has no Run", () => {
    const html = screen({ initialStep: "builder" });
    expect(html).toContain(">Open in builder<");
    expect(html).not.toContain(">Run<");
  });

  it("locks Run while the agent cannot run, but never locks Open in builder", () => {
    expect(step({ canRun: false })).toMatch(/<button class="u-btn primary" disabled="">Run<\/button>/);
    expect(screen({ initialStep: "builder", canRun: false })).not.toContain('disabled="">Open in builder');
  });

  it("has no orange box, no Reviewed tag and no reviewed checkbox", () => {
    const html = step();
    expect(html).not.toContain("Reviewed");
    expect(html).not.toContain("I have reviewed");
    expect(html).not.toContain("dz-strip");
  });

  it("says a server with no tool list asks first for every tool, and gives it nothing to tick", () => {
    const html = step({
      servers: [notion, { name: "linear", transport: { type: "http", url: "https://mcp.linear.app/mcp" } }],
    });
    expect(html).toContain(TRUST_COPY.unlisted);
    expect(html.match(/type="checkbox"/g)).toHaveLength(TOOLS.length);
  });

  it("offers a search only for a long list", () => {
    expect(step()).not.toContain('aria-label="Search tools"');
    const many = Array.from({ length: 13 }, (_, index) => `tool-${index}`);
    const html = step({ servers: [{ ...notion, tool_filter: { allow: many } }] });
    expect(html).toContain('aria-label="Search tools"');
    expect(html).toContain("Search 13 tools");
  });

  it("falls back to the first window when no server lists tools, because there is nothing to choose", () => {
    const html = screen({
      servers: [{ name: "github", transport: { type: "http", url: "https://api.githubcopilot.com/mcp" } }],
      initialStep: "run",
    });
    expect(html).toContain(TRUST_COPY.footer);
    expect(html).toContain(">Run<");
    expect(html).toContain(">Open in builder<");
  });
});
