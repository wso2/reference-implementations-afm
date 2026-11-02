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
import friendlyAssistant from "../fixtures/agents/friendly_assistant.afm.md?raw";
import hrAgent from "../fixtures/agents/hr_agent.afm.md?raw";
import mathTutor from "../fixtures/agents/math_tutor.afm.md?raw";
import pullRequestAnalyzer from "../fixtures/agents/pull_request_analyzer.afm.md?raw";
import slackAssistant from "../fixtures/agents/slack_assistant.afm.md?raw";
import supportAgent from "../fixtures/agents/support_agent.afm.md?raw";
import { AfmParseError, AfmValidationError, VariableResolutionError } from "./errors";
import { buildSystemPrompt, loadAfm, planForBrowser } from "./load";
import { validateMetadata } from "./schema";
import { fakeSecrets } from "./test-support";
import type { SecretPort } from "./types";

describe("planForBrowser", () => {
  it("reports no issues for a webchat-only agent", () => {
    const md = validateMetadata({ interfaces: [{ type: "webchat" }] });
    const plan = planForBrowser(md);
    expect(plan.runnable).toBe(true);
    expect(plan.issues).toHaveLength(0);
  });

  it("is runnable with no interfaces or tools at all", () => {
    const plan = planForBrowser(validateMetadata({}));
    expect(plan.runnable).toBe(true);
    expect(plan.issues).toHaveLength(0);
  });

  it("warns about a consolechat interface", () => {
    const md = validateMetadata({ interfaces: [{ type: "consolechat" }] });
    const plan = planForBrowser(md);
    expect(plan.runnable).toBe(true);
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0]?.code).toBe("interface-unsupported");
    expect(plan.issues[0]?.message).toMatch(/consolechat/);
  });

  it("warns about a webhook interface", () => {
    const md = validateMetadata({
      interfaces: [{ type: "webhook", subscription: { protocol: "websub" } }],
    });
    const plan = planForBrowser(md);
    expect(plan.issues[0]?.code).toBe("interface-unsupported");
    expect(plan.issues[0]?.message).toMatch(/webhook/);
  });

  it("warns about a stdio MCP server but not an http one", () => {
    const md = validateMetadata({
      tools: {
        mcp: [
          { name: "local", transport: { type: "stdio", command: "python" } },
          { name: "remote", transport: { type: "http", url: "https://x/y" } },
        ],
      },
    });
    const plan = planForBrowser(md);
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0]?.code).toBe("stdio-transport-unsupported");
    expect(plan.issues[0]?.path).toBe("tools.mcp[0].transport");
  });

  it("blocks an MCP server that signs its own jwt, but not other auth on http servers", () => {
    const md = validateMetadata({
      tools: {
        mcp: [
          {
            name: "signed",
            transport: { type: "http", url: "https://x/y", authentication: { type: "jwt", issuer: "i", signing_key: "${env:K}" } },
          },
          { name: "bearer", transport: { type: "http", url: "https://x/z", authentication: { type: "bearer", token: "t" } } },
          { name: "open", transport: { type: "http", url: "https://x/w" } },
        ],
      },
    });
    const plan = planForBrowser(md);
    expect(plan.runnable).toBe(false);
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0]).toMatchObject({
      severity: "blocked",
      code: "jwt-auth-unsupported",
      path: "tools.mcp[0].transport.authentication",
    });
    expect(plan.issues[0]?.message).toMatch(/'signed'.*oauth2.*bearer/);
  });

  it("blocks jwt and oauth2 authentication on the model, but allows an api key or bearer token", () => {
    const jwt = planForBrowser(validateMetadata({ model: { authentication: { type: "jwt", issuer: "i", signing_key: "k" } } }));
    expect(jwt.runnable).toBe(false);
    expect(jwt.issues[0]).toMatchObject({ severity: "blocked", code: "model-auth-unsupported", path: "model.authentication" });

    const oauth = planForBrowser(
      validateMetadata({
        model: { authentication: { type: "OAuth2", grant_type: "client_credentials", token_url: "https://t", client_id: "i", client_secret: "s" } },
      }),
    );
    expect(oauth.runnable).toBe(false);
    expect(oauth.issues[0]?.message).toMatch(/'oauth2'/);

    for (const authentication of [{ type: "api-key", api_key: "k" }, { type: "bearer", token: "t" }]) {
      const plan = planForBrowser(validateMetadata({ model: { authentication } }));
      expect(plan.runnable).toBe(true);
      expect(plan.issues).toHaveLength(0);
    }
  });

  it("collects multiple issues across interfaces and tools", () => {
    const md = validateMetadata({
      interfaces: [{ type: "webchat" }, { type: "consolechat" }],
      tools: { mcp: [{ name: "local", transport: { type: "stdio", command: "node" } }] },
    });
    const plan = planForBrowser(md);
    expect(plan.runnable).toBe(true);
    expect(plan.issues).toHaveLength(2);
    expect(plan.issues.map((i) => i.code).sort()).toEqual([
      "interface-unsupported",
      "stdio-transport-unsupported",
    ]);
  });

  it("keeps spec-valid unsupported capabilities as browser warnings or blockers", () => {
    const metadata = validateMetadata({
      model: { provider: "openai", url: "https://custom.example.com/v1" },
      interfaces: [
        { type: "platformchat", platform: "slack", mode: "notification" },
        { type: "webchat", signature: { input: { type: "object" } } },
        { type: "webhook" },
      ],
      skills: [{ type: "local", path: "./skills" }],
    });
    const plan = planForBrowser(metadata);
    expect(plan.runnable).toBe(true);
    expect(plan.issues.map((issue) => issue.code)).toEqual([
      "interface-unsupported", "structured-signature-unsupported", "interface-unsupported", "model-url-unsupported", "local-skill-unsupported",
    ]);
    const [issue] = planForBrowser(validateMetadata({ model: { provider: "other" } })).issues;
    expect(issue).toMatchObject({ severity: "blocked", code: "model-provider-unsupported" });
  });

  describe("an MCP server that is reached over plain http", () => {
    const server = (url: string, authentication?: Record<string, unknown>) =>
      validateMetadata({ tools: { mcp: [{ name: "docs", transport: { type: "http", url, ...(authentication ? { authentication } : {}) } }] } });
    const bearer = { type: "bearer", token: "t" };

    it.each([
      ["bearer", bearer],
      ["basic", { type: "basic", username: "u", password: "p" }],
      ["api-key", { type: "api-key", api_key: "k", header_name: "X-Api-Key" }],
      ["oauth2", { type: "oauth2", grant_type: "authorization_code", authorize_url: "https://a/authorize", token_url: "https://a/token", client_id: "c" }],
    ])("is blocked when it carries %s credentials", (_label, authentication) => {
      const plan = planForBrowser(server("http://mcp.example.com/mcp", authentication));
      expect(plan.runnable).toBe(false);
      expect(plan.issues).toEqual([
        expect.objectContaining({ severity: "blocked", code: "tool-credentials-insecure", path: "tools.mcp[0].transport.url" }),
      ]);
      expect(plan.issues[0]?.message).toContain("'docs'");
    });

    it.each([
      ["an https address", "https://mcp.example.com/mcp"],
      ["a localhost address", "http://localhost:8787/mcp"],
      ["a 127.0.0.1 address", "http://127.0.0.1:9000/mcp"],
      ["an address that is still a variable", "http://${env:MCP_HOST}/mcp"],
    ])("is let through for %s", (_label, url) => {
      expect(planForBrowser(server(url, bearer)).issues).toEqual([]);
    });

    it("is let through when it carries no credentials, since there is nothing to read", () => {
      expect(planForBrowser(server("http://mcp.example.com/mcp")).issues).toEqual([]);
    });

    it.each([
      ["token_url", { token_url: "http://auth.example.com/token", authorize_url: "https://auth.example.com/authorize" }],
      ["authorize_url", { token_url: "https://auth.example.com/token", authorize_url: "http://auth.example.com/authorize" }],
      ["token_url", { token_url: "http://localhost:9000/token", authorize_url: "https://auth.example.com/authorize" }],
    ])("is blocked when the oauth2 %s is plain http, even for localhost, since sign-in refuses it at run time", (field, addresses) => {
      const plan = planForBrowser(server("https://mcp.example.com/mcp", { type: "oauth2", grant_type: "authorization_code", client_id: "c", ...addresses }));
      expect(plan.runnable).toBe(false);
      expect(plan.issues).toEqual([
        expect.objectContaining({ code: "oauth-address-insecure", path: `tools.mcp[0].transport.authentication.${field}` }),
      ]);
    });

    it("lets an oauth2 sign-in through when its addresses are https or still variables", () => {
      const oauth = { type: "oauth2", grant_type: "authorization_code", client_id: "c" };
      const https = { authorize_url: "https://a/authorize", token_url: "https://a/token" };
      const variables = { authorize_url: "${env:AUTH}", token_url: "http://${env:HOST}/token" };
      expect(planForBrowser(server("https://mcp.example.com/mcp", { ...oauth, ...https })).issues).toEqual([]);
      expect(planForBrowser(server("https://mcp.example.com/mcp", { ...oauth, ...variables })).issues).toEqual([]);
    });

    it("keeps reporting an authentication type the browser cannot use, ahead of the transport", () => {
      const plan = planForBrowser(server("http://mcp.example.com/mcp", { type: "x-custom" }));
      expect(plan.issues.map((issue) => issue.code)).toEqual(["tool-auth-unsupported"]);
    });
  });
});

