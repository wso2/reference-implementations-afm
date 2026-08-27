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

import { previewAgent } from "./agent-validation";
import { declaredAgent } from "./browser-agent";
import { describe, expect, it } from "vitest";
import { confirmationsOf, planForBrowser } from "./browser-plan";

describe("planForBrowser", () => {
  it("reports no issues for a webchat-only agent", () => {
    const md = declaredAgent({ interfaces: [{ type: "webchat" }] });
    const plan = planForBrowser(md);
    expect(plan.runnable).toBe(true);
    expect(plan.issues).toHaveLength(0);
  });

  it("is runnable with no interfaces or tools at all", () => {
    const plan = planForBrowser(declaredAgent({}));
    expect(plan.runnable).toBe(true);
    expect(plan.issues).toHaveLength(0);
  });

  it("warns about a consolechat interface", () => {
    const md = declaredAgent({ interfaces: [{ type: "consolechat" }] });
    const plan = planForBrowser(md);
    expect(plan.runnable).toBe(true);
    expect(plan.issues).toHaveLength(1);
    expect(plan.issues[0]?.code).toBe("interface-unsupported");
    expect(plan.issues[0]?.message).toMatch(/consolechat/);
  });

  it("warns about a webhook interface", () => {
    const md = declaredAgent({
      interfaces: [{ type: "webhook", subscription: { protocol: "websub" } }],
    });
    const plan = planForBrowser(md);
    expect(plan.issues[0]?.code).toBe("interface-unsupported");
    expect(plan.issues[0]?.message).toMatch(/webhook/);
  });

  it("warns about a stdio MCP server but not an http one", () => {
    const md = declaredAgent({
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
    const md = declaredAgent({
      tools: {
        mcp: [
          {
            name: "signed",
            transport: { type: "http", url: "https://x/y", authentication: { type: "jwt", issuer: "i", audience: "a", signing_key: "${env:K}" } },
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
    const jwt = planForBrowser(declaredAgent({ model: { authentication: { type: "jwt", issuer: "i", audience: "a", signing_key: "k" } } }));
    expect(jwt.runnable).toBe(false);
    expect(jwt.issues[0]).toMatchObject({ severity: "blocked", code: "model-auth-unsupported", path: "model.authentication" });

    const oauth = planForBrowser(
      declaredAgent({
        model: { authentication: { type: "OAuth2", grant_type: "client_credentials", token_url: "https://t", client_id: "i", client_secret: "s" } },
      }),
    );
    expect(oauth.runnable).toBe(false);
    expect(oauth.issues[0]?.message).toMatch(/'oauth2'/);

    for (const authentication of [{ type: "api-key", api_key: "k" }, { type: "bearer", token: "t" }]) {
      const plan = planForBrowser(declaredAgent({ model: { authentication } }));
      expect(plan.runnable).toBe(true);
      expect(plan.issues).toHaveLength(0);
    }
  });

  it("collects multiple issues across interfaces and tools", () => {
    const md = declaredAgent({
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
    const metadata = declaredAgent({
      model: { provider: "openai" },
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
      "interface-unsupported", "structured-signature-unsupported", "interface-unsupported", "local-skill-unsupported",
    ]);
    const [issue] = planForBrowser(declaredAgent({ model: { provider: "other" } })).issues;
    expect(issue).toMatchObject({ severity: "blocked", code: "model-provider-unsupported" });
  });

  it.each(["https://user:secret@docs.example.com/mcp", "http://user:${env:PASSWORD}@mcp.example.com/mcp"])(
    "blocks a tool server whose address carries a user name or password: %s",
    (url) => {
      const plan = planForBrowser(declaredAgent({ tools: { mcp: [{ name: "docs", transport: { type: "http", url } }] } }));
      expect(plan.runnable).toBe(false);
      expect(plan.issues).toEqual([
        expect.objectContaining({ severity: "blocked", code: "tool-address-credentials", path: "tools.mcp[0].transport.url" }),
      ]);
    },
  );

  it("blocks a custom model address, so a key is never sent somewhere the file did not name", () => {
    const plan = planForBrowser(declaredAgent({ model: { provider: "openai", url: "https://custom.example.com/v1" } }));
    expect(plan.runnable).toBe(false);
    expect(plan.issues).toEqual([
      expect.objectContaining({ severity: "blocked", code: "model-url-unsupported", path: "model.url" }),
    ]);
    expect(confirmationsOf(plan)).toEqual([]);
  });

  describe("an MCP server that is reached over plain http", () => {
    const server = (url: string, authentication?: Record<string, unknown>) =>
      declaredAgent({ tools: { mcp: [{ name: "docs", transport: { type: "http", url, ...(authentication ? { authentication } : {}) } }] } });
    const bearer = { type: "bearer", token: "t" };

    it.each([
      ["bearer", bearer],
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

    it.each([
      ["a variable in the query", "http://mcp.example.com/mcp?key=${env:KEY}"],
      ["a variable in the path", "http://mcp.example.com/${env:TENANT}/mcp"],
      ["a variable in the fragment", "http://mcp.example.com/mcp#${env:KEY}"],
    ])("is still blocked with %s, because the host is known and plain http", (_label, url) => {
      const plan = planForBrowser(server(url, bearer));
      expect(plan.runnable).toBe(false);
      expect(plan.issues).toEqual([
        expect.objectContaining({ severity: "blocked", code: "tool-credentials-insecure", path: "tools.mcp[0].transport.url" }),
      ]);
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

    it("blocks an oauth2 sign-in address that is plain http with a variable only after the host", () => {
      const oauth = { type: "oauth2", grant_type: "authorization_code", client_id: "c", authorize_url: "https://a/authorize" };
      const plan = planForBrowser(server("https://mcp.example.com/mcp", { ...oauth, token_url: "http://auth.example.com/token?x=${env:X}" }));
      expect(plan.issues).toEqual([expect.objectContaining({ code: "oauth-address-insecure", path: "tools.mcp[0].transport.authentication.token_url" })]);
    });

    it("lets an oauth2 sign-in through when its addresses are https or still variables", () => {
      const oauth = { type: "oauth2", grant_type: "authorization_code", client_id: "c" };
      const https = { authorize_url: "https://a/authorize", token_url: "https://a/token" };
      const variables = { authorize_url: "${env:AUTH}", token_url: "http://${env:HOST}/token" };
      expect(planForBrowser(server("https://mcp.example.com/mcp", { ...oauth, ...https })).issues).toEqual([]);
      expect(planForBrowser(server("https://mcp.example.com/mcp", { ...oauth, ...variables })).issues).toEqual([]);
    });

    it("blocks username and password (basic) authentication, saying what to use instead", () => {
      const plan = planForBrowser(server("https://mcp.example.com/mcp", { type: "basic", username: "u", password: "p" }));
      expect(plan.runnable).toBe(false);
      expect(plan.issues).toEqual([expect.objectContaining({ severity: "blocked", code: "tool-auth-unsupported" })]);
      expect(plan.issues[0]?.message).toMatch(/basic authentication, which is not supported.*access token.*provider sign-in/);
    });

    it("keeps reporting an authentication type the browser cannot use, ahead of the transport", () => {
      const plan = planForBrowser(server("http://mcp.example.com/mcp", { type: "basic", username: "u", password: "p" }));
      expect(plan.issues.map((issue) => issue.code)).toEqual(["tool-auth-unsupported"]);
    });
  });
});

const BROWSER_LIMITS = `---
name: Portable assistant
model:
  provider: openai
  name: gpt-4o
interfaces:
  - type: platformchat
    platform: slack
    mode: notification
    prompt: "Event: \${http:payload.event}"
  - type: webhook
    subscription:
      protocol: websub
  - type: webchat
    signature:
      input:
        type: object
tools:
  mcp:
    - name: local-files
      transport:
        type: stdio
        command: npx
skills:
  - type: local
    path: ./skills
---
# Role
Assist with work.
# Instructions
Answer clearly.
`;

describe("browser Run choices", () => {
  it("offers each supported browser fallback in file order", () => {
    const preview = previewAgent(BROWSER_LIMITS);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.plan.runnable).toBe(true);
    const choices = confirmationsOf(preview.plan);
    expect(choices.map((choice) => choice.title)).toEqual([
      "slack platform chat cannot run here",
      "webhook cannot run here",
      "Structured chat unavailable",
      "local-files cannot run here",
      "Local skill unavailable",
    ]);
    expect(choices[0]?.text).toContain("web chat preview");
    expect(choices[3]?.text).toContain("Run without this tool server");
  });
});
