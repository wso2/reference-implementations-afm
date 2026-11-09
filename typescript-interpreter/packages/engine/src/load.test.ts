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


import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AfmParseError, AfmValidationError, VariableResolutionError } from "./errors";
import { agentDetails, buildSystemPrompt, loadAfm, loadParsed } from "./load";
import { parseAfm } from "./parse";

const agentFile = (name: string): string => readFileSync(new URL(`../fixtures/agents/${name}`, import.meta.url), "utf-8");

const KEY = { OPENAI_API_KEY: "sk-123" };

const FULL = `---
spec_version: "0.4.0"
name: Demo
max_iterations: 4
model:
  provider: openai
  authentication:
    type: api-key
    api_key: "\${env:OPENAI_API_KEY}"
interfaces:
  - type: webchat
---

# Role
You are a demo agent.

# Instructions
Be brief.
`;

describe("loadAfm", () => {
  it("resolves, parses and validates a full file", () => {
    const loaded = loadAfm(FULL, { env: KEY });
    expect(loaded.metadata.name).toBe("Demo");
    expect(loaded.metadata.max_iterations).toBe(4);
    expect(loaded.metadata.model?.authentication?.api_key).toBe("sk-123");
    expect(loaded.role).toBe("You are a demo agent.");
    expect(loaded.systemPrompt).toContain("# Role");
    expect(loaded.systemPrompt).toContain("Be brief.");
    expect(loaded.warnings).toEqual([]);
  });

  it("loads a file that was parsed earlier, so a host can change the header first", () => {
    const parsed = parseAfm(FULL);
    const loaded = loadParsed({ ...parsed, frontmatter: { ...parsed.frontmatter, name: "Changed" } }, { env: KEY });
    expect(loaded.metadata.name).toBe("Changed");
    expect(loaded.metadata.model?.authentication?.api_key).toBe("sk-123");
  });

  it("reads the header when blank lines come before the opening fence", () => {
    expect(loadAfm(`\n \n${FULL}`, { env: KEY }).metadata.name).toBe("Demo");
  });

  it("does not ask for a variable that only appears in a YAML comment", () => {
    const file = "---\nname: Demo # ${env:NEVER_PROVIDED}\n# ${env:ALSO_NEVER_PROVIDED}\n---\n\n# Role\nr\n\n# Instructions\ni\n";
    expect(loadAfm(file, { env: {} }).metadata.name).toBe("Demo");
  });

  it("resolves variables in Role and Instructions as well as in the front matter", () => {
    const file = "---\nname: Demo\n---\n\n# Role\nYou are ${env:AGENT_NAME}.\n\n# Instructions\nSign off as ${AGENT_NAME}.\n";
    const loaded = loadAfm(file, { env: { AGENT_NAME: "Ada" } });
    expect(loaded.role).toBe("You are Ada.");
    expect(loaded.instructions).toBe("Sign off as Ada.");
    expect(loaded.systemPrompt).toBe("# Role\n\nYou are Ada.\n\n# Instructions\n\nSign off as Ada.");
  });

  it("needs a value for a variable that is only written in the body", () => {
    const file = "---\nname: Demo\n---\n\n# Role\n${env:NEVER_PROVIDED}\n\n# Instructions\ni\n";
    expect(() => loadAfm(file, { env: {} })).toThrow(VariableResolutionError);
  });

  it("throws VariableResolutionError when a secret is missing, naming the variable and not a value", () => {
    expect(() => loadAfm(FULL, { env: {} })).toThrow(VariableResolutionError);
    expect(() => loadAfm(FULL, { env: {} })).toThrow(/OPENAI_API_KEY/);
  });

  it("reads the process environment when no environment is given", () => {
    const { env } = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;
    env["AFM_TEST_KEY"] = "from-process";
    try {
      expect(loadAfm(FULL.replace("OPENAI_API_KEY", "AFM_TEST_KEY")).metadata.model?.authentication?.api_key).toBe("from-process");
    } finally {
      delete env["AFM_TEST_KEY"];
    }
  });

  it("throws AfmParseError on a malformed file", () => {
    expect(() => loadAfm("---\nname: x\n\n# Role\nr\n", { env: {} })).toThrow(AfmParseError);
  });

  it("leaves ${http:...} in a webhook prompt for the host to fill, and rejects it anywhere else", () => {
    const hook = "---\ninterfaces:\n  - type: webhook\n    prompt: \"Event ${http:payload.action}\"\n---\n\n# Role\nr\n\n# Instructions\ni\n";
    expect(loadAfm(hook, { env: {} }).metadata.interfaces).toMatchObject([{ type: "webhook", prompt: "Event ${http:payload.action}" }]);
    const role = "---\nname: Demo\n---\n\n# Role\nEvent ${http:payload.action}\n\n# Instructions\ni\n";
    expect(() => loadAfm(role, { env: {} })).toThrow(AfmValidationError);
    expect(() => loadAfm(role, { env: {} })).toThrow(/found in: role/);
  });

  describe("spec_version", () => {
    const withVersion = (line: string) => FULL.replace('spec_version: "0.4.0"\n', line);
    const warningsFor = (line: string) => loadAfm(withVersion(line), { env: KEY }).warnings;

    it("accepts 0.3.0 and 0.4.0 without a warning, like the Python and Ballerina interpreters", () => {
      expect(warningsFor('spec_version: "0.3.0"\n')).toEqual([]);
      expect(warningsFor('spec_version: "0.4.0"\n')).toEqual([]);
    });

    it("warns, and does not fail, when the file has no spec_version", () => {
      expect(warningsFor("")).toEqual(["AFM file has no 'spec_version'; expected one of: 0.3.0, 0.4.0. Proceeding anyway."]);
    });

    it("warns, and does not fail, for any other version", () => {
      expect(warningsFor('spec_version: "0.2.0"\n')).toEqual([
        "AFM file 'spec_version' '0.2.0' is not in the supported set (0.3.0, 0.4.0). Proceeding anyway; some fields may not be recognized.",
      ]);
    });
  });

  it("accepts a number that comes from a variable", () => {
    const file = FULL.replace("max_iterations: 4", "max_iterations: ${env:STEPS}");
    expect(loadAfm(file, { env: { ...KEY, STEPS: "7" } }).metadata.max_iterations).toBe(7);
  });

  it("still rejects a variable that does not hold a whole number", () => {
    const file = FULL.replace("max_iterations: 4", "max_iterations: ${env:STEPS}");
    for (const value of ["seven", "7.5", "0", "-3"]) expect(() => loadAfm(file, { env: { ...KEY, STEPS: value } })).toThrow();
  });

  it("throws AfmValidationError on an invalid field", () => {
    expect(() => loadAfm("---\nmax_iterations: not-a-number\n---\n\n# Role\nr\n\n# Instructions\ni\n", { env: {} })).toThrow(AfmValidationError);
  });
});