const FULL = `---
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
  it("resolves, parses, validates, and plans a full file", async () => {
    const loaded = await loadAfm(FULL, fakeSecrets({ OPENAI_API_KEY: "sk-123" }));
    expect(loaded.metadata.name).toBe("Demo");
    expect(loaded.metadata.max_iterations).toBe(4);
    expect(loaded.metadata.model?.authentication?.api_key).toBe("sk-123");
    expect(loaded.role).toBe("You are a demo agent.");
    expect(loaded.systemPrompt).toContain("# Role");
    expect(loaded.systemPrompt).toContain("Be brief.");
    expect(loaded.plan.runnable).toBe(true);
    expect(loaded.plan.issues).toHaveLength(0);
  });

  it("reads the header when blank lines come before the opening fence", async () => {
    const loaded = await loadAfm(`\n \n${FULL}`, fakeSecrets({ OPENAI_API_KEY: "sk-123" }));
    expect(loaded.metadata.name).toBe("Demo");
    expect(loaded.metadata.model?.authentication?.api_key).toBe("sk-123");
  });

  it("does not ask for a variable that only appears in a YAML comment", async () => {
    const file = `---
name: Demo # \${env:NEVER_PROVIDED}
# \${env:ALSO_NEVER_PROVIDED}
---

# Role
r

