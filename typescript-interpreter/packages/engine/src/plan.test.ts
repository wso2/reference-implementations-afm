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
import { planForBrowser } from "./plan";
import { validateMetadata } from "./schema";

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
});
