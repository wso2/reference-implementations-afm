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
import { getSection, setSection } from "./agent-source-edit";
import { buildableAgent, collectAfmIssues, previewAgent } from "./agent-validation";

const FILE = `---
name: Code explain Agent
model:
  provider: anthropic
  name: claude-sonnet-5
---

# Role

You are a helper.

# Instructions

Answer clearly.
`;

function twoServerFile(...authentication: string[]): string {
  return [
    "---",
    "name: A",
    "model:",
    "  provider: openai",
    "  name: gpt-4o",
    "  authentication:",
    "    type: api-key",
    "    api_key: ${env:OPENAI_API_KEY}",
    "tools:",
    "  mcp:",
    "    - name: one",
    "      transport:",
    "        type: http",
    "        url: https://one.example.com/mcp",
    "    - name: two",
    "      transport:",
    "        type: http",
    "        url: https://two.example.com/mcp",
    "        authentication:",
    "          type: jwt",
    "          issuer: https://issuer.example.com",
    "          audience: https://audience.example.com",
    ...authentication,
    "---",
    ROLE_AND_INSTRUCTIONS,
  ].join("\n");
}

describe("the Build view stays put while a field is empty", () => {
  for (const field of ["Role", "Instructions"] as const) {
    it(`survives ${field} being cleared`, () => {
      const cleared = setSection(FILE, field, "");
      expect(buildableAgent(cleared).ok).toBe(true);
      expect(getSection(cleared, field)).toBe("");
    });

    it(`lets ${field} be typed back in`, () => {
      const cleared = setSection(FILE, field, "");
      const retyped = setSection(cleared, field, "A poet.");
      expect(getSection(retyped, field)).toBe("A poet.");
      expect(previewAgent(retyped).ok).toBe(true);
    });

    it(`keeps the other section intact while ${field} is empty`, () => {
      const other = field === "Role" ? "Instructions" : "Role";
      const before = getSection(FILE, other);
      expect(getSection(setSection(FILE, field, ""), other)).toBe(before);
    });
  }

  it("survives both being empty at once, settings and all", () => {
    const drawable = buildableAgent(setSection(setSection(FILE, "Role", ""), "Instructions", ""));
    expect(drawable.ok).toBe(true);
    if (drawable.ok) {
      expect(drawable.metadata.name).toBe("Code explain Agent");
      expect(drawable.metadata.model?.name).toBe("claude-sonnet-5");
    }
  });

  it("still refuses to run a file with no role", () => {
    expect(previewAgent(setSection(FILE, "Role", "")).ok).toBe(false);
  });

  it("falls back to Raw only when the settings block is broken", () => {
    expect(buildableAgent("---\nmodel: [not, a, map]\n---\n\n# Role\n\nx\n").ok).toBe(false);
  });
});

const ROLE_AND_INSTRUCTIONS = "# Role\nA helper.\n\n# Instructions\nAnswer clearly.\n";

