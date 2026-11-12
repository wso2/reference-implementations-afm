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

import { splitFrontmatter } from "@afm/engine";
import { secretNameOf } from "./secret-reference";
import { describe, expect, it } from "vitest";
import {
  addMcpServer,
  agentBrief,
  getFrontmatterScalar,
  getModelApiKey,
  getModelField,
  getSection,
  removeMcpServer,
  setFrontmatterValue,
  setModelApiKey,
  setModelField,
  setSection,
  setServerToolFilter,
  withoutSectionHeadings,
} from "./agent-source-edit";
import { buildableAgent, previewAgent } from "./agent-validation";

const FULL = `---
name: Tester
model:
  provider: openai
  name: gpt-4o
  authentication:
    type: api-key
    api_key: \${env:OPENAI_API_KEY}
tools:
  mcp:
    - name: deepwiki
      transport:
        type: http
---

# Role
r
`;

describe("model frontmatter editing", () => {
  it("reads the model's own provider and name", () => {
    expect(getModelField(FULL, "provider")).toBe("openai");
    expect(getModelField(FULL, "name")).toBe("gpt-4o");
  });

  it("does not confuse an MCP server's name with the model's name", () => {
    expect(getModelField(FULL, "name")).not.toBe("deepwiki");
  });

  it("rewrites only the target line", () => {
    const next = setModelField(FULL, "name", "claude-opus-5");
    expect(getModelField(next, "name")).toBe("claude-opus-5");
    expect(getModelField(next, "provider")).toBe("openai");
    expect(next).toContain("api_key: ${env:OPENAI_API_KEY}");
    expect(next).toContain("- name: deepwiki");
    expect(next.split("\n").length).toBe(FULL.split("\n").length);
  });

  it("keeps the body and the rest of the frontmatter byte-identical", () => {
    const next = setModelField(FULL, "provider", "anthropic");
    expect(next.slice(next.indexOf("# Role"))).toBe(FULL.slice(FULL.indexOf("# Role")));
    expect(next).toContain("  provider: anthropic\n");
  });

  it("adds the key when the model block does not have it yet", () => {
    const source = "---\nname: Tester\nmodel:\n  provider: openai\n---\n\n# Role\nr\n";
    const next = setModelField(source, "name", "gpt-4o");
    expect(getModelField(next, "name")).toBe("gpt-4o");
    expect(getModelField(next, "provider")).toBe("openai");
  });

  it("creates the whole model block when the file has none", () => {
    const source = "---\nname: Tester\n---\n\n# Role\nr\n";
    const next = setModelField(source, "provider", "anthropic");
    expect(next).toContain("model:\n  provider: anthropic");
    expect(getModelField(next, "provider")).toBe("anthropic");
  });

  it("preserves a four-space indent style", () => {
    const source = "---\nmodel:\n    provider: openai\n    name: gpt-4o\n---\n\n# Role\nr\n";
    const next = setModelField(source, "name", "gpt-4o-mini");
    expect(next).toContain("    name: gpt-4o-mini");
    expect(next).not.toContain("  name: gpt-4o-mini\n  ");
  });

  it("writes an empty value as an empty string, never as YAML null", () => {
    const next = setModelField(FULL, "name", "");
    expect(next).toContain('name: ""');
    expect(next).not.toMatch(/^ +name:\s*$/m);
    expect(getModelField(next, "name")).toBe("");
  });

  it("quotes a value that would otherwise change the YAML shape", () => {
    const next = setModelField(FULL, "name", "weird: model");
    expect(next).toContain('name: "weird: model"');
    expect(getModelField(next, "name")).toBe("weird: model");
  });

  it("leaves an inline `model:` shorthand alone rather than rewriting its shape", () => {
    const source = "---\nname: Tester\nmodel: gpt-4o\n---\n\n# Role\nr\n";
    expect(getModelField(source, "name")).toBe("");
  });

  it("creates frontmatter when editing a file without it", () => {
    expect(getModelField("# Role\nr\n", "provider")).toBe("");
    expect(setModelField("# Role\nr\n", "provider", "openai")).toBe(
      "---\nmodel:\n  provider: openai\n---\n# Role\nr\n",
    );
  });
});

