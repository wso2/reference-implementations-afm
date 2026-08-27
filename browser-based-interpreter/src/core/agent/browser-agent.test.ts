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
import { loadForBrowser } from "./browser-agent";

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
  const planFor = (source: string, values: Record<string, string>) => loadForBrowser(source, { TOKEN: "t", ...values }).plan;
  const secure = httpServer("remote", "https://remote.example.com/mcp");

  it("does not block a provider variable that resolves to a supported provider", () => {
    const plan = planFor(agent("${env:PROVIDER}", [secure]), { PROVIDER: "openai" });
    expect(plan).toEqual({ runnable: true, issues: [] });
  });

  it("blocks a provider variable that resolves to an unsupported provider", () => {
    const plan = planFor(agent("${env:PROVIDER}", [secure]), { PROVIDER: "gemini" });
    expect(plan.runnable).toBe(false);
    expect(plan.issues).toEqual([expect.objectContaining({ severity: "blocked", code: "model-provider-unsupported", path: "model.provider" })]);
  });

  it("blocks credentials for a plain http address that a variable resolves to", () => {
    const plan = planFor(agent("openai", [httpServer("remote", "${env:URL}")]), { URL: "http://remote.example.com/mcp" });
    expect(plan.runnable).toBe(false);
    expect(plan.issues).toEqual([expect.objectContaining({ severity: "blocked", code: "tool-credentials-insecure", path: "tools.mcp[0].transport.url" })]);
  });

  it("accepts an https address that a variable resolves to", () => {
    const plan = planFor(agent("openai", [httpServer("remote", "${env:URL}")]), { URL: "https://remote.example.com/mcp" });
    expect(plan).toEqual({ runnable: true, issues: [] });
  });

  it("points at the server's own place in the file when a stdio server comes before it", () => {
    const source = agent("openai", [stdioServer("local"), httpServer("remote", "${env:URL}")]);
    const plan = planFor(source, { URL: "http://remote.example.com/mcp" });
    expect(plan.issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "stdio-transport-unsupported", path: "tools.mcp[0].transport" }),
      expect.objectContaining({ severity: "blocked", code: "tool-credentials-insecure", path: "tools.mcp[1].transport.url" }),
    ]);
  });

  it("refuses a custom model address, which the browser cannot use", () => {
    const plan = planFor(agent("${env:PROVIDER}", [secure], ['  url: "https://models.example.com"']), { PROVIDER: "openai" });
    expect(plan.issues).toEqual([expect.objectContaining({ severity: "blocked", code: "model-url-unsupported", path: "model.url" })]);
    expect(plan.runnable).toBe(false);
  });
});

const SIGN_IN_FILE = `---
name: Signer
model:
  provider: openai
  name: gpt-4o
  authentication:
    type: api-key
    api_key: "\${env:KEY}"
tools:
  mcp:
    - name: local
      transport:
        type: stdio
        command: node
    - name: docs
      transport:
        type: http
        url: "https://docs.example.com/mcp"
        authentication:
          type: oauth2
          grant_type: authorization_code
          authorize_url: "https://auth.example.com/authorize"
          token_url: "https://auth.example.com/token"
          client_id: "\${env:CLIENT}"
          scopes: [read]
    - name: plain
      transport:
        type: http
        url: "https://plain.example.com/mcp"
---

# Role
You are \${env:WHO}.

# Instructions
Help.
`;

describe("loadForBrowser", () => {
  const env = { KEY: "sk-1", CLIENT: "client-9" };

  it("loads a file with a sign-in block, which the interpreter alone would refuse", () => {
    const { metadata, plan } = loadForBrowser(SIGN_IN_FILE, env);
    const servers = metadata.tools?.mcp ?? [];
    expect(servers.map((server) => server.name)).toEqual(["docs", "plain"]);
    expect(servers[0]?.transport).toMatchObject({
      type: "http",
      authentication: { type: "oauth2", grant_type: "authorization_code", client_id: "client-9", scopes: ["read"] },
    });
    expect(servers[1]?.transport).not.toHaveProperty("authentication");
    expect(plan.issues.map((issue) => [issue.code, issue.path])).toEqual([["stdio-transport-unsupported", "tools.mcp[0].transport"]]);
  });

  it("puts the key in the model block and leaves Role and Instructions as written", () => {
    const { metadata, systemPrompt, role } = loadForBrowser(SIGN_IN_FILE, env);
    expect(metadata.model?.authentication?.api_key).toBe("sk-1");
    expect(role).toBe("You are ${env:WHO}.");
    expect(systemPrompt).toBe("# Role\n\nYou are ${env:WHO}.\n\n# Instructions\n\nHelp.");
  });

  it("names a variable that has no value, and only that", () => {
    expect(() => loadForBrowser(SIGN_IN_FILE, { KEY: "sk-1" })).toThrow("Could not resolve variable '${env:CLIENT}': 'CLIENT' is not set");
  });

  it("does not need a value for a variable in a part the browser leaves out", () => {
    const file = SIGN_IN_FILE.replace("command: node", 'command: "${env:RUNNER}"');
    expect(() => loadForBrowser(file, env)).not.toThrow();
  });

  it("reports a sign-in block that is incomplete, at its place in the file", () => {
    const file = SIGN_IN_FILE.replace('          client_id: "${env:CLIENT}"\n', "");
    expect(() => loadForBrowser(file, env)).toThrow("oauth2 grant_type 'authorization_code' requires 'client_id' field (at 'tools.mcp.1.transport.authentication')");
  });

  it("refuses ${http:...} anywhere but a webhook prompt, as the interpreter does", () => {
    expect(() => loadForBrowser(SIGN_IN_FILE.replace("name: Signer", 'name: "${http:payload.x}"'), env)).toThrow(/http:/);
  });
});