describe("the line a problem is shown on", () => {
  it("marks the block that is missing its type, not a line with the same word elsewhere", () => {
    const content = [
      "---",
      "model:",
      "  name: gpt-4o",
      "  provider: openai",
      "  authentication:",
      "    typne: api-key",
      "    api_key: ${env:OPENAI_API_KEY}",
      'name: "GroceryGuide"',
      "interfaces:",
      "  - type: webchat",
      "---",
      ROLE_AND_INSTRUCTIONS,
    ].join("\n");
    const issues = collectAfmIssues(content);
    expect(issues.map((issue) => issue.field)).toEqual(["model.authentication.type"]);
    expect(issues[0]!.line).toBe(5);
  });

  it("marks an unknown setting on its own line", () => {
    const issues = collectAfmIssues(
      `---\nnafme: A\nmodel:\n  provider: openai\n  name: gpt-4o\n---\n${ROLE_AND_INSTRUCTIONS}`,
    );
    expect(issues.map((issue) => [issue.message, issue.line])).toEqual([["Unknown field 'nafme'.", 2]]);
  });

  it("marks an unknown setting inside a block, under the block it is in", () => {
    const content = `---\nname: A\ninterfaces:\n  - type: webchat\nmodel:\n  provider: openai\n  name: gpt-4o\n  colour: blue\n---\n${ROLE_AND_INSTRUCTIONS}`;
    const found = collectAfmIssues(content).find((issue) => issue.field === "model.colour");
    expect(found?.line).toBe(8);
  });

  it("marks the second tool server's authentication, not the model's", () => {
    const content = twoServerFile("          signing_key: ${env:SIGNING_KEY}");
    const issue = collectAfmIssues(content).find((found) => found.field === "tools.mcp[1].transport.authentication");
    expect(issue?.severity).toBe("warning");
    expect(issue?.line).toBe(19);
  });

  it("marks the second tool server's authentication block when a required field is missing from it", () => {
    const content = twoServerFile();
    const issue = collectAfmIssues(content).find((found) => found.message.includes("signing_key"));
    expect(issue?.field).toBe("tools.mcp.1.transport.authentication");
    expect(issue?.line).toBe(19);
  });

  it("marks the interface that cannot run in a browser by its position", () => {
    const content = `---\nname: A\nmodel:\n  provider: openai\n  name: gpt-4o\ninterfaces:\n  - type: webchat\n  - type: consolechat\n---\n${ROLE_AND_INSTRUCTIONS}`;
    const issue = collectAfmIssues(content).find((found) => found.field === "interfaces[1]");
    expect(issue?.severity).toBe("warning");
    expect(issue?.line).toBe(8);
  });

  it("accepts a valid platform trigger but rejects an invalid mode-specific field", () => {
    const file = (extra: string) =>
      `---\nname: A\nmodel:\n  provider: openai\n  name: gpt-4o\ninterfaces:\n  - type: platformchat\n    platform: slack\n    mode: polling\n${extra}---\n${ROLE_AND_INSTRUCTIONS}`;
    expect(previewAgent(file("    polling:\n      interval: 30\n")).ok).toBe(true);
    const issues = collectAfmIssues(file("    signature:\n      output:\n        type: string\n"));
    expect(
      issues.some((issue) => issue.severity === "error" && issue.message.includes("must not set signature.output")),
    ).toBe(true);
  });

  it("gives no line for a broken settings block, since the block cannot be read", () => {
    const issues = collectAfmIssues(`---\nname: [Trip\nmodel: x\n---\n${ROLE_AND_INSTRUCTIONS}`);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.line).toBeNull();
  });
});

const BODY = "\n# Role\nr\n\n# Instructions\ni\n";

function file(model: string, tools = ""): string {
  return `---\nname: A\n${model}${tools}interfaces:\n  - type: webchat\n---\n${BODY}`;
}

const MODEL =
  "model:\n  provider: openai\n  name: gpt-4o\n  authentication:\n    type: api-key\n    api_key: ${env:OPENAI_API_KEY}\n";

const server = (url: string, transport = "http") =>
  `tools:\n  mcp:\n    - name: x\n      transport:\n        type: ${transport}\n        url: ${url}\n`;

describe("a file with no mistakes", () => {
  it("has nothing to warn about", () => {
    expect(collectAfmIssues(file(MODEL, server("https://x.example.com/mcp")))).toEqual([]);
  });
});

describe("a model provider the browser cannot run", () => {
  it("keeps an unknown provider valid while explaining the browser limit", () => {
    const [issue] = collectAfmIssues(file(MODEL.replace("provider: openai", "provider: openia")));
    expect(issue?.message).toContain("Model provider 'openia' is valid AFM");
    expect(issue?.severity).toBe("warning");
    expect(issue?.line).toBe(4);
  });

  it("names the two it can run when nothing is close", () => {
    const [issue] = collectAfmIssues(file(MODEL.replace("provider: openai", "provider: mistral")));
    expect(issue?.message).toContain("Model provider 'mistral' is valid AFM");
  });

  it("accepts the two it can run in any case, and a file with no provider", () => {
    expect(collectAfmIssues(file(MODEL.replace("provider: openai", "provider: OpenAI")))).toEqual([]);
    expect(collectAfmIssues(file("model:\n  name: gpt-4o\n"))).toEqual([]);
  });
});

describe("a tool address that is invalid", () => {
  it("is marked on its own line", () => {
    const [issue] = collectAfmIssues(file(MODEL, server("not-a-url")));
    expect(issue?.message).toContain("transport.url must be an absolute http:// or https:// URL");
    expect(issue?.field).toBe("tools.mcp.0.transport.url");
    expect(issue?.line).toBe(14);
  });

  it("catches an address that only lacks https://", () => {
    expect(collectAfmIssues(file(MODEL, server("example.com/mcp")))).toHaveLength(1);
  });

  it("leaves variables and other kinds of transport alone", () => {
    expect(collectAfmIssues(file(MODEL, server("${env:MCP_URL}")))).toEqual([]);
    const stdio = "tools:\n  mcp:\n    - name: x\n      transport:\n        type: stdio\n        command: npx\n";
    expect(collectAfmIssues(file(MODEL, stdio)).filter((issue) => issue.severity === "error")).toEqual([]);
  });
});