describe("model api_key editing", () => {
  it("reads api_key from inside the authentication mapping", () => {
    expect(getModelApiKey(FULL)).toBe("${env:OPENAI_API_KEY}");
  });

  it("rewrites only the api_key line, leaving the rest of the file alone", () => {
    const next = setModelApiKey(FULL, "${env:ANTHROPIC_API_KEY}");
    expect(next).toContain("    api_key: ${env:ANTHROPIC_API_KEY}");
    expect(next).toContain("    type: api-key");
    expect(next).toContain("      transport:");
    expect(getModelField(next, "name")).toBe("gpt-4o");
  });

  it("keeps the author's quoting style", () => {
    const quoted = FULL.replace("api_key: ${env:OPENAI_API_KEY}", 'api_key: "${env:OPENAI_API_KEY}"');
    expect(setModelApiKey(quoted, "${env:ANTHROPIC_API_KEY}")).toContain('api_key: "${env:ANTHROPIC_API_KEY}"');
  });

  it("ignores an api_key belonging to a tool server, not the model", () => {
    const toolKey = `---
name: Tester
model:
  provider: openai
  name: gpt-4o
tools:
  mcp:
    - name: svc
      transport:
        authentication:
          api_key: \${env:TOOL_KEY}
---

# Role
r
`;
    expect(getModelApiKey(toolKey)).toBe("");
    const next = setModelApiKey(toolKey, "${env:ANTHROPIC_API_KEY}");
    expect(next).toContain("api_key: ${env:TOOL_KEY}");
    expect(getModelApiKey(next)).toBe("${env:ANTHROPIC_API_KEY}");
  });

  it("creates the authentication block when the file has none", () => {
    const bare = "---\nname: T\nmodel:\n  provider: openai\n  name: gpt-4o\n---\n\n# Role\nr\n";
    const next = setModelApiKey(bare, "${env:ANTHROPIC_API_KEY}");
    expect(getModelApiKey(next)).toBe("${env:ANTHROPIC_API_KEY}");
    expect(next).toContain("type: api-key");
  });
});

const WITH_SERVERS = `---
name: Foreman
model:
  provider: anthropic
  name: claude-sonnet-5
tools:
  mcp:
    - name: gitlab
      transport:
        type: http
        url: https://gitlab.com/api/v4/mcp
    - name: deepwiki
      transport:
        type: http
        url: https://mcp.deepwiki.com/mcp
---

# Role
r
`;

describe("setServerToolFilter", () => {
  it("adds an allow-list to the named server only", () => {
    const next = setServerToolFilter(WITH_SERVERS, "gitlab", ["list_issues", "get_issue"]);
    expect(next).toContain("      tool_filter:\n        allow:\n          - list_issues\n          - get_issue");
    expect(next).toContain("    - name: deepwiki\n      transport:");
  });

  it("writes the tools turned off as a deny-list beside the allow-list", () => {
    const next = setServerToolFilter(WITH_SERVERS, "gitlab", ["list_issues"], ["delete_issue", "close_issue"]);
    expect(next).toContain(
      "      tool_filter:\n        allow:\n          - list_issues\n        deny:\n          - delete_issue\n          - close_issue",
    );
  });

  it("writes no deny-list when nothing is turned off, and replaces one that was there", () => {
    const once = setServerToolFilter(WITH_SERVERS, "gitlab", ["a"], ["b"]);
    const twice = setServerToolFilter(once, "gitlab", ["a", "b"]);
    expect(twice).not.toContain("deny");
    expect(twice.match(/tool_filter:/g)).toHaveLength(1);
  });

  it("keeps every other line of the file exactly as it was", () => {
    const next = setServerToolFilter(WITH_SERVERS, "gitlab", ["list_issues"]);
    expect(next).toContain("url: https://gitlab.com/api/v4/mcp");
    expect(next).toContain("# Role");
    expect(next).toContain("name: claude-sonnet-5");
  });

  it("replaces an allow-list that is already there rather than adding a second", () => {
    const once = setServerToolFilter(WITH_SERVERS, "gitlab", ["a", "b"]);
    const twice = setServerToolFilter(once, "gitlab", ["c"]);
    expect(twice.match(/tool_filter:/g)).toHaveLength(1);
    expect(twice).toContain("- c");
    expect(twice).not.toContain("- a");
  });

  it("removes the block when nothing is filtered out", () => {
    const once = setServerToolFilter(WITH_SERVERS, "gitlab", ["a"]);
    const cleared = setServerToolFilter(once, "gitlab", null);
    expect(cleared).not.toContain("tool_filter");
    expect(cleared).toContain("- name: gitlab");
  });

  it("writes to the second server without disturbing the first", () => {
    const next = setServerToolFilter(WITH_SERVERS, "deepwiki", ["search"]);
    const gitlabPart = next.slice(next.indexOf("- name: gitlab"), next.indexOf("- name: deepwiki"));
    expect(gitlabPart).not.toContain("tool_filter");
    expect(next.slice(next.indexOf("- name: deepwiki"))).toContain("tool_filter");
  });

  it("leaves a file alone when the server is not in it", () => {
    expect(setServerToolFilter(WITH_SERVERS, "nope", ["a"])).toBe(WITH_SERVERS);
  });

  it("leaves a file with no tools block alone", () => {
    const plain = "---\nname: T\n---\n\n# Role\nr\n";
    expect(setServerToolFilter(plain, "gitlab", ["a"])).toBe(plain);
  });
});

