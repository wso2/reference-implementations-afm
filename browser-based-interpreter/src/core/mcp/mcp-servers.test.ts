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
import { addMcpServer } from "../agent/agent-source-edit";
import { buildableAgent } from "../agent/agent-validation";
import { DIRECTORY_ENTRIES, type DirectoryEntry } from "./mcp-directory";
import {
  addressNote,
  AUTH_METHODS,
  captureAuthSecrets,
  isSecretAuthField,
  lacksRequiredField,
  listedServer,
  mcpSecretEnvName,
  nameFromUrl,
  prepareServerSave,
  searchDirectory,
  secretFieldState,
} from "./mcp-servers";
import { referencedSecretNames } from "../agent/secret-usage";

function entry(id: string, title = id, description = `the ${id} server`): DirectoryEntry {
  return {
    id,
    title,
    description,
    category: "dev",
    url: `https://${id}.example.com/mcp`,
    publisher: `${id}.example.com`,
    docsUrl: `https://${id}.example.com/docs`,
    auth: { type: "none" },
  };
}

describe("searchDirectory", () => {
  const entries = [
    entry("notion", "Notion", "Pages and databases"),
    entry("linear", "Linear", "Issues and projects"),
    entry("deepwiki", "DeepWiki", "Ask questions about public GitHub repositories"),
    entry("github", "GitHub", "Repositories, issues and pull requests"),
  ];
  const titles = (query: string) => searchDirectory(query, entries).map((found) => found.title);

  it("lists every server alphabetically when nothing is typed", () => {
    expect(titles("")).toEqual(["DeepWiki", "GitHub", "Linear", "Notion"]);
  });

  it("treats a blank query as nothing typed", () => {
    expect(titles("   ")).toEqual(["DeepWiki", "GitHub", "Linear", "Notion"]);
  });

  it("matches the title whatever the case", () => {
    expect(titles("LINEAR")).toEqual(["Linear"]);
  });

  it("matches the description", () => {
    expect(titles("databases")).toEqual(["Notion"]);
  });

  it("matches the publisher", () => {
    expect(titles("notion.example")).toEqual(["Notion"]);
  });

  it("needs every word to match", () => {
    expect(titles("issues projects")).toEqual(["Linear"]);
    expect(titles("issues notion")).toEqual([]);
  });

  it("puts a title match before one that only mentions the word", () => {
    expect(titles("github")).toEqual(["GitHub", "DeepWiki"]);
  });

  it("finds nothing for a word no server uses", () => {
    expect(titles("zzz")).toEqual([]);
  });

  it("leaves the list it searches in the order it had", () => {
    searchDirectory("", entries);
    expect(entries.map((found) => found.id)).toEqual(["notion", "linear", "deepwiki", "github"]);
  });

  it("searches the shipped directory when given no list", () => {
    expect(searchDirectory("linear")[0]?.id).toBe("linear");
    expect(searchDirectory("")).toHaveLength(DIRECTORY_ENTRIES.length);
  });
});

describe("listedServer", () => {
  it("finds the entry for the exact address of a directory server", () => {
    expect(listedServer("https://ai.todoist.net/mcp")?.id).toBe("todoist");
  });

  it("finds nothing for an address that is not in the directory", () => {
    expect(listedServer("https://mcp.example.com/mcp")).toBeUndefined();
  });

  it("finds each directory server by its own address", () => {
    for (const entry of DIRECTORY_ENTRIES) expect(listedServer(entry.url)?.id).toBe(entry.id);
  });
});

