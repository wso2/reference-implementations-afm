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

import { describe, it, expect } from "vitest";
import { loadAfm, buildSystemPrompt } from "./load";
import { AfmParseError, AfmValidationError, VariableResolutionError } from "./errors";
import type { SecretPort } from "./types";

function fakeSecrets(values: Record<string, string>): SecretPort {
  return {
    async resolve(ref) {
      const v = values[ref.name];
      if (v === undefined || v === "") {
        return { status: "unresolved", reason: `'${ref.name}' not found` };
      }
      return { status: "resolved", value: v };
    },
  };
}

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
        : ["model:", "  provider: openai", "tools:", "  mcp:", "    - name: s", "      transport:", "        type: http", "        url: https://s.example/mcp", "        authentication:", ...indent(authentication, 10)];
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