describe("reading the brief and the key it points at", () => {
  const file = [
    "---",
    "name: a",
    "model:",
    "  provider: anthropic",
    "  authentication:",
    "    api_key: ${env:MY_OWN_KEY}",
    "---",
    "",
    "# Role",
    "",
    "A helper.",
    "",
  ].join("\n");

  it("treats the prose below the frontmatter as the brief", () => {
    expect(agentBrief(file)).toBe("# Role\n\nA helper.");
  });

  it("ignores frontmatter changes", () => {
    expect(agentBrief(file.replace("anthropic", "openai"))).toBe(agentBrief(file));
  });

  it("notices a rewritten role", () => {
    expect(agentBrief(file.replace("A helper.", "A poet."))).not.toBe(agentBrief(file));
  });

  it("reads the key reference the file actually points at", () => {
    expect(secretNameOf(getModelApiKey(file))).toBe("MY_OWN_KEY");
  });
});

describe("quoted scalars", () => {
  const file = (body: string) => `---\n${body}\n---\n\n# Role\nr\n\n# Instructions\ni\n`;

  it("reads a double-quoted value", () => {
    expect(getFrontmatterScalar(file(`name: "My Agent"`), "name")).toBe("My Agent");
  });

  it("reads a single-quoted value", () => {
    expect(getFrontmatterScalar(file(`name: 'My Agent'`), "name")).toBe("My Agent");
  });

  it("unescapes a doubled quote inside a single-quoted value", () => {
    expect(getFrontmatterScalar(file(`name: 'It''s mine'`), "name")).toBe("It's mine");
  });

  it("leaves an unquoted value alone", () => {
    expect(getFrontmatterScalar(file("name: My Agent"), "name")).toBe("My Agent");
  });

  it("applies the same rules inside the model block", () => {
    expect(getModelField(file("model:\n  provider: 'anthropic'"), "provider")).toBe("anthropic");
    expect(getModelField(file('model:\n  name: "claude-opus-5"'), "name")).toBe("claude-opus-5");
  });

  it("does not mistake an apostrophe for a quoted value", () => {
    expect(getFrontmatterScalar(file("description: it's fine"), "description")).toBe("it's fine");
  });
});

describe("a file with blank lines before the opening fence", () => {
  const source = `\n\n${FULL}`;

  it("reads and edits the model like any other file", () => {
    expect(getModelField(source, "name")).toBe("gpt-4o");
    const next = setModelField(source, "name", "claude-opus-5");
    expect(getModelField(next, "name")).toBe("claude-opus-5");
    expect(next.startsWith("\n\n---\n")).toBe(true);
  });

  it("adds the model block inside the header, not after it", () => {
    const next = setModelField("\n---\nname: Tester\n---\n\n# Role\nr\n", "provider", "anthropic");
    expect(getModelField(next, "provider")).toBe("anthropic");
    expect(next.indexOf("model:")).toBeLessThan(next.lastIndexOf("---"));
  });

  it("finds the brief after the header", () => {
    expect(agentBrief(source)).toBe(agentBrief(FULL));
  });
});

const BARE = `---
name: Tester
model:
  provider: openai
  name: gpt-4o
  authentication:
    type: api-key
    api_key: \${env:OPENAI_API_KEY}
---

# Role

r

# Instructions

i
`;

const WITH_ONE = BARE.replace(
  "---\n\n# Role",
  `tools:
  mcp:
    - name: deepwiki
      transport:
        type: http
        url: https://mcp.deepwiki.com/mcp
---

# Role`,
);

function servers(content: string) {
  const preview = previewAgent(content);
  if (!preview.ok) throw new Error(`invalid: ${preview.error}`);
  return preview.metadata.tools?.mcp ?? [];
}

describe("adding a server", () => {
  it("creates tools.mcp when the file has neither", () => {
    const next = addMcpServer(BARE, { name: "exa", url: "https://mcp.exa.ai/mcp" });
    const list = servers(next);
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("exa");
  });

  it("appends after the servers already there, rather than inside the last one", () => {
    const next = addMcpServer(WITH_ONE, { name: "exa", url: "https://mcp.exa.ai/mcp" });
    expect(servers(next).map((s) => s.name)).toEqual(["deepwiki", "exa"]);
  });

  it("writes the auth block for the type chosen", () => {
    const next = addMcpServer(BARE, {
      name: "gitlab",
      url: "https://gitlab.com/api/v4/mcp",
      auth: {
        type: "oauth2",
        fields: {
          grant_type: "authorization_code",
          authorize_url: "https://gitlab.com/oauth/authorize",
          token_url: "https://gitlab.com/oauth/token",
          client_id: "${env:GITLAB_OAUTH_CLIENT_ID}",
        },
        scopes: ["mcp"],
      },
    });
    const server = servers(next)[0];
    expect(server?.transport.type).toBe("http");
    if (server?.transport.type !== "http") throw new Error("expected http");
    expect(server.transport.authentication?.type).toBe("oauth2");
    expect(server.transport.authentication?.client_id).toBe("${env:GITLAB_OAUTH_CLIENT_ID}");
    expect(server.transport.authentication?.scopes).toEqual(["mcp"]);
  });

  it("leaves an empty field out rather than writing a blank one", () => {
    const next = addMcpServer(BARE, {
      name: "exa",
      url: "https://mcp.exa.ai/mcp",
      auth: { type: "bearer", fields: { token: "${env:EXA_API_KEY}", header_name: "  " } },
    });
    expect(next).not.toContain("header_name");
  });

  it("round-trips: a file with a server added still parses", () => {
    const next = addMcpServer(addMcpServer(BARE, { name: "a", url: "https://a.example/mcp" }), {
      name: "b",
      url: "https://b.example/mcp",
    });
    expect(servers(next).map((s) => s.name)).toEqual(["a", "b"]);
  });
});

