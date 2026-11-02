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

  it("basic -> Authorization: Basic base64(user:pass)", () => {
    expect(mcpAuthHeaders({ type: "basic", username: "alice", password: "s3cret" })).toEqual({
      Authorization: `Basic ${btoa("alice:s3cret")}`,
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
    expect(() => mcpAuthHeaders({ type: "basic", username: "a" })).toThrow(/username.*password/);
    expect(() => mcpAuthHeaders({ type: "api-key" })).toThrow(/api_key/);
  });

  it("points oauth2 at the dynamic provider instead of computing a static header", () => {
    expect(() => mcpAuthHeaders({ type: "oauth2" })).toThrow(/createDynamicMcpAuthHeaderProvider/);
  });

  it("rejects an unknown type, and a jwt block - a browser does not sign tokens", () => {
    expect(() => mcpAuthHeaders({ type: "magic" })).toThrow(/Unsupported authentication type/);
    expect(() => mcpAuthHeaders({ type: "jwt" })).toThrow(/Unsupported authentication type: 'jwt'/);
  });
});

describe("isDynamicAuthType", () => {
  it("is true only for oauth2", () => {
    expect(isDynamicAuthType({ type: "oauth2" })).toBe(true);
    expect(isDynamicAuthType({ type: "OAuth2" })).toBe(true);
    expect(isDynamicAuthType({ type: "bearer" })).toBe(false);
    expect(isDynamicAuthType({ type: "basic" })).toBe(false);
    expect(isDynamicAuthType({ type: "api-key" })).toBe(false);
    expect(isDynamicAuthType({ type: "jwt" })).toBe(false);
  });
});

describe("createDynamicMcpAuthHeaderProvider", () => {
  it("oauth2 client_credentials: fetches and caches a token across calls", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ access_token: `tok-${calls}`, expires_in: 3600 }) } as Response;
    }) as unknown as typeof fetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      const provider = createDynamicMcpAuthHeaderProvider({
        type: "oauth2",
        grant_type: "client_credentials",
        token_url: "https://auth.example.com/token",
        client_id: "id",
        client_secret: "secret",
      });
      const first = await provider();
      const second = await provider();
      expect(first).toEqual({ Authorization: "Bearer tok-1" });
      expect(second).toEqual({ Authorization: "Bearer tok-1" });
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("oauth2 client_credentials: invalidate makes the next call fetch a new token", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ access_token: `tok-${calls}`, expires_in: 3600 }) } as Response;
    }) as unknown as typeof fetch;
    const provider = createDynamicMcpAuthHeaderProvider(
      { type: "oauth2", grant_type: "client_credentials", token_url: "https://auth.example.com/token", client_id: "id", client_secret: "secret" },
      { fetchFn },
    );
    expect(await provider()).toEqual({ Authorization: "Bearer tok-1" });
    provider.invalidate?.();
    expect(await provider()).toEqual({ Authorization: "Bearer tok-2" });
    expect(calls).toBe(2);
  });

  it("oauth2 authorization_code: invalidate tells the app the sign-in was rejected, naming the provider", () => {
    const onInteractiveAuthRejected = vi.fn();
    const provider = createDynamicMcpAuthHeaderProvider(
      {
        type: "oauth2",
        grant_type: "authorization_code",
        authorize_url: "https://a.example.com/authorize",
        token_url: "https://a.example.com/token",
        client_id: "c",
      },
      { getInteractiveToken: async () => "interactive-token", onInteractiveAuthRejected },
      "https://mcp.example.com/mcp",
    );
    provider.invalidate?.();
    expect(onInteractiveAuthRejected).toHaveBeenCalledOnce();
    expect(onInteractiveAuthRejected).toHaveBeenCalledWith(expect.objectContaining({ clientId: "c", resource: "https://mcp.example.com/mcp" }));
  });

  it("oauth2 authorization_code: invalidate is harmless when the app gave no callback", () => {
    const provider = createDynamicMcpAuthHeaderProvider(
      { type: "oauth2", grant_type: "authorization_code", authorize_url: "https://a", token_url: "https://t", client_id: "c" },
      { getInteractiveToken: async () => "interactive-token" },
    );
    expect(() => provider.invalidate?.()).not.toThrow();
  });

  it("oauth2 authorization_code: delegates to the injected interactive token getter", async () => {
    const getInteractiveToken = vi.fn(async () => "interactive-token");
    const provider = createDynamicMcpAuthHeaderProvider(
      { type: "oauth2", grant_type: "authorization_code", authorize_url: "https://a", token_url: "https://t", client_id: "c" },
      { getInteractiveToken },
    );
    expect(await provider()).toEqual({ Authorization: "Bearer interactive-token" });
    expect(getInteractiveToken).toHaveBeenCalledOnce();
  });

  it("oauth2 authorization_code: throws clearly when no interactive token getter was supplied", () => {
    expect(() =>
      createDynamicMcpAuthHeaderProvider({
        type: "oauth2",
        grant_type: "authorization_code",
        authorize_url: "https://a",
        token_url: "https://t",
        client_id: "c",
      }),
    ).toThrow(/interactive sign-in/);
  });

  it("oauth2: throws when grant_type is missing or unsupported", () => {
    expect(() => createDynamicMcpAuthHeaderProvider({ type: "oauth2" })).toThrow(/requires a 'grant_type'/);
    expect(() => createDynamicMcpAuthHeaderProvider({ type: "oauth2", grant_type: "implicit" })).toThrow(/Unsupported oauth2 grant_type/);
  });

  it("throws for a non-dynamic type", () => {
    expect(() => createDynamicMcpAuthHeaderProvider({ type: "bearer", token: "t" })).toThrow(/not a dynamic auth type/);
    expect(() => createDynamicMcpAuthHeaderProvider({ type: "jwt", issuer: "i", signing_key: "s" })).toThrow(/not a dynamic auth type/);
  });
});