describe("the name a directory server is added under", () => {
  it("is its directory id, for every server in the directory", () => {
    for (const entry of DIRECTORY_ENTRIES) {
      expect(nameFromUrl(entry.url, [], listedServer(entry.url)?.id)).toBe(entry.id);
    }
  });

  it("is never a bare word taken from the front of the address", () => {
    const names = DIRECTORY_ENTRIES.map((entry) => nameFromUrl(entry.url, [], listedServer(entry.url)?.id));
    for (const bad of ["ai", "docs", "learn", "bindings", "knowledge-mcp", "netlify-mcp", "asset-management"]) {
      expect(names).not.toContain(bad);
    }
  });

  it("is different for every server, so adding two never makes one overwrite the other", () => {
    const names = DIRECTORY_ENTRIES.map((entry) => nameFromUrl(entry.url, [], listedServer(entry.url)?.id));
    expect(new Set(names).size).toBe(names.length);
  });
});

const FILE = `---
name: Fixture
model:
  provider: openai
  name: gpt-4o
  authentication:
    type: api-key
    api_key: \${env:MODEL_KEY}
---

# Role
Keep this role exactly.

# Instructions
- Keep **formatting** and comments.
`;

const server = { name: "acme", url: "https://acme.example/mcp" };
type Save = Parameters<typeof prepareServerSave>[0];

function save(overrides: Partial<Save> = {}) {
  return prepareServerSave({
    content: FILE,
    editing: null,
    server,
    knownSecrets: [],
    tools: null,
    allowed: [],
    ...overrides,
  });
}

function configured(content: string) {
  const parsed = buildableAgent(content);
  if (!parsed.ok) throw new Error("Invalid fixture result");
  return parsed.metadata.tools?.mcp?.find((item) => item.name === "acme");
}

describe("server authentication fields", () => {
  it("keeps the supported methods, field order and required rules explicit", () => {
    expect(
      AUTH_METHODS.map((method) => [method.id, method.fields.map((field) => [field.key, field.required])]),
    ).toEqual([
      ["none", []],
      ["bearer", [["token", true]]],
      [
        "api-key",
        [
          ["api_key", true],
          ["header_name", false],
        ],
      ],
      [
        "oauth2",
        [
          ["authorize_url", true],
          ["token_url", true],
          ["client_id", true],
          ["scopes", false],
        ],
      ],
    ]);
  });

  it.each(AUTH_METHODS)("requires every required field of $id and no optional ones", (method) => {
    const fields = Object.fromEntries(
      method.fields.filter((field) => field.required).map((field) => [field.key, "fixture"]),
    );
    expect(lacksRequiredField(method.fields, { type: method.id, fields })).toBe(false);
    for (const field of method.fields.filter((field) => field.required)) {
      const partial = { ...fields };
      delete partial[field.key];
      expect(lacksRequiredField(method.fields, { type: method.id, fields: partial })).toBe(true);
    }
  });
});

describe("nameFromUrl", () => {
  it.each([
    ["not a URL", [], ""],
    ["https://mcp.api.www.Acme.example/mcp", [], "acme"],
    ["https://acme.example/mcp", ["acme", "acme-2"], "acme-3"],
    ["https://localhost:8080/mcp", [], "localhost"],
    ["https://www.mcp.api/mcp", [], "wwwmcpapi"],
    ["https://ai.acme.example/mcp", [], "acme"],
    ["https://app.acme.example/mcp", [], "acme"],
  ] as [string, string[], string][])("names %s without changing the URL rule", (url, taken, expected) => {
    expect(nameFromUrl(url, taken)).toBe(expected);
  });

  it("uses the directory's own id for a listed server, whatever its address looks like", () => {
    expect(nameFromUrl("https://ai.todoist.net/mcp", [], "todoist")).toBe("todoist");
    expect(nameFromUrl("https://mcp.ai.pulumi.com/mcp", [], "pulumi")).toBe("pulumi");
  });

  it("numbers a listed server's name when the agent already has one with that name", () => {
    expect(nameFromUrl("https://ai.todoist.net/mcp", ["todoist"], "todoist")).toBe("todoist-2");
    expect(nameFromUrl("https://ai.todoist.net/mcp", ["todoist", "todoist-2"], "todoist")).toBe("todoist-3");
  });
});