describe("removing a server", () => {
  it("takes the whole block, not just its name line", () => {
    const two = addMcpServer(WITH_ONE, { name: "exa", url: "https://mcp.exa.ai/mcp" });
    const next = removeMcpServer(two, "deepwiki");
    expect(servers(next).map((s) => s.name)).toEqual(["exa"]);
    expect(next).not.toContain("deepwiki");
  });

  it("leaves the file alone when the name is not there", () => {
    expect(removeMcpServer(WITH_ONE, "nope")).toBe(WITH_ONE);
  });

  it.each([
    ["in single quotes", "'deepwiki'", "deepwiki"],
    ["in double quotes", '"deepwiki"', "deepwiki"],
    ["with a double quote in it", '"deep\\"wiki"', 'deep"wiki'],
  ])("finds a server whose name is written %s", (_label, written, name) => {
    const file = WITH_ONE.replace("name: deepwiki", `name: ${written}`);
    expect(servers(removeMcpServer(file, name))).toEqual([]);
  });
});

const FILE = `---
name: Tester
model:
  provider: openai
  name: gpt-4o
---

# Role

You are a tester

# Instructions

Be brief
`;

describe("typing in Role and Instructions", () => {
  it("keeps a trailing space so the next word can be typed", () => {
    const typed = setSection(FILE, "Role", "You are a tester ");
    expect(getSection(typed, "Role")).toBe("You are a tester ");
  });

  it("keeps a leading space", () => {
    const typed = setSection(FILE, "Instructions", "  indented on purpose");
    expect(getSection(typed, "Instructions")).toBe("  indented on purpose");
  });

  it("keeps blank lines between paragraphs", () => {
    const body = "First paragraph.\n\nSecond paragraph.";
    expect(getSection(setSection(FILE, "Instructions", body), "Instructions")).toBe(body);
  });

  it("survives being typed one character at a time", () => {
    let content = FILE;
    for (const chunk of ["a", "a ", "a b", "a b ", "a b c"]) {
      content = setSection(content, "Role", chunk);
      expect(getSection(content, "Role")).toBe(chunk);
    }
  });

  it("writes the heading when the file has not got one", () => {
    const bare = "---\nname: Tester\n---\n\n# Role\n\nr\n";
    const next = setSection(bare, "Instructions", "Be brief");
    expect(getSection(next, "Instructions")).toBe("Be brief");
  });

  it("leaves the other section alone", () => {
    const next = setSection(FILE, "Role", "Changed ");
    expect(getSection(next, "Instructions")).toBe("Be brief");
  });
});

describe("removing the last server", () => {
  function ok(content: string) {
    const preview = previewAgent(content);
    if (!preview.ok) throw new Error(preview.error);
    return preview.metadata;
  }

  it("leaves a file that still parses", () => {
    const one = addMcpServer(FILE, { name: "exa", url: "https://mcp.exa.ai/mcp" });
    const none = removeMcpServer(one, "exa");
    expect(() => ok(none)).not.toThrow();
    expect(none).not.toContain("mcp:");
    expect(none).not.toContain("tools:");
  });

  it("keeps tools.mcp when another server is still there", () => {
    const two = addMcpServer(addMcpServer(FILE, { name: "a", url: "https://a.example/mcp" }), {
      name: "b",
      url: "https://b.example/mcp",
    });
    const one = removeMcpServer(two, "a");
    expect(ok(one).tools?.mcp?.map((s) => s.name)).toEqual(["b"]);
  });
});

describe("setting the model key", () => {
  it("creates the authentication block when the file has none", () => {
    const next = setModelApiKey(FILE, "${env:OPENAI_API_KEY}");
    expect(getModelApiKey(next)).toBe("${env:OPENAI_API_KEY}");
    const preview = previewAgent(next);
    expect(preview.ok).toBe(true);
  });

  it("adds the model block when the file has none", () => {
    const bare = "---\nname: Tester\n---\n\n# Role\nr\n";
    const next = setModelApiKey(bare, "${env:OPENAI_API_KEY}");
    expect(getModelApiKey(next)).toBe("${env:OPENAI_API_KEY}");
  });

  it("adds only the key when authentication already exists", () => {
    const withAuth = FILE.replace("  name: gpt-4o", "  name: gpt-4o\n  authentication:\n    type: api-key");
    const next = setModelApiKey(withAuth, "${env:OPENAI_API_KEY}");
    expect(getModelApiKey(next)).toBe("${env:OPENAI_API_KEY}");
    expect(next.match(/authentication:/g)).toHaveLength(1);
  });
});

