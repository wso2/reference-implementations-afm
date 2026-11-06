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

import { describe, it, expect, vi } from "vitest";
import { McpAuthError, createDynamicMcpAuthHeaderProvider, isDynamicAuthType, mcpAuthHeaders } from "./mcp-auth";

describe("mcpAuthHeaders", () => {
  it("bearer -> Authorization: Bearer <token>", () => {
    expect(mcpAuthHeaders({ type: "bearer", token: "abc" })).toEqual({
      Authorization: "Bearer abc",
    });
  });

  it("api-key -> default Authorization header with the raw key", () => {
    expect(mcpAuthHeaders({ type: "api-key", api_key: "k-123" })).toEqual({
      Authorization: "k-123",
    });
  });

  it("api-key -> custom header_name", () => {
    expect(mcpAuthHeaders({ type: "api-key", api_key: "k-123", header_name: "X-API-Key" })).toEqual({
      "X-API-Key": "k-123",
    });
  });

  it("matches the type case-insensitively", () => {
    expect(mcpAuthHeaders({ type: "BEARER", token: "abc" })).toEqual({ Authorization: "Bearer abc" });
  });

  it("throws when a required field is missing", () => {
    expect(() => mcpAuthHeaders({ type: "bearer" })).toThrow(McpAuthError);
    expect(() => mcpAuthHeaders({ type: "api-key" })).toThrow(/api_key/);
  });

  it("points oauth2 at the dynamic provider instead of computing a static header", () => {
    expect(() => mcpAuthHeaders({ type: "oauth2" })).toThrow(/createDynamicMcpAuthHeaderProvider/);
  });

  it("rejects an unknown type, and a jwt block - a browser does not sign tokens", () => {
    expect(() => mcpAuthHeaders({ type: "magic" })).toThrow(/Unsupported authentication type/);
    expect(() => mcpAuthHeaders({ type: "jwt" })).toThrow(/Unsupported authentication type: 'jwt'/);
    expect(() => mcpAuthHeaders({ type: "basic" })).toThrow(/Unsupported authentication type: 'basic'/);
  });
});

describe("isDynamicAuthType", () => {
  it("is true only for oauth2", () => {
    expect(isDynamicAuthType({ type: "oauth2" })).toBe(true);
    expect(isDynamicAuthType({ type: "OAuth2" })).toBe(true);
    expect(isDynamicAuthType({ type: "bearer" })).toBe(false);
    expect(isDynamicAuthType({ type: "api-key" })).toBe(false);
    expect(isDynamicAuthType({ type: "jwt" })).toBe(false);
  });
});

describe("createDynamicMcpAuthHeaderProvider", () => {
  const signIn = { type: "oauth2", grant_type: "authorization_code", authorize_url: "https://a", token_url: "https://t", client_id: "c" };
  const MCP = "https://mcp.example.com/mcp";

  it("gets the bearer header from the app's interactive token getter, naming the provider", async () => {
    const getInteractiveToken = vi.fn(async () => "interactive-token");
    const provider = createDynamicMcpAuthHeaderProvider(signIn, { getInteractiveToken, renewInteractiveToken: async () => true }, MCP);
    expect(await provider()).toEqual({ Authorization: "Bearer interactive-token" });
    expect(getInteractiveToken).toHaveBeenCalledWith(expect.objectContaining({ clientId: "c", resource: MCP }));
  });

  it("asks the app to renew the token the server turned down, and says whether it did", async () => {
    const renewInteractiveToken = vi.fn(async () => true);
    const provider = createDynamicMcpAuthHeaderProvider(signIn, { getInteractiveToken: async () => "t", renewInteractiveToken }, MCP);
    expect(await provider.renew?.({ Authorization: "Bearer old" })).toBe(true);
    expect(renewInteractiveToken).toHaveBeenCalledWith(expect.objectContaining({ clientId: "c", resource: MCP }), "old");
  });

  it("throws clearly when the app gave no interactive sign-in", () => {
    expect(() => createDynamicMcpAuthHeaderProvider(signIn, {}, MCP)).toThrow(/interactive sign-in/);
  });

  it.each([[{ type: "oauth2" }], [{ type: "oauth2", grant_type: "client_credentials" }], [{ type: "bearer", token: "t" }], [{ type: "jwt", issuer: "i", signing_key: "s" }]])(
    "refuses %j, which is not an authorization_code sign-in",
    (auth) => {
      expect(() => createDynamicMcpAuthHeaderProvider(auth, {}, MCP)).toThrow(/only oauth2 with grant_type 'authorization_code'/);
    },
  );
});
