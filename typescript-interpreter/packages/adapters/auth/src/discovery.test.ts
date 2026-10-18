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
import {
  parseResourceMetadataUrl,
  parseChallengeScope,
  discoverProtectedResource,
  discoverAuthorizationServer,
  discoverSignIn,
  registerClient,
  resolveClientId,
  SignInRefusedError,
} from "./discovery";

const LINEAR_CHALLENGE =
  'Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="Missing or invalid access token"';
const LINEAR_PRM = {
  resource: "https://mcp.linear.app/mcp",
  authorization_servers: ["https://mcp.linear.app"],
  scopes_supported: ["read", "write"],
  bearer_methods_supported: ["header"],
};
const EXAMPLE_PRM = { ...LINEAR_PRM, resource: "https://mcp.example.com/mcp" };
const LINEAR_AS_METADATA = {
  issuer: "https://mcp.linear.app",
  authorization_endpoint: "https://mcp.linear.app/authorize",
  token_endpoint: "https://mcp.linear.app/token",
  code_challenge_methods_supported: ["S256"],
  registration_endpoint: "https://mcp.linear.app/register",
  client_id_metadata_document_supported: true,
};

describe("parseResourceMetadataUrl", () => {
  it("reads resource_metadata out of a real WWW-Authenticate challenge", () => {
    expect(parseResourceMetadataUrl(LINEAR_CHALLENGE)).toBe(
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("is null when the header has no resource_metadata param", () => {
    expect(parseResourceMetadataUrl('Bearer realm="OAuth"')).toBeNull();
  });
});

describe("parseChallengeScope", () => {
  it("reads a scope hint when the server sends one", () => {
    expect(parseChallengeScope('Bearer resource_metadata="https://x/y", scope="files:read files:write"')).toEqual([
      "files:read",
      "files:write",
    ]);
  });

  it("is null when there is no scope param - Linear's real challenge, for one, sends none", () => {
    expect(parseChallengeScope(LINEAR_CHALLENGE)).toBeNull();
  });
});

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

describe("discoverProtectedResource", () => {
  it("returns null when the server answers without a 401 - no auth needed", async () => {
    const { fn } = routedFetch({ "https://mcp.example.com/mcp": { status: 200, json: {} } });
    expect(await discoverProtectedResource("https://mcp.example.com/mcp", fn)).toBeNull();
  });

  it("returns null when the probe fails outright (network/CORS) rather than throwing", async () => {
    const fn = (async () => {
      throw new Error("network error");
    }) as unknown as typeof fetch;
    expect(await discoverProtectedResource("https://mcp.example.com/mcp", fn)).toBeNull();
  });

  it("on a 401 with resource_metadata in WWW-Authenticate, fetches exactly that URL - Linear's real shape", async () => {
    const { fn, requested } = routedFetch({
      "https://mcp.linear.app/mcp": { status: 401, headers: { "www-authenticate": LINEAR_CHALLENGE } },
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": { status: 200, json: LINEAR_PRM },
    });
    const result = await discoverProtectedResource("https://mcp.linear.app/mcp", fn);
    expect(result?.metadata).toEqual(LINEAR_PRM);
    expect(result?.challengeScope).toBeNull();
    expect(requested).toEqual([
      "https://mcp.linear.app/mcp",
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
    ]);
  });

  it("carries the challenge's scope hint through when the server sends one", async () => {
    const { fn } = routedFetch({
      "https://mcp.example.com/mcp": {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="files:read"',
        },
      },
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": { status: 200, json: EXAMPLE_PRM },
    });
    const result = await discoverProtectedResource("https://mcp.example.com/mcp", fn);
    expect(result?.challengeScope).toEqual(["files:read"]);
  });

  it("falls back to the well-known paths, server path then root, when the 401 has no header at all", async () => {
    const { fn, requested } = routedFetch({
      "https://mcp.example.com/mcp": { status: 401 },
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": { status: 404 },
      "https://mcp.example.com/.well-known/oauth-protected-resource": { status: 200, json: EXAMPLE_PRM },
    });
    const result = await discoverProtectedResource("https://mcp.example.com/mcp", fn);
    expect(result?.metadata).toEqual(EXAMPLE_PRM);
    expect(requested).toEqual([
      "https://mcp.example.com/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    ]);
  });

  it("refuses a server that publishes no resource metadata, and says to use its current address", async () => {
    const { fn } = routedFetch({ "https://mcp.example.com/mcp": { status: 401 } });
    const refusal = discoverProtectedResource("https://mcp.example.com/mcp", fn);
    await expect(refusal).rejects.toBeInstanceOf(SignInRefusedError);
    await expect(refusal).rejects.toThrow(/publishes no sign-in metadata.*current one/);
  });

  it("rejects a metadata document with no authorization_servers", async () => {
    const { fn } = routedFetch({
      "https://mcp.example.com/mcp": {
        status: 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/prm"' },
      },
      "https://mcp.example.com/prm": { status: 200, json: { resource: "https://mcp.example.com/mcp" } },
    });
    await expect(discoverProtectedResource("https://mcp.example.com/mcp", fn)).rejects.toThrow(/publishes no sign-in metadata/);
  });
});

describe("the server a resource document names", () => {
  async function discoverNaming(serverUrl: string, resource: string) {
    const { fn } = routedFetch({
      [serverUrl]: { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://meta.example.com/prm"' } },
      "https://meta.example.com/prm": { status: 200, json: { ...LINEAR_PRM, resource } },
    });
    return discoverProtectedResource(serverUrl, fn);
  }

  it.each([
    ["the server's own address", "https://mcp.example.com/team/mcp", "https://mcp.example.com/team/mcp"],
    ["a parent path", "https://mcp.example.com/team/mcp", "https://mcp.example.com/team"],
    ["a parent path that ends at a slash", "https://mcp.example.com/team/mcp", "https://mcp.example.com/team/"],
    ["the bare origin", "https://mcp.example.com/team/mcp", "https://mcp.example.com"],
    ["the origin with its slash", "https://mcp.example.com/team/mcp", "https://mcp.example.com/"],
    ["a parent path on a non-default port", "https://mcp.example.com:8443/team/mcp", "https://mcp.example.com:8443/team"],
  ])("accepts %s", async (_label, serverUrl, resource) => {
    expect(await discoverNaming(serverUrl, resource)).not.toBeNull();
  });

  it.each([
    ["a sibling whose name only starts the same", "https://mcp.example.com/team", "https://mcp.example.com/team-other"],
    ["a path that only shares a prefix with the server's", "https://mcp.example.com/team-other/mcp", "https://mcp.example.com/team"],
    ["a child of the server", "https://mcp.example.com/team", "https://mcp.example.com/team/mcp"],
    ["another host", "https://mcp.example.com/team/mcp", "https://other.example.com/team/mcp"],
    ["the same host on another port", "https://mcp.example.com/team/mcp", "https://mcp.example.com:8443/team"],
    ["the same host over http", "https://mcp.example.com/team/mcp", "http://mcp.example.com/team"],
    ["a resource with a query", "https://mcp.example.com/team/mcp", "https://mcp.example.com/team?x=1"],
    ["a resource with a fragment", "https://mcp.example.com/team/mcp", "https://mcp.example.com/team#x"],
    ["a path that only matches once decoded", "https://mcp.example.com/team/mcp", "https://mcp.example.com/%74eam"],
    ["something that is not a URL", "https://mcp.example.com/team/mcp", "not a url"],
  ])("refuses %s", async (_label, serverUrl, resource) => {
    await expect(discoverNaming(serverUrl, resource)).rejects.toThrow(/does not name this server/);
  });

  it("moves on to the next well-known address when the first one names another server", async () => {
    const { fn } = routedFetch({
      "https://mcp.example.com/mcp": { status: 401 },
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": { status: 200, json: LINEAR_PRM },
      "https://mcp.example.com/.well-known/oauth-protected-resource": { status: 200, json: EXAMPLE_PRM },
    });
    expect((await discoverProtectedResource("https://mcp.example.com/mcp", fn))?.metadata).toEqual(EXAMPLE_PRM);
  });
});

describe("discoverSignIn", () => {
  const LINEAR_ROUTES = {
    "https://mcp.linear.app/mcp": { status: 401, headers: { "www-authenticate": LINEAR_CHALLENGE } },
    "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": { status: 200, json: LINEAR_PRM },
    "https://mcp.linear.app/.well-known/oauth-authorization-server": { status: 200, json: LINEAR_AS_METADATA },
  };

  it("finds the checked authorization server and the scopes the resource lists - Linear's real shape", async () => {
    const { fn } = routedFetch(LINEAR_ROUTES);
    expect(await discoverSignIn("https://mcp.linear.app/mcp", fn)).toEqual({
      metadata: LINEAR_AS_METADATA,
      scopes: ["read", "write"],
      resource: "https://mcp.linear.app/mcp",
    });
  });

  it("gives the resource the document names exactly as written, even when that is a parent of the server's address", async () => {
    const { fn } = routedFetch({
      ...LINEAR_ROUTES,
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": { status: 200, json: { ...LINEAR_PRM, resource: "https://mcp.linear.app" } },
    });
    expect((await discoverSignIn("https://mcp.linear.app/mcp", fn))?.resource).toBe("https://mcp.linear.app");
  });

  it("prefers the scopes the 401 asked for", async () => {
    const { fn } = routedFetch({
      ...LINEAR_ROUTES,
      "https://mcp.linear.app/mcp": { status: 401, headers: { "www-authenticate": `${LINEAR_CHALLENGE}, scope="files:read"` } },
    });
    expect((await discoverSignIn("https://mcp.linear.app/mcp", fn))?.scopes).toEqual(["files:read"]);
  });

  it("passes on whether the server sends an issuer with its answers", async () => {
    const sends = { ...LINEAR_AS_METADATA, authorization_response_iss_parameter_supported: true };
    const { fn } = routedFetch({ ...LINEAR_ROUTES, "https://mcp.linear.app/.well-known/oauth-authorization-server": { status: 200, json: sends } });
    expect((await discoverSignIn("https://mcp.linear.app/mcp", fn))?.metadata.authorization_response_iss_parameter_supported).toBe(true);
  });

  it("refuses a server that publishes no resource metadata, whatever its own address offers", async () => {
    const { fn, requested } = routedFetch({
      "https://mcp.atlassian.com/v1/mcp": { status: 401 },
      "https://mcp.atlassian.com/.well-known/oauth-authorization-server": { status: 200, json: { ...LINEAR_AS_METADATA, issuer: "https://mcp.atlassian.com" } },
    });
    await expect(discoverSignIn("https://mcp.atlassian.com/v1/mcp", fn)).rejects.toThrow(/publishes no sign-in metadata/);
    expect(requested).not.toContain("https://mcp.atlassian.com/.well-known/oauth-authorization-server");
  });

  it("refuses a resource document that names another server, without asking its authorization server", async () => {
    const { fn, requested } = routedFetch({
      ...LINEAR_ROUTES,
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": { status: 200, json: { ...LINEAR_PRM, resource: "https://other.example.com/mcp" } },
    });
    await expect(discoverSignIn("https://mcp.linear.app/mcp", fn)).rejects.toThrow(/does not name this server/);
    expect(requested).not.toContain("https://mcp.linear.app/.well-known/oauth-authorization-server");
  });

  it("refuses an authorization server whose document does not pass the checks", async () => {
    const { fn } = routedFetch({
      ...LINEAR_ROUTES,
      "https://mcp.linear.app/.well-known/oauth-authorization-server": { status: 200, json: { ...LINEAR_AS_METADATA, issuer: "https://attacker.example" } },
    });
    await expect(discoverSignIn("https://mcp.linear.app/mcp", fn)).rejects.toThrow(/authorization server publishes no metadata that passes the checks/);
  });

  it("refuses an authorization server that is not a URL", async () => {
    const { fn } = routedFetch({
      ...LINEAR_ROUTES,
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": { status: 200, json: { ...LINEAR_PRM, authorization_servers: ["not a url"] } },
    });
    await expect(discoverSignIn("https://mcp.linear.app/mcp", fn)).rejects.toBeInstanceOf(SignInRefusedError);
  });

  it("finds nothing to sign in to when the server answers without a 401", async () => {
    const { fn } = routedFetch({ "https://mcp.linear.app/mcp": { status: 200, json: {} } });
    expect(await discoverSignIn("https://mcp.linear.app/mcp", fn)).toBeNull();
  });
});

describe("discoverAuthorizationServer", () => {
  it("resolves Linear's real issuer via the OAuth well-known path", async () => {
    const { fn, requested } = routedFetch({
      "https://mcp.linear.app/.well-known/oauth-authorization-server": { status: 200, json: LINEAR_AS_METADATA },
    });
    const result = await discoverAuthorizationServer("https://mcp.linear.app", fn);
    expect(result).toEqual(LINEAR_AS_METADATA);
    expect(requested).toEqual(["https://mcp.linear.app/.well-known/oauth-authorization-server"]);
  });

  it("falls back to OpenID Connect discovery when the OAuth path 404s", async () => {
    const oidc = { ...LINEAR_AS_METADATA, registration_endpoint: undefined };
    const { fn } = routedFetch({
      "https://mcp.linear.app/.well-known/oauth-authorization-server": { status: 404 },
      "https://mcp.linear.app/.well-known/openid-configuration": { status: 200, json: oidc },
    });
    expect(await discoverAuthorizationServer("https://mcp.linear.app", fn)).toEqual(oidc);
  });

  it("rejects a document whose issuer does not match, and moves on to the next candidate", async () => {
    const { fn } = routedFetch({
      "https://mcp.linear.app/.well-known/oauth-authorization-server": {
        status: 200,
        json: { ...LINEAR_AS_METADATA, issuer: "https://attacker.example" },
      },
      "https://mcp.linear.app/.well-known/openid-configuration": { status: 200, json: LINEAR_AS_METADATA },
    });
    expect(await discoverAuthorizationServer("https://mcp.linear.app", fn)).toEqual(LINEAR_AS_METADATA);
  });

  it.each([
    ["does not list PKCE methods", undefined],
    ["lists only plain", ["plain"]],
  ])("rejects a document that %s", async (_label, methods) => {
    const { fn } = routedFetch({
      "https://mcp.linear.app/.well-known/oauth-authorization-server": {
        status: 200,
        json: { ...LINEAR_AS_METADATA, code_challenge_methods_supported: methods },
      },
    });
    expect(await discoverAuthorizationServer("https://mcp.linear.app", fn)).toBeNull();
  });

  it("tries all three candidates, in order, for an issuer with a path component", async () => {
    const { fn, requested } = routedFetch({});
    await discoverAuthorizationServer("https://auth.example.com/tenant1", fn);
    expect(requested).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
      "https://auth.example.com/tenant1/.well-known/openid-configuration",
    ]);
  });

  it("returns null when nothing answers", async () => {
    const { fn } = routedFetch({});
    expect(await discoverAuthorizationServer("https://mcp.example.com", fn)).toBeNull();
  });
});

function fakeFetch(status: number, json: unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return { ok: status >= 200 && status < 300, status, json: async () => json } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("registerClient", () => {
  it("POSTs a public-client registration and returns the client_id", async () => {
    const { fn, calls } = fakeFetch(201, { client_id: "dcr-generated-id" });
    const result = await registerClient("https://mcp.linear.app/register", ["https://afm.example.com/"], fn);
    expect(result).toEqual({ clientId: "dcr-generated-id" });
    expect(calls[0]?.url).toBe("https://mcp.linear.app/register");
    expect(calls[0]?.body).toMatchObject({
      redirect_uris: ["https://afm.example.com/"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    });
    expect(calls[0]?.body.client_secret).toBeUndefined();
  });

  it("declares application_type 'native' for a localhost redirect URI, per the spec's own split", async () => {
    const { fn, calls } = fakeFetch(201, { client_id: "id" });
    await registerClient("https://mcp.example.com/register", ["http://localhost:5173/"], fn);
    expect(calls[0]?.body.application_type).toBe("native");
  });

  it("declares application_type 'web' for a deployed redirect URI", async () => {
    const { fn, calls } = fakeFetch(201, { client_id: "id" });
    await registerClient("https://mcp.example.com/register", ["https://afm.example.com/"], fn);
    expect(calls[0]?.body.application_type).toBe("web");
  });

  it("throws on a non-OK response", async () => {
    const { fn } = fakeFetch(400, { error: "invalid_client_metadata" });
    await expect(registerClient("https://mcp.example.com/register", ["https://afm.example.com/"], fn)).rejects.toThrow(
      /Registration failed: 400/,
    );
  });

  it("throws when the response has no client_id", async () => {
    const { fn } = fakeFetch(201, {});
    await expect(registerClient("https://mcp.example.com/register", ["https://afm.example.com/"], fn)).rejects.toThrow(
      /no client_id/,
    );
  });
});

describe("resolveClientId", () => {
  const REDIRECT = "https://afm.example.com/";
  const CIMD = "https://afm.example.com/oauth/client-metadata.json";

  it("uses the client id document when it is set up and the server accepts one, registering nothing", async () => {
    const { fn, calls } = fakeFetch(201, { client_id: "registered" });
    expect(await resolveClientId({ client_id_metadata_document_supported: true, registration_endpoint: "https://as.example/register" }, CIMD, REDIRECT, fn)).toBe(CIMD);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["the server does not accept one", { registration_endpoint: "https://as.example/register" }, CIMD],
    ["none is set up", { client_id_metadata_document_supported: true, registration_endpoint: "https://as.example/register" }, undefined],
  ])("registers a client when %s", async (_label, metadata, cimd) => {
    const { fn, calls } = fakeFetch(201, { client_id: "registered" });
    expect(await resolveClientId(metadata, cimd, REDIRECT, fn)).toBe("registered");
    expect(calls[0]?.url).toBe("https://as.example/register");
    expect(calls[0]?.body.redirect_uris).toEqual([REDIRECT]);
  });

  it("gives an empty id when the server offers no way to get one", async () => {
    const { fn, calls } = fakeFetch(201, { client_id: "registered" });
    expect(await resolveClientId({}, CIMD, REDIRECT, fn)).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("gives an empty id when the registration is refused", async () => {
    const { fn } = fakeFetch(400, { error: "invalid_client_metadata" });
    expect(await resolveClientId({ registration_endpoint: "https://as.example/register" }, undefined, REDIRECT, fn)).toBe("");
  });
});