describe("prepareServerSave", () => {
  it("leaves an unlisted server unrestricted and preserves the body byte for byte", () => {
    const result = save();
    expect(configured(result.content)?.tool_filter).toBeUndefined();
    expect(configured(result.content)?.transport).toEqual({ type: "http", url: server.url });
    expect(result.content.split("---").slice(2).join("---")).toBe(FILE.split("---").slice(2).join("---"));
    expect(result.secrets).toEqual([]);
  });

  it("distinguishes an explicit empty tool list from an unlisted one", () => {
    expect(configured(save({ tools: [] }).content)?.tool_filter).toEqual({ allow: [] });
  });

  it("writes allow and deny lists in discovered order, ignoring selections not in the list", () => {
    const result = save({
      tools: [{ name: "search" }, { name: "delete" }, { name: "read" }],
      allowed: ["read", "absent", "search"],
    });
    expect(configured(result.content)?.tool_filter).toEqual({ allow: ["search", "read"], deny: ["delete"] });
  });

  it("avoids both referenced and device-held credential names", () => {
    const result = save({
      content: FILE.replace("MODEL_KEY", "ACME_TOKEN"),
      server: { ...server, auth: { type: "bearer", fields: { token: "fake-local-token" } } },
      knownSecrets: ["ACME_TOKEN_2"],
    });
    expect(result.secrets).toEqual([{ name: "ACME_TOKEN_3", value: "fake-local-token" }]);
    expect(result.content).toContain("${env:ACME_TOKEN_3}");
    expect(result.content).not.toContain("fake-local-token");
  });

  it("reuses a removed block's name unless that name is still held on the device", () => {
    const content = addMcpServer(FILE, { ...server, auth: { type: "bearer", fields: { token: "${env:ACME_TOKEN}" } } });
    const replacement = { ...server, auth: { type: "bearer", fields: { token: "replacement" } } };
    expect(save({ content, editing: "acme", server: replacement }).secrets[0]?.name).toBe("ACME_TOKEN");
    expect(save({ content, editing: "acme", server: replacement, knownSecrets: ["ACME_TOKEN"] }).secrets[0]?.name).toBe(
      "ACME_TOKEN_2",
    );
  });

  it("keeps existing references and OAuth configuration out of the capture list", () => {
    const auth = {
      type: "oauth2",
      fields: {
        authorize_url: "https://acme.example/auth",
        token_url: "https://acme.example/token",
        client_id: "public",
        grant_type: "authorization_code",
      },
      scopes: ["read", "write"],
    };
    const result = save({ server: { ...server, auth } });
    expect(result.secrets).toEqual([]);
    expect(configured(result.content)?.transport).toMatchObject({
      authentication: { type: auth.type, ...auth.fields, scopes: auth.scopes },
    });
    expect(
      save({ server: { ...server, auth: { type: "bearer", fields: { token: "${env:EXISTING}" } } } }).secrets,
    ).toEqual([]);
  });

  it("does not mutate the supplied server, tools, allowed names, or known credentials", () => {
    const input: Save = {
      content: FILE,
      editing: null,
      server: { ...server, auth: { type: "api-key", fields: { api_key: "fake-key", header_name: "X-Key" } } },
      tools: [{ name: "read" }],
      allowed: ["read"],
      knownSecrets: [],
    };
    const before = structuredClone(input);
    Object.freeze(input.server.auth!.fields);
    Object.freeze(input.server.auth);
    Object.freeze(input.server);
    Object.freeze(input.tools);
    Object.freeze(input.allowed);
    Object.freeze(input.knownSecrets);
    prepareServerSave(input);
    expect(input).toEqual(before);
  });
});