describe("setFrontmatterValue", () => {
  const ABOUT = `---
name: Tester
description: Old words
authors:
- Ada
- Lin

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

  it("replaces one line and leaves the rest of the file alone", () => {
    const next = setFrontmatterValue(ABOUT, "license", "Apache-2.0");
    expect(next).toBe(ABOUT.replace("license: MIT", "license: Apache-2.0"));
  });

  it("replaces a whole list, in the list style the file already uses", () => {
    const next = setFrontmatterValue(ABOUT, "authors", ["Grace"]);
    expect(next).toContain("authors:\n- Grace\n\nprovider:");
    expect(next).not.toContain("Ada");
    const read = buildableAgent(next);
    expect(read.ok && read.metadata.authors).toEqual(["Grace"]);
  });

  it("rewrites a mapping without touching the model's own provider", () => {
    const next = setFrontmatterValue(ABOUT, "provider", { name: "Other Co", url: "https://example.com" });
    expect(next).toContain("provider:\n  name: Other Co\n  url: https://example.com\nlicense: MIT");
    expect(getModelField(next, "provider")).toBe("openai");
  });

  it("removes the key when the value is empty", () => {
    expect(setFrontmatterValue(ABOUT, "description", "")).not.toContain("description");
    expect(setFrontmatterValue(ABOUT, "authors", [])).not.toContain("authors");
    expect(setFrontmatterValue(ABOUT, "provider", { name: "", url: "" })).not.toContain("Example Co");
  });

  it("adds a missing key below the opening fence", () => {
    const next = setFrontmatterValue(FULL, "description", "Helps people");
    expect(next.startsWith("---\ndescription: Helps people\nname: Tester")).toBe(true);
  });

  it("replaces a multi-line value without leaving pieces of it behind", () => {
    const source = ABOUT.replace("description: Old words", "description: >\n  first\n  second");
    const next = setFrontmatterValue(source, "description", "New");
    expect(next).toContain("description: New\nauthors:");
    expect(next).not.toContain("second");
  });

  it("quotes what plain YAML would misread, so it reads back unchanged", () => {
    const text = "Line one\nline: two # three";
    const next = setFrontmatterValue(ABOUT, "description", text);
    const result = buildableAgent(next);
    expect(result.ok && result.metadata.description).toBe(text);
    const yes = buildableAgent(setFrontmatterValue(ABOUT, "license", "no"));
    expect(yes.ok && yes.metadata.license).toBe("no");
  });

  it("keeps the body byte-identical", () => {
    expect(setFrontmatterValue(ABOUT, "description", "x").endsWith("---\n\n# Role\nr\n")).toBe(true);
  });

  it("creates frontmatter when setting metadata on a file without it", () => {
    expect(setFrontmatterValue("# Role\nr\n", "license", "MIT")).toBe("---\nlicense: MIT\n---\n# Role\nr\n");
  });
});

describe("values written into the file", () => {
  const FILE = "---\nname: A\nmodel:\n  provider: openai\n  name: gpt-4o\n---\n\n# Role\nr\n\n# Instructions\ni\n";
  const AWKWARD = [
    "abc",
    "123",
    "-1",
    ".5",
    "1e3",
    "0x1F",
    "0o7",
    "true",
    "false",
    "null",
    "~",
    "yes",
    "no",
    "on",
    "off",
    "a: b",
    "a #b",
    "#lead",
    "- x",
    "? x",
    "'q'",
    '"q"',
    "tab\tin",
    "é",
    "key=val",
    "https://a.example/x?y=1#z",
    "${env:TOKEN}",
    " lead",
    "trail ",
    "[x]",
    "{x}",
    "*x",
    "&x",
    "!x",
    "%x",
    "@x",
    "`x",
    "|x",
    ">x",
    "a, b",
    "a\\b",
    "x:y",
    "x:",
    ":x",
    "---",
    "...",
    "line one\nline two",
    "a\r\nb",
    "a\u2028b",
  ];
  const parsed = (file: string) =>
    splitFrontmatter(file).frontmatter as { tools?: { mcp?: Record<string, unknown>[] } };
  const server = (file: string) => parsed(file).tools?.mcp?.[0] ?? {};
  const strings = (node: unknown, out: unknown[] = []): unknown[] => {
    if (node !== null && typeof node === "object") for (const value of Object.values(node)) strings(value, out);
    else out.push(node);
    return out;
  };

  it.each(AWKWARD)("keeps %j exactly as typed in a sign-in field", (value) => {
    const file = addMcpServer(FILE, {
      name: "srv",
      url: "https://x.example/mcp",
      auth: { type: "bearer", fields: { token: value } },
    });
    expect(strings(server(file))).toContain(value);
  });

  it.each(AWKWARD)("keeps %j exactly as typed as a server name", (value) => {
    const file = addMcpServer(FILE, { name: value, url: "https://x.example/mcp" });
    expect(server(file).name).toBe(value);
  });

  it("cannot be made to add lines to the file by a line break in what a server supplies", () => {
    const attack = "https://a.example/x\n  injected: true\nmodel:\n  provider: evil";
    const file = addMcpServer(FILE, {
      name: "srv\ninjected: true",
      url: attack,
      auth: {
        type: "oauth2",
        fields: { authorize_url: attack, token_url: attack, client_id: "c\ninjected: true" },
        scopes: ["read\ninjected: true"],
      },
    });
    const tree = parsed(file) as Record<string, unknown>;
    expect(Object.keys(tree).sort()).toEqual(["model", "name", "tools"]);
    expect((tree.model as { provider: string }).provider).toBe("openai");
    expect(JSON.stringify(tree)).not.toContain('"injected":true');
  });

  it("keeps tool names exactly as a server called them, even when they would read as something else", () => {
    const names = ["list_issues", "123", "true", "null", "a: b", "a #b", "x\n  injected: true", "- x"];
    const file = setServerToolFilter(addMcpServer(FILE, { name: "srv", url: "https://x.example/mcp" }), "srv", names, [
      "deny#1",
      "0x1F",
    ]);
    expect(server(file).tool_filter).toEqual({ allow: names, deny: ["deny#1", "0x1F"] });
    expect(Object.keys(parsed(file) as Record<string, unknown>).sort()).toEqual(["model", "name", "tools"]);
  });
});