const AWKWARD_SECRETS = [
  "abc #def",
  "p@ss: word",
  "a: b",
  "!abc",
  "*abc",
  "&anchor",
  "%tok",
  "@tok",
  "|pipe",
  ">fold",
  "-secret",
  "[tok]",
  "{tok}",
  "it's",
  'say "hi"',
  "back\\slash",
  "123456789",
  "0x1F",
  "12e3",
  "true",
  "null",
];

function fileWithKey(placement: string): string {
  return `---
model:
  provider: openai
  authentication:
    type: api-key
    api_key: ${placement}
---

# Role
r

# Instructions
i
`;
}

describe.each(["${env:KEY}", '"${env:KEY}"', "'${env:KEY}'"])("a secret written as %s", (placement) => {
  it.each(AWKWARD_SECRETS)("reaches the model exactly as given: %j", (value) => {
    expect(loadAfm(fileWithKey(placement), { env: { KEY: value } }).metadata.model?.authentication?.api_key).toBe(value);
  });
});

describe("a secret in Role and Instructions", () => {
  it.each(AWKWARD_SECRETS)("reaches the prompt exactly as given, and cannot change the file: %j", (value) => {
    const file = "---\nname: Demo\n---\n\n# Role\nKey: ${env:KEY}\n\n# Instructions\ni\n";
    const loaded = loadAfm(file, { env: { KEY: value } });
    expect(loaded.role).toBe(`Key: ${value}`);
    expect(loaded.metadata).toEqual({ name: "Demo" });
  });
});