describe("addressNote", () => {
  it("says nothing for a web address, an empty box or an address with a variable in it", () => {
    expect(addressNote("https://mcp.example.com/mcp")).toBeNull();
    expect(addressNote("  http://localhost:8080/mcp ")).toBeNull();
    expect(addressNote("")).toBeNull();
    expect(addressNote("${env:MCP_URL}")).toBeNull();
  });

  it("allows plain http only for this computer, because every other address is reached through the proxy over https", () => {
    for (const local of ["http://localhost:8080/mcp", "http://127.0.0.1/mcp", "http://[::1]:9000/mcp"]) {
      expect(addressNote(local)).toBeNull();
    }
    expect(addressNote("http://mcp.example.com/mcp")).toBe(
      "Invalid address `http://mcp.example.com/mcp`. Start it with `https://`.",
    );
  });

  it("still judges the scheme written in front of a variable, and leaves the rest of such an address alone", () => {
    expect(addressNote("ftp://example.com/${env:PATH}")).toBe("Invalid address `ftp://example.com/${env:PATH}`. Start it with `https://`.");
    for (const open of ["https://example.com/${env:PATH}", "http://${env:HOST}/mcp", "${env:SCHEME}://example.com/mcp"]) {
      expect(addressNote(open)).toBeNull();
    }
  });

  it("allows every 127.x.x.x address on this computer, like the check that refuses credentials over plain http", () => {
    expect(addressNote("http://127.8.9.10:8080/mcp")).toBeNull();
  });

  it("refuses a user name or password written inside the address", () => {
    const note = "An address cannot contain a user name or password. Put credentials in a key box instead.";
    expect(addressNote("https://user:secret@mcp.example.com/mcp")).toBe(note);
    expect(addressNote("https://token@mcp.example.com/mcp")).toBe(note);
  });

  it("says it as a plain statement for anything that is not a web address", () => {
    expect(addressNote("not-a-url")).toBe("Invalid address `not-a-url`. Start it with `https://`.");
    expect(addressNote("example.com/mcp")).toBe("Invalid address `example.com/mcp`. Start it with `https://`.");
    expect(addressNote(" ftp://example.com ")).toBe("Invalid address `ftp://example.com`. Start it with `https://`.");
  });
});

describe("isSecretAuthField", () => {
  it("is true for the fields that hold a credential", () => {
    expect(["token", "api_key"].every(isSecretAuthField)).toBe(true);
  });

  it("is false for the fields that only describe how to connect", () => {
    const config = ["header_name", "authorize_url", "token_url", "client_id", "scopes"];
    expect(config.some(isSecretAuthField)).toBe(false);
  });
});

describe("mcpSecretEnvName", () => {
  it("names a secret after its server and its field", () => {
    expect(mcpSecretEnvName("huggingface", "token", [])).toBe("HUGGINGFACE_TOKEN");
  });

  it("uses the right suffix per field", () => {
    expect(mcpSecretEnvName("acme", "token", [])).toBe("ACME_TOKEN");
    expect(mcpSecretEnvName("acme", "api_key", [])).toBe("ACME_API_KEY");
  });

  it("turns anything that is not a letter or digit into a single underscore", () => {
    expect(mcpSecretEnvName("my-server.example", "token", [])).toBe("MY_SERVER_EXAMPLE_TOKEN");
    expect(mcpSecretEnvName("a  b", "token", [])).toBe("A_B_TOKEN");
  });

  it("does not leave a leading or trailing underscore", () => {
    expect(mcpSecretEnvName("-edge-", "token", [])).toBe("EDGE_TOKEN");
    expect(mcpSecretEnvName("!!!", "token", [])).toBe("MCP_TOKEN");
  });

  it("steps aside from a name already spoken for", () => {
    expect(mcpSecretEnvName("acme", "token", ["ACME_TOKEN"])).toBe("ACME_TOKEN_2");
    expect(mcpSecretEnvName("acme", "token", ["ACME_TOKEN", "ACME_TOKEN_2"])).toBe("ACME_TOKEN_3");
  });

  it("ignores names that do not clash", () => {
    expect(mcpSecretEnvName("acme", "token", ["OTHER_TOKEN", "ACME_API_KEY"])).toBe("ACME_TOKEN");
  });
});