# Instructions
i
`;
    await expect(loadAfm(file, fakeSecrets({}))).resolves.toBeDefined();
  });

  it("reports browser limits in the plan", async () => {
    const file = `---
tools:
  mcp:
    - name: local
      transport:
        type: stdio
        command: python
---

# Role
r

# Instructions
i
`;
    const loaded = await loadAfm(file, fakeSecrets({}));
    expect(loaded.plan.issues.some((issue) => issue.code === "stdio-transport-unsupported")).toBe(
      true,
    );
  });

  it("loads a browser chat without resolving inactive platform, stdio, or skill fields", async () => {
    const file = [
      "---",
      "model:",
      "  provider: openai",
      "  name: gpt-4o",
      "  url: https://custom.example.com/v1",
      "  authentication:",
      "    type: api-key",
      '    api_key: "${env:MODEL_KEY}"',
      "interfaces:",
      "  - type: platformchat",
      "    platform: telegram",
      "    mode: polling",
      "    authentication:",
      "      type: api-key",
      '      api_key: "${env:PLATFORM_KEY}"',
      "tools:",
      "  mcp:",
      "    - name: local",
      "      transport:",
      "        type: stdio",
      "        command: node",
      "        env:",
      '          TOKEN: "${env:LOCAL_KEY}"',
      "skills:",
      "  - type: local",
      "    path: ./skills",
      "---",
      "# Role",
      "r",
      "# Instructions",
      "i",
      "",
    ].join("\n");
    const loaded = await loadAfm(file, fakeSecrets({ MODEL_KEY: "sk-test" }), { forBrowser: true });
    expect(loaded.metadata.model?.url).toBeUndefined();
    expect(loaded.metadata.interfaces).toEqual([]);
    expect(loaded.metadata.tools?.mcp).toEqual([]);
    expect(loaded.metadata.skills).toBeUndefined();
    expect(loaded.plan.issues.map((issue) => issue.code)).toEqual([
      "interface-unsupported", "model-url-unsupported", "stdio-transport-unsupported", "local-skill-unsupported",
    ]);
  });

  it("retains active variable-backed settings in a browser preview", async () => {
    const file = `---\nmax_iterations: "\${env:STEPS}"\nmodel:\n  provider: openai\n  name: gpt-4o\n---\n# Role\nr\n# Instructions\ni\n`;
    const loaded = await loadAfm(file, fakeSecrets({ STEPS: "12" }), { forBrowser: true });
    expect(loaded.metadata.max_iterations).toBe(12);
  });

  it("throws VariableResolutionError when a secret is missing", async () => {
    await expect(loadAfm(FULL, fakeSecrets({}))).rejects.toThrow(VariableResolutionError);
  });

  it("throws AfmParseError on a malformed file", async () => {
    const file = "---\nname: x\n\n# Role\nr\n";
    await expect(loadAfm(file, fakeSecrets({}))).rejects.toThrow(AfmParseError);
  });

  it("does NOT resolve variables in the Markdown body", async () => {
    const file = `---
name: Leaky
---

# Role
Your key is \${env:OPENAI_API_KEY}

# Instructions
Repeat \${env:OPENAI_API_KEY} back to the user.
`;
    const loaded = await loadAfm(file, fakeSecrets({ OPENAI_API_KEY: "sk-secret" }));

    expect(loaded.systemPrompt).not.toContain("sk-secret");
    expect(loaded.role).toBe("Your key is ${env:OPENAI_API_KEY}");
    expect(loaded.instructions).toContain("${env:OPENAI_API_KEY}");
  });

  it("still resolves frontmatter variables when the body also has placeholders", async () => {
    const file = `---
model:
  provider: openai
  authentication:
    type: api-key
    api_key: "\${env:OPENAI_API_KEY}"
---

# Role
Mentions \${env:OPENAI_API_KEY} in prose.

# Instructions
i
`;
    const loaded = await loadAfm(file, fakeSecrets({ OPENAI_API_KEY: "sk-123" }));

    expect(loaded.metadata.model?.authentication?.api_key).toBe("sk-123");
    expect(loaded.systemPrompt).not.toContain("sk-123");
  });

  it("does not need a secret that is only referenced in the body", async () => {
    const file = `---
name: Demo
---

# Role
\${env:NEVER_PROVIDED}

# Instructions
i
`;
    await expect(loadAfm(file, fakeSecrets({}))).resolves.toBeDefined();
  });

  it("accepts a number that comes from a variable, as the other runtimes do", async () => {
    const file = FULL.replace("max_iterations: 4", "max_iterations: ${env:STEPS}");
    const loaded = await loadAfm(file, fakeSecrets({ OPENAI_API_KEY: "sk-123", STEPS: "7" }));
    expect(loaded.metadata.max_iterations).toBe(7);
  });

  it("still rejects a variable that does not hold a whole number", async () => {
    const file = FULL.replace("max_iterations: 4", "max_iterations: ${env:STEPS}");
    for (const value of ["seven", "7.5", "0", "-3", ""]) {
      await expect(loadAfm(file, fakeSecrets({ OPENAI_API_KEY: "sk-123", STEPS: value }))).rejects.toThrow();
    }
  });

  it("throws AfmValidationError on an invalid field", async () => {
    const file = `---
max_iterations: not-a-number
---

# Role
r

# Instructions
i
`;
    await expect(loadAfm(file, fakeSecrets({}))).rejects.toThrow(AfmValidationError);
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
  it.each(AWKWARD_SECRETS)("reaches the model exactly as given: %j", async (value) => {
    const loaded = await loadAfm(fileWithKey(placement), fakeSecrets({ KEY: value }));
    expect(loaded.metadata.model?.authentication?.api_key).toBe(value);
  });
});