describe("a key's value in an error message", () => {
  const SECRET = "SECRET-VALUE-123";
  const FIELDS = [
    "type", "token", "username", "password", "api_key", "header_name", "issuer", "audience", "signing_key", "algorithm",
    "key_id", "subject", "expiry_seconds", "grant_type", "token_url", "client_id", "client_secret", "scopes",
  ];
  const BLOCKS = [
    ["type: bearer", "token: t"],
    ["type: basic", "username: u", "password: p"],
    ["type: oauth2", "grant_type: client_credentials", "token_url: https://a.example/t", "client_id: i", "client_secret: s"],
    ["type: jwt", "issuer: i", "audience: a", "signing_key: k", "algorithm: HS256"],
  ];

  const indent = (lines: string[], spaces: number) => lines.map((line) => " ".repeat(spaces) + line);

  function fileWith(where: "the model" | "a tool server", block: string[], field: string): string {
    const authentication = block.filter((line) => !line.startsWith(`${field}:`)).concat(`${field}: \${env:KEY}`);
    const lines =
      where === "the model"
        ? ["model:", "  provider: openai", "  authentication:", ...indent(authentication, 4)]
        : [
            "model:",
            "  provider: openai",
            "tools:",
            "  mcp:",
            "    - name: s",
            "      transport:",
            "        type: http",
            "        url: https://s.example/mcp",
            "        authentication:",
            ...indent(authentication, 10),
          ];
    return ["---", ...lines, "---", "", "# Role", "r", "", "# Instructions", "i", ""].join("\n");
  }

  it.each(["the model", "a tool server"] as const)("is never quoted, whichever authentication field of %s holds the reference", (where) => {
    const quoted: string[] = [];
    for (const block of BLOCKS) {
      for (const field of FIELDS) {
        try {
          loadAfm(fileWith(where, block, field), { env: { KEY: SECRET } });
        } catch (error) {
          if ((error as Error).message.includes(SECRET)) quoted.push(`${field}: ${(error as Error).message}`);
        }
      }
    }
    expect(quoted).toEqual([]);
  });
});

describe("buildSystemPrompt", () => {
  it("formats Role and Instructions as two headed sections", () => {
    expect(buildSystemPrompt("You are X.", "Do Y.")).toBe("# Role\n\nYou are X.\n\n# Instructions\n\nDo Y.");
  });
});

const ENV = new Proxy({} as Record<string, string>, {
  has: () => true,
  getOwnPropertyDescriptor: (_target, name) => ({ value: /(URL|SERVER)$/.test(String(name)) ? "https://mcp.example.test/mcp" : `test-${String(name)}`, enumerable: true, configurable: true }),
  get: (_target, name) => (/(URL|SERVER)$/.test(String(name)) ? "https://mcp.example.test/mcp" : `test-${String(name)}`),
});

const EXAMPLES = [
  { file: "friendly_assistant.afm.md", name: "Friendly Assistant", source: agentFile("friendly_assistant.afm.md") },
  { file: "hr_agent.afm.md", name: "CWave HR Assistant", source: agentFile("hr_agent.afm.md") },
  { file: "math_tutor.afm.md", name: "Math Tutor", source: agentFile("math_tutor.afm.md") },
  { file: "pull_request_analyzer.afm.md", name: "GitHub PR Code-Documentation Drift Checker", source: agentFile("pull_request_analyzer.afm.md") },
  { file: "slack_assistant.afm.md", name: "Slack Assistant", source: agentFile("slack_assistant.afm.md") },
  { file: "support_agent.afm.md", name: "SupportAgent", source: agentFile("support_agent.afm.md") },
];

describe("the example agents from the AFM specification", () => {
  it.each(EXAMPLES)("loads $file", ({ source, name }) => {
    const loaded = loadAfm(source, { env: ENV });
    expect(loaded.metadata.name).toBe(name);
    expect(loaded.role).not.toBe("");
    expect(loaded.instructions).not.toBe("");
  });
});

describe("agentDetails", () => {
  const afm = (frontmatter: string) => loadAfm(`---\n${frontmatter}\n---\n# Role\nYou help with maths.\nStep by step.\n\nSecond paragraph.\n# Instructions\nBe kind.\n`);

  it("uses what the file says", () => {
    const loaded = afm("name: Tutor\ndescription: Helps\nversion: 1.2.0\nicon_url: https://example.com/a.png");
    expect(agentDetails(loaded, "/agents/other.afm.md")).toEqual({ name: "Tutor", description: "Helps", version: "1.2.0", iconUrl: "https://example.com/a.png" });
  });

  it("falls back to the file name, the first paragraph of the Role and 0.0.0", () => {
    expect(agentDetails(afm("spec_version: '0.4.0'"), "/agents/math-tutor.afm.md")).toEqual({
      name: "math-tutor",
      description: "You help with maths. Step by step.",
      version: "0.0.0",
      iconUrl: undefined,
    });
  });

  it("takes the name from a file that ends in .afm, or in .AFM.MD", () => {
    expect(agentDetails(afm("spec_version: '0.4.0'"), "C:\\agents\\helper.afm").name).toBe("helper");
    expect(agentDetails(afm("spec_version: '0.4.0'"), "Helper.AFM.MD").name).toBe("Helper");
  });

  it("names the agent AFM Agent when there is no name and no file", () => {
    expect(agentDetails(afm("spec_version: '0.4.0'")).name).toBe("AFM Agent");
  });
});