describe("captureAuthSecrets", () => {
  it("takes a typed token out of the file and leaves a reference", () => {
    const { fields, secrets } = captureAuthSecrets("huggingface", { token: "hf_realvalue" }, []);
    expect(fields).toEqual({ token: "${env:HUGGINGFACE_TOKEN}" });
    expect(secrets).toEqual([{ name: "HUGGINGFACE_TOKEN", value: "hf_realvalue" }]);
  });

  it("does not make a reference or a secret out of a credential that is empty or only spaces", () => {
    const { fields, secrets } = captureAuthSecrets("acme", { api_key: "   ", header_name: "X-Key" }, []);
    expect(fields).toEqual({ header_name: "X-Key" });
    expect(secrets).toEqual([]);
  });

  it("leaves the fields that are not credentials exactly as typed", () => {
    const { fields, secrets } = captureAuthSecrets("acme", { header_name: "X-Key", api_key: "hunter2" }, []);
    expect(fields.header_name).toBe("X-Key");
    expect(fields.api_key).toBe("${env:ACME_API_KEY}");
    expect(secrets).toEqual([{ name: "ACME_API_KEY", value: "hunter2" }]);
  });

  it("never captures an oauth2 block, which holds no credential of its own", () => {
    const oauth = {
      authorize_url: "https://a/authorize",
      token_url: "https://a/token",
      client_id: "public-id",
      grant_type: "authorization_code",
    };
    const { fields, secrets } = captureAuthSecrets("acme", oauth, []);
    expect(fields).toEqual(oauth);
    expect(secrets).toEqual([]);
  });

  it("keeps a reference the file already had, so re-saving does not rename it", () => {
    const { fields, secrets } = captureAuthSecrets("acme", { token: "${env:MY_OWN_NAME}" }, []);
    expect(fields.token).toBe("${env:MY_OWN_NAME}");
    expect(secrets).toEqual([]);
  });

  it("steps aside from a name the file already uses elsewhere", () => {
    const { fields, secrets } = captureAuthSecrets("acme", { token: "raw" }, ["ACME_TOKEN"]);
    expect(fields.token).toBe("${env:ACME_TOKEN_2}");
    expect(secrets[0]?.name).toBe("ACME_TOKEN_2");
  });

  it("returns nothing to store when there is nothing sensitive", () => {
    const { secrets } = captureAuthSecrets("acme", { header_name: "X-API-Key" }, []);
    expect(secrets).toEqual([]);
  });
});

describe("secretFieldState", () => {
  const ref = "${env:HUGGINGFACE_TOKEN}";

  it("is saved once the worker can answer for the name", () => {
    expect(secretFieldState(ref, undefined, ["HUGGINGFACE_TOKEN"])).toBe("saved");
  });

  it("is missing when the file references a name nobody has", () => {
    expect(secretFieldState(ref, undefined, [])).toBe("missing");
  });

  it("is empty when the file holds no reference at all", () => {
    expect(secretFieldState("", undefined, ["HUGGINGFACE_TOKEN"])).toBe("empty");
    expect(secretFieldState("a-raw-legacy-value", undefined, [])).toBe("empty");
  });

  it("is editing the moment the user touches the box, whatever is stored", () => {
    expect(secretFieldState(ref, "new", ["HUGGINGFACE_TOKEN"])).toBe("editing");
    expect(secretFieldState(ref, "", ["HUGGINGFACE_TOKEN"])).toBe("editing");
  });
});

const TESTER_FILE = `---
name: Tester
model:
  provider: anthropic
  authentication:
    type: api-key
    api_key: \${env:ANTHROPIC_API_KEY}
---

# Role
r

# Instructions
i
`;