describe("a key's value in an error message", () => {
  const SECRET = "SECRET-VALUE-123";
  const FIELDS = [
    "type", "token", "username", "password", "api_key", "header_name", "issuer", "audience", "signing_key", "algorithm", "key_id",
    "subject", "expiry_seconds", "grant_type", "authorize_url", "token_url", "client_id", "client_secret", "refresh_token", "assertion",
    "scopes", "credential_bearer",
  ];
  const BLOCKS = [
    ["type: bearer", "token: t"],
    ["type: oauth2", "grant_type: client_credentials", "token_url: https://a.example/t", "client_id: i", "client_secret: s"],
    ["type: jwt", "issuer: i", "signing_key: k", "algorithm: HS256"],
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

  it.each(["the model", "a tool server"] as const)("is never quoted, whichever authentication field of %s holds the reference", async (where) => {
    const quoted: string[] = [];
    for (const block of BLOCKS) {
      for (const field of FIELDS) {
        const message = await loadAfm(fileWith(where, block, field), fakeSecrets({ KEY: SECRET })).then(
          () => "",
          (error: Error) => error.message,
        );
        if (message.includes(SECRET)) quoted.push(`${field}: ${message}`);
      }
    }
    expect(quoted).toEqual([]);
  });
});

describe("buildSystemPrompt", () => {
  it("formats Role and Instructions like the reference runtimes", () => {
    expect(buildSystemPrompt("You are X.", "Do Y.")).toBe(
      "# Role\n\nYou are X.\n\n# Instructions\n\nDo Y.",
    );
  });
});

const secrets: SecretPort = {
  async resolve({ name }) {
    return { status: "resolved", value: /(URL|SERVER)$/.test(name) ? "https://mcp.example.test/mcp" : `test-${name}` };
  },
};

const EXAMPLES = [
  { file: "friendly_assistant.afm.md", name: "Friendly Assistant", source: friendlyAssistant, notes: [] },
  { file: "hr_agent.afm.md", name: "CWave HR Assistant", source: hrAgent, notes: ["stdio-transport-unsupported"] },
  { file: "math_tutor.afm.md", name: "Math Tutor", source: mathTutor, notes: ["interface-unsupported"] },
  {
    file: "pull_request_analyzer.afm.md",
    name: "GitHub PR Code-Documentation Drift Checker",
    source: pullRequestAnalyzer,
    notes: ["interface-unsupported"],
  },
  { file: "slack_assistant.afm.md", name: "Slack Assistant", source: slackAssistant, notes: ["interface-unsupported"] },
  { file: "support_agent.afm.md", name: "SupportAgent", source: supportAgent, notes: ["local-skill-unsupported"] },
];

describe("the example agents from the AFM specification", () => {
  it.each(EXAMPLES)("loads $file", async ({ source, name }) => {
    const loaded = await loadAfm(source, secrets);
    expect(loaded.metadata.name).toBe(name);
    expect(loaded.role).not.toBe("");
    expect(loaded.instructions).not.toBe("");
  });

  it.each(EXAMPLES)("plans $file for the browser, naming only what it cannot run", async ({ source, notes }) => {
    const { plan } = await loadAfm(source, secrets, { forBrowser: true });
    expect(plan.runnable).toBe(true);
    expect(plan.issues.map((issue) => issue.code)).toEqual(notes);
  });
});

describe("the browser plan for a file that writes its values as variables", () => {
  const httpServer = (name: string, url: string): string[] => [
    `    - name: ${name}`,
    "      transport:",
    "        type: http",
    `        url: "${url}"`,
    "        authentication:",
    "          type: bearer",
    '          token: "${env:TOKEN}"',
  ];
  const stdioServer = (name: string): string[] => [`    - name: ${name}`, "      transport:", "        type: stdio", "        command: node"];
  const agent = (provider: string, servers: string[][], modelLines: string[] = []): string =>
    [
      "---",
      "name: Demo",
      "model:",
      `  provider: "${provider}"`,
      "  name: m",
      ...modelLines,
      "tools:",
      "  mcp:",
      ...servers.flat(),
      "---",
      "",
      "# Role",
      "r",
      "",
      "# Instructions",
      "i",
      "",
    ].join("\n");
  const planFor = async (source: string, values: Record<string, string>) =>
    (await loadAfm(source, fakeSecrets({ TOKEN: "t", ...values }), { forBrowser: true })).plan;
  const secure = httpServer("remote", "https://remote.example.com/mcp");

  it("does not block a provider variable that resolves to a supported provider", async () => {
    const plan = await planFor(agent("${env:PROVIDER}", [secure]), { PROVIDER: "openai" });
    expect(plan).toEqual({ runnable: true, issues: [] });
  });

  it("blocks a provider variable that resolves to an unsupported provider", async () => {
    const plan = await planFor(agent("${env:PROVIDER}", [secure]), { PROVIDER: "gemini" });
    expect(plan.runnable).toBe(false);
    expect(plan.issues).toEqual([expect.objectContaining({ severity: "blocked", code: "model-provider-unsupported", path: "model.provider" })]);
  });

  it("blocks credentials for a plain http address that a variable resolves to", async () => {
    const plan = await planFor(agent("openai", [httpServer("remote", "${env:URL}")]), { URL: "http://remote.example.com/mcp" });
    expect(plan.runnable).toBe(false);
    expect(plan.issues).toEqual([expect.objectContaining({ severity: "blocked", code: "tool-credentials-insecure", path: "tools.mcp[0].transport.url" })]);
  });

  it("accepts an https address that a variable resolves to", async () => {
    const plan = await planFor(agent("openai", [httpServer("remote", "${env:URL}")]), { URL: "https://remote.example.com/mcp" });
    expect(plan).toEqual({ runnable: true, issues: [] });
  });

  it("points at the server's own place in the file when a stdio server comes before it", async () => {
    const source = agent("openai", [stdioServer("local"), httpServer("remote", "${env:URL}")]);
    const plan = await planFor(source, { URL: "http://remote.example.com/mcp" });
    expect(plan.issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "stdio-transport-unsupported", path: "tools.mcp[0].transport" }),
      expect.objectContaining({ severity: "blocked", code: "tool-credentials-insecure", path: "tools.mcp[1].transport.url" }),
    ]);
  });

  it("still warns about a custom model address the browser ignores", async () => {
    const plan = await planFor(agent("${env:PROVIDER}", [secure], ['  url: "https://models.example.com"']), { PROVIDER: "openai" });
    expect(plan.issues).toEqual([expect.objectContaining({ severity: "warning", code: "model-url-unsupported", path: "model.url" })]);
  });
});