describe("lines that are mostly spaces", () => {
  const spaces = " ".repeat(200_000);

  it("find a section in a moment when a heading is followed by a very long run of spaces", () => {
    const content = `---\nname: X\n---\n# Role\nhello\n\n# a${spaces}y\n`;
    const started = Date.now();
    expect(getSection(content, "Role")).toBe("hello");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("still ignore trailing spaces after a heading", () => {
    expect(getSection("---\nname: X\n---\n# Role   \nhello\n# Instructions\nbe kind\n", "Role")).toBe("hello");
  });

  it("remove a server in a moment when another server's name line ends in a very long run of spaces", () => {
    const file = `---\nname: X\ntools:\n  mcp:\n    - name: odd${spaces}y\n      transport:\n        type: http\n        url: https://a.example.com/mcp\n    - name: keep\n      transport:\n        type: http\n        url: https://b.example.com/mcp\n---\n`;
    const started = Date.now();
    const next = removeMcpServer(file, "keep");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(next).not.toContain("name: keep");
    expect(next).toContain("name: odd");
  });

  it("find a server whose name is quoted or followed by spaces", () => {
    const file = `---\nname: X\ntools:\n  mcp:\n    - name: "quoted one"  \n      transport:\n        type: http\n        url: https://a.example.com/mcp\n    - name: plain  \n      transport:\n        type: http\n        url: https://b.example.com/mcp\n---\n`;
    expect(removeMcpServer(file, "quoted one")).not.toContain("quoted one");
    expect(removeMcpServer(file, "plain")).not.toContain("plain");
  });
});

describe("a file saved with Windows line endings", () => {
  const crlf = "---\r\nname: A\r\nmodel:\r\n  provider: openai\r\n  name: gpt-4o\r\n---\r\n\r\n# Role\r\n\r\nHi.\r\n";

  it("keeps one model block when a model field is changed, and its own line endings", () => {
    const next = setModelField(crlf, "name", "gpt-4.1");
    expect(next.match(/^model:/gm)).toHaveLength(1);
    expect(next).toContain("  name: gpt-4.1\r\n");
    expect(next).not.toMatch(/[^\r]\n/);
  });

  it("keeps one tools block when a server is added", () => {
    const next = addMcpServer(crlf, { name: "exa", url: "https://mcp.exa.ai/mcp" });
    expect(next.match(/^tools:/gm)).toHaveLength(1);
    expect(next).toContain("- name: exa\r\n");
    expect(next).not.toMatch(/[^\r]\n/);
  });

  it("keeps a comment block at the end of the settings", () => {
    const noted = crlf.replace("---\r\n\r\n# Role", "# end note\r\n\r\n# more\r\n---\r\n\r\n# Role");
    const plain = noted.replace(/\r\n/g, "\n");
    const renamed = setModelField(noted, "name", "gpt-4.1");
    expect(renamed).toBe(setModelField(plain, "name", "gpt-4.1").replace(/\n/g, "\r\n"));
    expect(getModelField(renamed, "name")).toBe("gpt-4.1");
    expect(setFrontmatterValue(noted, "name", "B")).toBe(setFrontmatterValue(plain, "name", "B").replace(/\n/g, "\r\n"));
  });

  it("reads and writes a section with its own line endings", () => {
    expect(getSection(crlf, "Role")).toBe("Hi.");
    const next = setSection(crlf, "Role", "Changed\nin two lines");
    expect(getSection(next, "Role")).toBe("Changed\nin two lines");
    expect(next).not.toMatch(/[^\r]\n/);
  });

  it("adds a missing section with its own line endings", () => {
    const next = setSection(crlf, "Instructions", "Be brief");
    expect(next).not.toMatch(/[^\r]\n/);
    expect(getSection(next, "Instructions")).toBe("Be brief");
  });

  it("adds the settings to a file without any, with its own line endings", () => {
    const next = setFrontmatterValue("# Role\r\n\r\nHi.\r\n", "name", "A");
    expect(next).toBe("---\r\nname: A\r\n---\r\n# Role\r\n\r\nHi.\r\n");
  });
});

describe("a missing section in a file that ends inside a code block", () => {
  it("closes the code block first, so the new section is found", () => {
    const open = "---\nname: A\n---\n\n# Instructions\n\n```\nnpm test\n";
    const next = setSection(open, "Role", "A tester");
    expect(next).toBe("---\nname: A\n---\n\n# Instructions\n\n```\nnpm test\n```\n\n# Role\n\nA tester\n");
    expect(getSection(next, "Role")).toBe("A tester");
  });

  it("closes a longer or tilde fence with the same marker", () => {
    expect(getSection(setSection("# Instructions\n\n~~~~\ncode\n", "Role", "r"), "Role")).toBe("r");
    expect(getSection(setSection("# Instructions\n\n````\ncode\n", "Role", "r"), "Role")).toBe("r");
  });

  it("leaves a closed code block alone", () => {
    const closed = "# Instructions\n\n```\ncode\n```\n";
    expect(setSection(closed, "Role", "r")).toBe(`${closed}\n# Role\n\nr\n`);
  });
});

describe("reading a setting that has no value", () => {
  it("is empty, and does not take the next line for its value", () => {
    expect(getFrontmatterScalar("---\nname:\nmodel:\n  provider: openai\n---\n\n# Role\n", "name")).toBe("");
  });
});

describe("a value followed by a comment", () => {
  const file =
    "---\nname: A # the name\nmodel:\n  provider: openai  # default\n  name: \"gpt-4o\" # chosen\n  authentication:\n    type: api-key\n    api_key: ${env:OPENAI_KEY} # my key\ntools:\n  mcp:\n    - name: exa # search\n      transport:\n        type: http\n        url: https://mcp.exa.ai/mcp\n---\n\n# Role\n";

  it("is read without the comment", () => {
    expect(getFrontmatterScalar(file, "name")).toBe("A");
    expect(getModelField(file, "provider")).toBe("openai");
    expect(getModelField(file, "name")).toBe("gpt-4o");
  });

  it("still finds the key reference", () => {
    expect(getModelApiKey(file)).toBe("${env:OPENAI_KEY}");
    expect(secretNameOf(getModelApiKey(file))).toBe("OPENAI_KEY");
  });

  it("still finds a server by its name", () => {
    expect(removeMcpServer(file, "exa")).not.toContain("exa");
  });

  it("keeps a hash that is part of the value", () => {
    const text = "---\nname: \"a # b\" # note\nmodel:\n  provider: x#y\n---\n";
    expect(getFrontmatterScalar(text, "name")).toBe("a # b");
    expect(getModelField(text, "provider")).toBe("x#y");
  });

  it("is empty when only a comment follows the key", () => {
    expect(getFrontmatterScalar("---\nname: # none\n---\n", "name")).toBe("");
  });
});

describe("adding a key to an authentication block that is indented by four spaces", () => {
  it("writes the key next to the lines that are already there", () => {
    const file = "---\nmodel:\n    provider: openai\n    authentication:\n        type: api-key\n---\n";
    const next = setModelApiKey(file, "${env:OPENAI_KEY}");
    expect(next).toContain("        api_key: ${env:OPENAI_KEY}\n");
    expect(splitFrontmatter(next).frontmatter).toEqual({
      model: { provider: "openai", authentication: { type: "api-key", api_key: "${env:OPENAI_KEY}" } },
    });
  });

  it("uses two more spaces when the block has no lines yet", () => {
    const file = "---\nmodel:\n  provider: openai\n  authentication:\n---\n";
    const next = setModelApiKey(file, "${env:OPENAI_KEY}");
    expect(next).toContain("    api_key: ${env:OPENAI_KEY}\n");
  });
});

describe("a file that has no settings yet", () => {
  it("does nothing when a setting is cleared, and does not fail", () => {
    expect(setFrontmatterValue("", "name", "")).toBe("---\n---\n");
    expect(setFrontmatterValue("# Role\nr\n", "description", "")).toBe("---\n---\n# Role\nr\n");
    expect(setFrontmatterValue("", "authors", [])).toBe("---\n---\n");
  });

  it("still adds a setting that has a value", () => {
    expect(setFrontmatterValue("# Role\nr\n", "name", "Ada")).toBe("---\nname: Ada\n---\n# Role\nr\n");
  });
});

describe("a model section with nothing under it", () => {
  it("takes the key, and adds the type that the file needs", () => {
    const next = setModelApiKey("---\nname: A\nmodel:\n---\n# Role\nr\n", "${env:OPENAI_API_KEY}");
    expect(splitFrontmatter(next).frontmatter).toEqual({
      name: "A",
      model: { authentication: { type: "api-key", api_key: "${env:OPENAI_API_KEY}" } },
    });
  });
});

describe("what is written for the key and for lines of text", () => {
  it("writes a cleared key as an empty value", () => {
    const file = "---\nmodel:\n  authentication:\n    type: api-key\n    api_key: ${env:K}\n---\n";
    expect(setModelApiKey(file, "")).toBe("---\nmodel:\n  authentication:\n    type: api-key\n    api_key:\n---\n");
    expect(getModelApiKey(setModelApiKey(file, ""))).toBe("");
  });

  it("quotes a key that would otherwise change the file", () => {
    const file = "---\nmodel:\n  authentication:\n    type: api-key\n    api_key: ${env:K}\n---\n";
    const next = setModelApiKey(file, "a: b\nname: injected");
    expect(splitFrontmatter(next).frontmatter).toEqual({
      model: { authentication: { type: "api-key", api_key: "a: b\nname: injected" } },
    });
  });

  it("writes text with a line break in quotes on one line", () => {
    expect(setFrontmatterValue("---\nname: A\n---\n", "description", "one\ntwo")).toContain('description: "one\\ntwo"');
    expect(setModelField("---\nname: A\n---\n", "name", "one\ntwo")).toContain('name: "one\\ntwo"');
  });
});

describe("lines the edit does not touch", () => {
  it("keeps a short list written in brackets exactly as it was", () => {
    const file = "---\ntools:\n  mcp:\n    - name: docs\n      transport:\n        type: http\n        url: https://d.example.com/mcp\n      tool_filter:\n        allow: [a, b]\n    - name: wiki\n      transport:\n        type: http\n        url: https://w.example.com/mcp\n---\n";
    expect(removeMcpServer(file, "wiki")).toContain("allow: [a, b]\n");
    expect(setServerToolFilter(file, "wiki", ["x"])).toContain("allow: [a, b]\n");
  });

  it("puts a new tool list right after the server's name", () => {
    const file = "---\ntools:\n  mcp:\n    - name: wiki\n      transport:\n        type: http\n        url: https://w.example.com/mcp\n---\n";
    expect(setServerToolFilter(file, "wiki", [])).toBe(
      "---\ntools:\n  mcp:\n    - name: wiki\n      tool_filter:\n        allow: []\n      transport:\n        type: http\n        url: https://w.example.com/mcp\n---\n",
    );
  });
});

describe("settings that fold or repeat a lot", () => {
  it("keeps a folded block of text as it was written when something else is edited", () => {
    const file = "---\nname: A\nprompt: >-\n  first line,\n  second line,\n  third line\n---\n# Role\nr\n";
    const next = setFrontmatterValue(file, "name", "B");
    expect(next).toBe("---\nname: B\nprompt: >-\n  first line,\n  second line,\n  third line\n---\n# Role\nr\n");
  });

  it("still edits a file that repeats a value more often than the YAML reader allows", () => {
    const refs = Array.from({ length: 150 }, () => "*a").join(", ");
    const file = `---\nname: A\nbase: &a v\nprompt: >-\n  one\n  two\nlist: [${refs}]\n---\n# Role\nr\n`;
    expect(() => setFrontmatterValue(file, "name", "B")).not.toThrow();
    expect(setFrontmatterValue(file, "name", "B")).toContain("name: B\n");
  });
});

describe("a heading typed into Role or Instructions", () => {
  it("stays in the box it was typed in, as a second-level heading", () => {
    const typed = setSection(FILE, "Role", "You are a tester\n# Next\nmore");
    expect(getSection(typed, "Role")).toBe("You are a tester\n## Next\nmore");
    expect(getSection(typed, "Instructions")).toBe("Be brief");
  });

  it("does not cut the section short, so the box keeps what was typed", () => {
    const typed = setSection(FILE, "Role", "# Next");
    expect(getSection(typed, "Role")).toBe("## Next");
  });

  it("leaves deeper headings, text with a hash in it, and code blocks alone", () => {
    const body = "## Two\n### Three\nissue #12 is open\n#nospace\n```\n# not a heading here\n```";
    expect(withoutSectionHeadings(body)).toBe(body);
  });

  it("changes a heading written with extra spaces or a tab", () => {
    expect(withoutSectionHeadings("   #  Next\n#\tTab")).toBe("   ##  Next\n##\tTab");
  });

  it("keeps working after a code block closes", () => {
    expect(withoutSectionHeadings("~~~\n# a\n~~~\n# b")).toBe("~~~\n# a\n~~~\n## b");
  });
});
