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
import { type OAuthSignIn } from "./mcp-directory";
import { discoverMcpServerAuth, resolveDirectoryClient } from "./mcp-auth";

const REDIRECT_URI = "http://localhost:5173/";
const CIMD_CLIENT_ID = "https://afm.example.com/oauth/client-metadata.json";

const LINEAR_CHALLENGE =
  'Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="Missing or invalid access token"';
const LINEAR_PRM = {
  resource: "https://mcp.linear.app/mcp",
  authorization_servers: ["https://mcp.linear.app"],
  scopes_supported: ["read", "write"],
  bearer_methods_supported: ["header"],
};
const LINEAR_AS_METADATA = {
  issuer: "https://mcp.linear.app",
  authorization_endpoint: "https://mcp.linear.app/authorize",
  token_endpoint: "https://mcp.linear.app/token",
  code_challenge_methods_supported: ["S256"],
  registration_endpoint: "https://mcp.linear.app/register",
  client_id_metadata_document_supported: true,
};

function routedFetch(routes: Record<string, { status: number; headers?: Record<string, string>; json?: unknown }>) {
  const requested: string[] = [];
  const fn = (async (input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    const route = routes[url];
    if (route === undefined) {
      return { ok: false, status: 404, headers: new Headers(), json: async () => ({}) } as unknown as Response;
    }
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      headers: new Headers(route.headers ?? {}),
      json: async () => route.json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, requested };
}

const EXAMPLE_CHALLENGE = {
  "https://mcp.example.com/mcp": {
    status: 401,
    headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/prm"' },
  },
  "https://mcp.example.com/prm": {
    status: 200,
    json: { resource: "https://mcp.example.com/mcp", authorization_servers: ["https://as.example.com"] },
  },
};

function exampleAuthorizationServer(extra: Record<string, unknown> = {}) {
  return {
    "https://as.example.com/.well-known/oauth-authorization-server": {
      status: 200,
      json: {
        issuer: "https://as.example.com",
        authorization_endpoint: "https://as.example.com/authorize",
        token_endpoint: "https://as.example.com/token",
        code_challenge_methods_supported: ["S256"],
        ...extra,
      },
    },
  };
}

describe("discoverMcpServerAuth", () => {
  it("returns null for a server that needs no auth", async () => {
    const { fn } = routedFetch({ "https://mcp.example.com/mcp": { status: 200, json: {} } });
    const result = await discoverMcpServerAuth("https://mcp.example.com/mcp", {
      fetchFn: fn,
      cimdClientId: CIMD_CLIENT_ID,
      redirectUri: REDIRECT_URI,
    });
    expect(result).toBeNull();
  });

  it("resolves Linear end to end via CIMD - no registration call, since Linear advertises support for it", async () => {
    const { fn, requested } = routedFetch({
      "https://mcp.linear.app/mcp": { status: 401, headers: { "www-authenticate": LINEAR_CHALLENGE } },
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": { status: 200, json: LINEAR_PRM },
      "https://mcp.linear.app/.well-known/oauth-authorization-server": { status: 200, json: LINEAR_AS_METADATA },
    });
    const result = await discoverMcpServerAuth("https://mcp.linear.app/mcp", {
      fetchFn: fn,
      cimdClientId: CIMD_CLIENT_ID,
      redirectUri: REDIRECT_URI,
    });
    expect(result).toEqual({
      authorizeUrl: "https://mcp.linear.app/authorize",
      tokenUrl: "https://mcp.linear.app/token",
      clientId: CIMD_CLIENT_ID,
      scopes: ["read", "write"],
    });
    expect(requested).not.toContain("https://mcp.linear.app/register");
  });

  it("carries the PRM's scopes_supported through when the 401 gave no scope hint of its own", async () => {
    const { fn } = routedFetch({
      "https://mcp.linear.app/mcp": { status: 401, headers: { "www-authenticate": LINEAR_CHALLENGE } },
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": { status: 200, json: LINEAR_PRM },
      "https://mcp.linear.app/.well-known/oauth-authorization-server": { status: 200, json: LINEAR_AS_METADATA },
    });
    const result = await discoverMcpServerAuth("https://mcp.linear.app/mcp", {
      fetchFn: fn,
      cimdClientId: CIMD_CLIENT_ID,
      redirectUri: REDIRECT_URI,
    });
    expect(result?.scopes).toEqual(["read", "write"]);
  });

  it("registers a client instead when no client id document is configured, even if the AS supports one", async () => {
    const { fn, requested } = routedFetch({
      "https://mcp.linear.app/mcp": { status: 401, headers: { "www-authenticate": LINEAR_CHALLENGE } },
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": { status: 200, json: LINEAR_PRM },
      "https://mcp.linear.app/.well-known/oauth-authorization-server": { status: 200, json: LINEAR_AS_METADATA },
      "https://mcp.linear.app/register": { status: 201, json: { client_id: "dcr-linear" } },
    });
    const result = await discoverMcpServerAuth("https://mcp.linear.app/mcp", {
      fetchFn: fn,
      cimdClientId: undefined,
      redirectUri: REDIRECT_URI,
    });
    expect(result?.clientId).toBe("dcr-linear");
    expect(requested).toContain("https://mcp.linear.app/register");
  });

  it("leaves the client id empty when no document is configured and registration fails", async () => {
    const { fn } = routedFetch({
      "https://mcp.linear.app/mcp": { status: 401, headers: { "www-authenticate": LINEAR_CHALLENGE } },
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": { status: 200, json: LINEAR_PRM },
      "https://mcp.linear.app/.well-known/oauth-authorization-server": { status: 200, json: LINEAR_AS_METADATA },
    });
    const result = await discoverMcpServerAuth("https://mcp.linear.app/mcp", {
      fetchFn: fn,
      cimdClientId: undefined,
      redirectUri: REDIRECT_URI,
    });
    expect(result?.clientId).toBe("");
  });

  it.each([
    ["does not list PKCE methods", undefined],
    ["lists only plain", ["plain"]],
  ])("refuses a server whose authorization server %s", async (_label, methods) => {
    const { fn } = routedFetch({
      "https://mcp.linear.app/mcp": { status: 401, headers: { "www-authenticate": LINEAR_CHALLENGE } },
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": { status: 200, json: LINEAR_PRM },
      "https://mcp.linear.app/.well-known/oauth-authorization-server": {
        status: 200,
        json: { ...LINEAR_AS_METADATA, code_challenge_methods_supported: methods },
      },
    });
    await expect(
      discoverMcpServerAuth("https://mcp.linear.app/mcp", {
        fetchFn: fn,
        cimdClientId: CIMD_CLIENT_ID,
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toThrow(/authorization server publishes no metadata that passes the checks/);
  });

  it("registers a client via DCR when the AS has a registration_endpoint but no CIMD support", async () => {
    const { fn, requested } = routedFetch({
      ...EXAMPLE_CHALLENGE,
      ...exampleAuthorizationServer({ registration_endpoint: "https://as.example.com/register" }),
      "https://as.example.com/register": { status: 201, json: { client_id: "dcr-client-id" } },
    });
    const result = await discoverMcpServerAuth("https://mcp.example.com/mcp", {
      fetchFn: fn,
      cimdClientId: CIMD_CLIENT_ID,
      redirectUri: REDIRECT_URI,
    });
    expect(result?.clientId).toBe("dcr-client-id");
    expect(requested).toContain("https://as.example.com/register");
  });

  it("still returns the resolved endpoints, with an empty client_id, when neither CIMD nor DCR is available", async () => {
    const { fn } = routedFetch({ ...EXAMPLE_CHALLENGE, ...exampleAuthorizationServer() });
    const result = await discoverMcpServerAuth("https://mcp.example.com/mcp", {
      fetchFn: fn,
      cimdClientId: CIMD_CLIENT_ID,
      redirectUri: REDIRECT_URI,
    });
    expect(result).toEqual({
      authorizeUrl: "https://as.example.com/authorize",
      tokenUrl: "https://as.example.com/token",
      clientId: "",
      scopes: undefined,
    });
  });

  it("still returns an empty client_id, rather than throwing, when the DCR call itself fails", async () => {
    const { fn } = routedFetch({
      ...EXAMPLE_CHALLENGE,
      ...exampleAuthorizationServer({ registration_endpoint: "https://as.example.com/register" }),
      "https://as.example.com/register": { status: 400, json: { error: "invalid_client_metadata" } },
    });
    const result = await discoverMcpServerAuth("https://mcp.example.com/mcp", {
      fetchFn: fn,
      cimdClientId: CIMD_CLIENT_ID,
      redirectUri: REDIRECT_URI,
    });
    expect(result?.clientId).toBe("");
  });

  it("refuses a server that publishes no PRM, even when its own address answers as an authorization server - Atlassian's older address", async () => {
    const { fn, requested } = routedFetch({
      "https://mcp.atlassian.com/v1/mcp": {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="OAuth", error="invalid_token", error_description="Missing or invalid access token"',
        },
      },
      "https://mcp.atlassian.com/.well-known/oauth-authorization-server": {
        status: 200,
        json: {
          issuer: "https://mcp.atlassian.com",
          authorization_endpoint: "https://mcp.atlassian.com/v1/authorize",
          token_endpoint: "https://mcp.atlassian.com/v1/token",
          code_challenge_methods_supported: ["S256"],
          registration_endpoint: "https://mcp.atlassian.com/v1/register",
        },
      },
      "https://mcp.atlassian.com/v1/register": { status: 201, json: { client_id: "atlassian-dcr-client" } },
    });
    await expect(
      discoverMcpServerAuth("https://mcp.atlassian.com/v1/mcp", {
        fetchFn: fn,
        cimdClientId: CIMD_CLIENT_ID,
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toThrow(/publishes no sign-in metadata.*current one/);
    expect(requested).not.toContain("https://mcp.atlassian.com/.well-known/oauth-authorization-server");
    expect(requested).not.toContain("https://mcp.atlassian.com/v1/register");
  });

  it("refuses a server that publishes no PRM at all", async () => {
    const { fn } = routedFetch({
      "https://mcp.example.com/mcp": { status: 401 },
    });
    await expect(
      discoverMcpServerAuth("https://mcp.example.com/mcp", {
        fetchFn: fn,
        cimdClientId: CIMD_CLIENT_ID,
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toThrow(/publishes no sign-in metadata/);
  });

  it("refuses a server whose authorization server can't be resolved at all", async () => {
    const { fn } = routedFetch(EXAMPLE_CHALLENGE);
    await expect(
      discoverMcpServerAuth("https://mcp.example.com/mcp", {
        fetchFn: fn,
        cimdClientId: CIMD_CLIENT_ID,
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toThrow(/authorization server publishes no metadata/);
  });
});

describe("resolveDirectoryClient", () => {
  const SIGN_IN: OAuthSignIn = {
    type: "oauth2",
    authorizeUrl: "https://mcp.linear.app/authorize",
    tokenUrl: "https://mcp.linear.app/token",
    registrationUrl: "https://mcp.linear.app/register",
    clientIdMetadata: true,
    scopes: ["read", "write"],
  };

  it("uses the entry's endpoints and scopes as written, and asks no server anything, when a client id document is configured", async () => {
    const { fn, requested } = routedFetch({});
    const result = await resolveDirectoryClient(SIGN_IN, {
      fetchFn: fn,
      cimdClientId: CIMD_CLIENT_ID,
      redirectUri: REDIRECT_URI,
    });
    expect(result).toEqual({
      authorizeUrl: "https://mcp.linear.app/authorize",
      tokenUrl: "https://mcp.linear.app/token",
      clientId: CIMD_CLIENT_ID,
      scopes: ["read", "write"],
    });
    expect(requested).toEqual([]);
  });

  it("registers a client at the entry's registration address when no client id document is configured", async () => {
    const { fn, requested } = routedFetch({
      "https://mcp.linear.app/register": { status: 201, json: { client_id: "dcr-linear" } },
    });
    const result = await resolveDirectoryClient(SIGN_IN, {
      fetchFn: fn,
      cimdClientId: undefined,
      redirectUri: REDIRECT_URI,
    });
    expect(result.clientId).toBe("dcr-linear");
    expect(requested).toEqual(["https://mcp.linear.app/register"]);
  });

  it("registers a client when the entry offers no client id document, even if one is configured", async () => {
    const { fn } = routedFetch({
      "https://mcp.linear.app/register": { status: 201, json: { client_id: "dcr-linear" } },
    });
    const result = await resolveDirectoryClient(
      { ...SIGN_IN, clientIdMetadata: undefined },
      { fetchFn: fn, cimdClientId: CIMD_CLIENT_ID, redirectUri: REDIRECT_URI },
    );
    expect(result.clientId).toBe("dcr-linear");
  });

  it("registers the address this app redirects back to", async () => {
    const bodies: unknown[] = [];
    const fn = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 201, json: async () => ({ client_id: "dcr-linear" }) } as unknown as Response;
    }) as unknown as typeof fetch;
    await resolveDirectoryClient(SIGN_IN, { fetchFn: fn, cimdClientId: undefined, redirectUri: REDIRECT_URI });
    expect(bodies).toEqual([expect.objectContaining({ redirect_uris: [REDIRECT_URI] })]);
  });

  it("leaves the client id empty, with the endpoints still filled in, when registration fails", async () => {
    const { fn } = routedFetch({ "https://mcp.linear.app/register": { status: 403 } });
    const result = await resolveDirectoryClient(SIGN_IN, {
      fetchFn: fn,
      cimdClientId: undefined,
      redirectUri: REDIRECT_URI,
    });
    expect(result).toEqual({
      authorizeUrl: "https://mcp.linear.app/authorize",
      tokenUrl: "https://mcp.linear.app/token",
      clientId: "",
      scopes: ["read", "write"],
    });
  });

  it("leaves the client id empty for an entry that offers neither way to get one", async () => {
    const { fn, requested } = routedFetch({});
    const result = await resolveDirectoryClient(
      { ...SIGN_IN, registrationUrl: undefined, clientIdMetadata: undefined },
      { fetchFn: fn, cimdClientId: CIMD_CLIENT_ID, redirectUri: REDIRECT_URI },
    );
    expect(result.clientId).toBe("");
    expect(requested).toEqual([]);
  });

  it("passes no scopes through for an entry that lists none", async () => {
    const { fn } = routedFetch({});
    const result = await resolveDirectoryClient(
      { ...SIGN_IN, scopes: undefined },
      { fetchFn: fn, cimdClientId: CIMD_CLIENT_ID, redirectUri: REDIRECT_URI },
    );
    expect(result.scopes).toBeUndefined();
  });
});