function saveWith(
  content: string,
  server: { name: string; url: string; type: string; fields: Record<string, string> },
  editing: string | null = null,
): { content: string; stored: { name: string; value: string }[] } {
  const next = prepareServerSave({
    content,
    editing,
    server: { name: server.name, url: server.url, auth: { type: server.type, fields: server.fields } },
    knownSecrets: [],
    tools: null,
    allowed: [],
  });
  return { content: next.content, stored: next.secrets };
}

describe("adding an MCP server that needs a credential", () => {
  const bearer = {
    name: "huggingface",
    url: "https://hf.co/mcp",
    type: "bearer",
    fields: { token: "hf_a_real_token_value" },
  };

  it("never writes the credential into the agent file", () => {
    const { content } = saveWith(TESTER_FILE, bearer);
    expect(content).not.toContain("hf_a_real_token_value");
    expect(content).toContain("${env:HUGGINGFACE_TOKEN}");
  });

  it("hands the credential over to be stored instead", () => {
    const { stored } = saveWith(TESTER_FILE, bearer);
    expect(stored).toEqual([{ name: "HUGGINGFACE_TOKEN", value: "hf_a_real_token_value" }]);
  });

  it("leaves a file the agent can still read, referencing both secrets", () => {
    const { content } = saveWith(TESTER_FILE, bearer);
    const names = referencedSecretNames(content);
    expect(names).toContain("ANTHROPIC_API_KEY");
    expect(names).toContain("HUGGINGFACE_TOKEN");
  });

  it("keeps a non-credential field readable in the file", () => {
    const { content, stored } = saveWith(TESTER_FILE, {
      name: "acme",
      url: "https://acme/mcp",
      type: "api-key",
      fields: { header_name: "X-Acme-Key", api_key: "hunter2" },
    });
    expect(content).toContain("X-Acme-Key");
    expect(content).not.toContain("hunter2");
    expect(stored).toEqual([{ name: "ACME_API_KEY", value: "hunter2" }]);
  });

  it("does not collide with a name the file already uses", () => {
    const withToken = saveWith(TESTER_FILE, bearer).content;
    const { content, stored } = saveWith(withToken, {
      ...bearer,
      name: "huggingface",
      url: "https://other/mcp",
    });
    expect(stored[0]?.name).toBe("HUGGINGFACE_TOKEN_2");
    expect(content).toContain("${env:HUGGINGFACE_TOKEN_2}");
  });
});

describe("re-saving a server that was already captured", () => {
  it("reuses the same name rather than inventing a second one", () => {
    const first = saveWith(TESTER_FILE, {
      name: "huggingface",
      url: "https://hf.co/mcp",
      type: "bearer",
      fields: { token: "hf_original" },
    });
    const again = saveWith(
      first.content,
      { name: "huggingface", url: "https://hf.co/mcp", type: "bearer", fields: { token: "${env:HUGGINGFACE_TOKEN}" } },
      "huggingface",
    );
    expect(again.content).toContain("${env:HUGGINGFACE_TOKEN}");
    expect(again.content).not.toContain("HUGGINGFACE_TOKEN_2");
    expect(again.stored).toEqual([]);
  });

  it("files a replacement under the same name, not a new one", () => {
    const first = saveWith(TESTER_FILE, {
      name: "huggingface",
      url: "https://hf.co/mcp",
      type: "bearer",
      fields: { token: "hf_original" },
    });
    const replaced = saveWith(
      first.content,
      { name: "huggingface", url: "https://hf.co/mcp", type: "bearer", fields: { token: "hf_replacement" } },
      "huggingface",
    );
    expect(replaced.stored).toEqual([{ name: "HUGGINGFACE_TOKEN", value: "hf_replacement" }]);
    expect(replaced.content).not.toContain("hf_replacement");
  });
});