describe("a variable that is not written properly", () => {
  it("says which line has an unclosed variable", () => {
    const [issue] = collectAfmIssues(file(MODEL.replace("${env:OPENAI_API_KEY}", "${env:OPENAI_API_KEY")));
    expect(issue?.message).toBe("Unclosed variable `${env:OPENAI_API_KEY`. Add the closing `}`.");
    expect(issue?.line).toBe(8);
  });

  it("says when a variable has no name", () => {
    expect(
      collectAfmIssues(file(MODEL.replace("${env:OPENAI_API_KEY}", "${env:}"))).map((issue) => issue.message),
    ).toEqual(["Empty variable `${env:}`. Add a name."]);
    expect(collectAfmIssues(file(MODEL.replace("${env:OPENAI_API_KEY}", "${}"))).map((issue) => issue.message)).toEqual(
      ["Empty variable `${}`. Add a name."],
    );
  });

  it("accepts a variable with a prefix or without one", () => {
    expect(collectAfmIssues(file(MODEL.replace("${env:OPENAI_API_KEY}", "${OPENAI_API_KEY}")))).toEqual([]);
  });

  it("ignores comments and the writing below the settings", () => {
    const content = `---\nname: A\n# a note about \${env:\n${MODEL}interfaces:\n  - type: webchat\n---\n\n# Role\nUse \${x\n\n# Instructions\ni\n`;
    expect(collectAfmIssues(content)).toEqual([]);
  });
});

describe("a file whose settings block is far too long", () => {
  const long = `---\nname: X\n${Array.from({ length: 2500 }, (_, index) => `k${index}: 1`).join("\n")}\n---\n# Role\nhi\n`;

  it("is refused by every check, in a moment, with a message that says why", () => {
    const started = Date.now();
    const built = buildableAgent(long);
    const previewed = previewAgent(long);
    const issues = collectAfmIssues(long);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(built).toMatchObject({ ok: false });
    expect(previewed).toMatchObject({ ok: false });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "error", line: null });
    expect(issues[0]?.message).toContain("2,000 lines");
    expect(JSON.stringify(built)).toContain("2,000 lines");
  });

  it("does not stop a file with a normal settings block", () => {
    expect(buildableAgent(FILE).ok).toBe(true);
  });
});

describe("a key written straight into the file", () => {
  const typed = MODEL.replace("${env:OPENAI_API_KEY}", "sk-abc123abc123abc123abc123");

  it("is flagged on its own line, so it is seen where it is typed", () => {
    const issue = collectAfmIssues(file(typed)).find((found) => found.field === "api_key");
    expect(issue?.severity).toBe("warning");
    expect(issue?.line).toBe(8);
    expect(issue?.message).toContain("anyone who gets this file can read it");
    expect(issue?.message).toContain("`${env:NAME}`");
  });

  it.each([
    ["is written on one line", "model:\n  provider: openai\n  name: gpt-4o\n  authentication: {type: api-key, api_key: sk-abc123abc123abc123abc123}\n", 6],
    ["has its name in quotes", MODEL.replace("api_key:", '"api_key":').replace("${env:OPENAI_API_KEY}", "sk-abc123abc123abc123abc123"), 8],
  ])("is flagged where it is typed when the block %s", (_label, model, line) => {
    const issue = collectAfmIssues(file(model)).find((found) => found.field === "api_key");
    expect(issue).toMatchObject({ severity: "warning", line });
  });

  it("does not stop the agent from running", () => {
    expect(collectAfmIssues(file(typed)).some((found) => found.severity === "error")).toBe(false);
  });

  it("is not flagged when the field points at a variable", () => {
    expect(collectAfmIssues(file(MODEL)).some((found) => found.field === "api_key")).toBe(false);
  });

  it("is not pointed at on a line that holds a quoted variable", () => {
    const tools =
      "tools:\n  mcp:\n    - name: x\n      transport:\n        type: http\n        url: https://x.example.com/mcp\n" +
      '        authentication:\n          type: api-key\n          api_key: "${env:X_API_KEY}"\n';
    const lines = collectAfmIssues(file(typed, tools))
      .filter((found) => found.message.includes("anyone who gets this file can read it"))
      .map((found) => found.line);
    expect(lines).toEqual([8]);
  });

  it("is flagged for a tool server's token as well", () => {
    const tools =
      "tools:\n  mcp:\n    - name: x\n      transport:\n        type: http\n        url: https://x.example.com/mcp\n" +
      "        authentication:\n          type: bearer\n          token: ghp_literal\n";
    const issue = collectAfmIssues(file(MODEL, tools)).find((found) => found.field === "token");
    expect(issue?.line).toBe(17);
  });
});