describe("a file that still holds a raw credential", () => {
  it("moves it out of the file on the next save", () => {
    const legacy = addMcpServer(TESTER_FILE, {
      name: "legacy",
      url: "https://legacy/mcp",
      auth: { type: "bearer", fields: { token: "raw_left_in_the_file" } },
    });
    expect(legacy).toContain("raw_left_in_the_file");

    const { content, stored } = saveWith(
      legacy,
      { name: "legacy", url: "https://legacy/mcp", type: "bearer", fields: { token: "raw_left_in_the_file" } },
      "legacy",
    );
    expect(content).not.toContain("raw_left_in_the_file");
    expect(stored).toEqual([{ name: "LEGACY_TOKEN", value: "raw_left_in_the_file" }]);
  });
});

describe("editing a server whose tool list is not available", () => {
  const filtered = (filter: string) =>
    FILE.replace(
      "---\n\n# Role",
      `tools:\n  mcp:\n    - name: acme\n      tool_filter:\n${filter}\n      transport:\n        type: http\n        url: https://acme.example/mcp\n---\n\n# Role`,
    );
  const filterOf = (content: string, name = "acme") => {
    const parsed = buildableAgent(content);
    if (!parsed.ok) throw new Error("Invalid fixture result");
    return parsed.metadata.tools?.mcp?.find((item) => item.name === name)?.tool_filter;
  };

  it("keeps the allowed and denied tools the file already had", () => {
    const content = filtered("        allow:\n          - read\n        deny:\n          - delete");
    expect(filterOf(save({ content, editing: "acme" }).content)).toEqual({ allow: ["read"], deny: ["delete"] });
  });

  it("keeps a list that only denies tools as it was, without turning it into an allow list", () => {
    const content = filtered("        deny:\n          - delete");
    expect(filterOf(save({ content, editing: "acme" }).content)).toEqual({ deny: ["delete"] });
  });

  it("keeps it when the server is renamed", () => {
    const content = filtered("        allow:\n          - read");
    const renamed = save({ content, editing: "acme", server: { name: "acme-2", url: "https://acme.example/mcp" } });
    expect(filterOf(renamed.content, "acme-2")).toEqual({ allow: ["read"] });
  });

  it("is replaced by the new choice when the tool list is available", () => {
    const content = filtered("        allow:\n          - read");
    const tools = [{ name: "read", description: "" }, { name: "write", description: "" }];
    expect(filterOf(save({ content, editing: "acme", tools, allowed: ["write"] }).content)).toEqual({ allow: ["write"], deny: ["read"] });
  });
});

describe("lacksRequiredField", () => {
  const token = [{ key: "token", required: true }];
  const signIn = [
    { key: "authorize_url", required: true },
    { key: "token_url", required: true },
  ];

  it("is true while a required field is not in what would be written", () => {
    expect(lacksRequiredField(token, { type: "bearer", fields: {} })).toBe(true);
  });

  it("is false once the required field is given", () => {
    expect(lacksRequiredField(token, { type: "bearer", fields: { token: "${env:HF_TOKEN}" } })).toBe(false);
  });

  it("wants every required field of a method, not just one", () => {
    expect(lacksRequiredField(signIn, { type: "oauth2", fields: { authorize_url: "https://a/authorize" } })).toBe(true);
    expect(lacksRequiredField(signIn, { type: "oauth2", fields: { authorize_url: "https://a/authorize", token_url: "https://a/token" } })).toBe(false);
  });

  it("counts a field that is empty or only spaces as missing", () => {
    expect(lacksRequiredField(token, { type: "bearer", fields: { token: "" } })).toBe(true);
    expect(lacksRequiredField(token, { type: "bearer", fields: { token: "   " } })).toBe(true);
  });

  it("does not ask for an optional field", () => {
    expect(lacksRequiredField([{ key: "header_name", required: false }], { type: "api-key", fields: {} })).toBe(false);
  });

  it("asks for nothing when the server signs in with no method", () => {
    expect(lacksRequiredField([], undefined)).toBe(false);
  });
});
