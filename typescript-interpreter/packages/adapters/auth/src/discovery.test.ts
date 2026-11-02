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
import type { OAuthProviderRef } from "./authorization-code";
import {
  discoverAuthorizationServer,
  discoverProtectedResource,
  discoverSignIn,
  discoverSignInServer,
  parseChallengeScope,
  parseResourceMetadataUrl,
  registerClient,
  resolveClientId,
  SignInRefusedError,
} from "./discovery";
import { config } from "./test-support";

const LINEAR_CHALLENGE =
  'Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", ' +
  'error="invalid_token", error_description="Missing or invalid access token"';
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

  it("reads the parameter name in any letter case", () => {
    expect(parseResourceMetadataUrl('Bearer Resource_Metadata="https://x/prm"')).toBe("https://x/prm");
  });

  it("does not take the value of a longer parameter name that ends the same way", () => {
    const challenge = 'Bearer my_resource_metadata="https://evil.example/p", resource_metadata="https://ok.example/p"';
    expect(parseResourceMetadataUrl(challenge)).toBe("https://ok.example/p");
  });

  it("finds it when it comes first, right after the scheme", () => {
    expect(parseResourceMetadataUrl('Bearer resource_metadata="https://x/prm", scope="a"')).toBe("https://x/prm");
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

  it("reads the scope when it is the first parameter after the scheme", () => {
    expect(parseChallengeScope('Bearer scope="files:read", resource_metadata="https://x/prm"')).toEqual(["files:read"]);
  });

  it("reads the parameter name in any letter case", () => {
    expect(parseChallengeScope('Bearer Scope="a b"')).toEqual(["a", "b"]);
  });

  it("drops spaces around the list instead of returning an empty scope", () => {
    expect(parseChallengeScope('Bearer scope=" a  b "')).toEqual(["a", "b"]);
  });

  it.each([
    ["a longer parameter name", 'Bearer myscope="x"'],
    ["the text of another parameter", 'Bearer error="insufficient_scope", error_description="need scope=\\"x\\""'],
  ])("does not take a scope from %s", (_label, challenge) => {
    expect(parseChallengeScope(challenge)).toBeNull();
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

describe("the metadata address a challenge advertises", () => {
  const server = "https://mcp.example.com/mcp";
  const wellKnown = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
  const document = { resource: server, authorization_servers: ["https://auth.example.com"] };
  const challenge = (address: string) => ({ "www-authenticate": `Bearer resource_metadata="${address}"` });

  it.each([
    ["a plain http address on another host", "http://192.168.1.1/admin"],
    ["a plain http address on a lookalike host", "http://mcp.example.com.evil.com/prm"],
    ["a plain http address on the same host", "http://mcp.example.com/prm"],
    ["something that is not an address", "not a url"],
    ["a path with no host", "/prm"],
  ])("is not fetched when it is %s, and the standard address is used instead", async (_label, advertised) => {
    const { fn, requested } = routedFetch({
      [server]: { status: 401, headers: challenge(advertised) },
      [wellKnown]: { status: 200, json: document },
    });
    const result = await discoverProtectedResource(server, fn);
    expect(result?.metadata).toEqual(document);
    expect(requested).toEqual([server, wellKnown]);
  });

  it("is fetched when it is https, even on another host", async () => {
    const { fn, requested } = routedFetch({
      [server]: { status: 401, headers: challenge("https://meta.example.com/prm") },
      "https://meta.example.com/prm": { status: 200, json: document },
    });
    const result = await discoverProtectedResource(server, fn);
    expect(result?.metadata).toEqual(document);
    expect(requested).toEqual([server, "https://meta.example.com/prm"]);
  });

  it("is fetched over plain http when the server itself is at that origin", async () => {
    const local = "http://localhost:3000/mcp";
    const { fn, requested } = routedFetch({
      [local]: { status: 401, headers: challenge("http://localhost:3000/custom/metadata") },
      "http://localhost:3000/custom/metadata": { status: 200, json: { resource: local, authorization_servers: ["https://auth.example.com"] } },
    });
    const result = await discoverProtectedResource(local, fn);
    expect(result?.metadata.authorization_servers).toEqual(["https://auth.example.com"]);
    expect(requested).toEqual([local, "http://localhost:3000/custom/metadata"]);
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
      challengeScope: null,
      resource: "https://mcp.linear.app/mcp",
    });
  });

  describe("when the resource document names several authorization servers", () => {
    const routesFor = (issuers: string[]) => ({
      ...LINEAR_ROUTES,
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": { status: 200, json: { ...LINEAR_PRM, authorization_servers: issuers } },
    });

    it("uses the first one that passes the checks, whatever happened to those before it", async () => {
      const { fn } = routedFetch(routesFor(["https://down.example", "http://plain.example", "https://mcp.linear.app"]));
      expect((await discoverSignIn("https://mcp.linear.app/mcp", fn))?.metadata).toEqual(LINEAR_AS_METADATA);
    });

    it("refuses when none of them passes", async () => {
      const { fn } = routedFetch(routesFor(["https://down.example", "http://plain.example"]));
      await expect(discoverSignIn("https://mcp.linear.app/mcp", fn)).rejects.toThrow(/authorization server publishes no metadata/);
    });

    it("looks at no more than five, so a long list cannot make it ask for ever", async () => {
      const six = [...Array.from({ length: 5 }, (_, i) => `https://down${i}.example`), "https://mcp.linear.app"];
      const { fn, requested } = routedFetch(routesFor(six));
      await expect(discoverSignIn("https://mcp.linear.app/mcp", fn)).rejects.toThrow(/authorization server publishes no metadata/);
      expect(requested.some((url) => url.startsWith("https://mcp.linear.app/.well-known/oauth-authorization-server"))).toBe(false);
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

  it("does not ask an issuer that is not https for anything", async () => {
    const { fn, requested } = routedFetch({});
    expect(await discoverAuthorizationServer("http://mcp.linear.app", fn)).toBeNull();
    expect(requested).toEqual([]);
  });

  it.each([
    ["authorization endpoint", { authorization_endpoint: "http://mcp.linear.app/authorize" }],
    ["token endpoint", { token_endpoint: "http://mcp.linear.app/token" }],
    ["authorization endpoint (missing)", { authorization_endpoint: undefined }],
    ["token endpoint (missing)", { token_endpoint: undefined }],
  ])("rejects a document whose %s is not an https address", async (_label, changed) => {
    const { fn } = routedFetch({
      "https://mcp.linear.app/.well-known/oauth-authorization-server": { status: 200, json: { ...LINEAR_AS_METADATA, ...changed } },
    });
    expect(await discoverAuthorizationServer("https://mcp.linear.app", fn)).toBeNull();
  });

  describe("when the document comes from somewhere other than the address asked for", () => {
    const servedFrom = (finalUrl: string) =>
      (async () => Object.defineProperty(Response.json(LINEAR_AS_METADATA), "url", { value: finalUrl })) as unknown as typeof fetch;

    it("rejects a document an https address handed over from a plain http one", async () => {
      expect(await discoverAuthorizationServer("https://mcp.linear.app", servedFrom("http://mcp.linear.app/metadata"))).toBeNull();
    });

    it("accepts a document served from an https address, even after a redirect between https addresses", async () => {
      const found = await discoverAuthorizationServer("https://mcp.linear.app", servedFrom("https://other.linear.app/metadata"));
      expect(found).toEqual(LINEAR_AS_METADATA);
    });
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
  it("sends nothing to a registration endpoint that is not https", async () => {
    const { fn, calls } = fakeFetch(201, { client_id: "x" });
    await expect(registerClient("http://mcp.linear.app/register", ["https://afm.example.com/"], fn)).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);
  });

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

  it.each([
    ["a localhost address with no path", "http://localhost:5173", "native"],
    ["a 127.0.0.1 address with a path", "http://127.0.0.1:8080/callback", "native"],
    ["an IPv6 loopback address", "http://[::1]:8080/callback", "native"],
    ["a host that only starts with localhost", "http://localhost.evil.example/callback", "web"],
    ["an address whose real host is not localhost", "http://localhost@evil.example/callback", "web"],
    ["something that is not an address", "not a url", "web"],
  ])("declares the right application_type for %s", async (_label, redirectUri, expected) => {
    const { fn, calls } = fakeFetch(201, { client_id: "id" });
    await registerClient("https://mcp.example.com/register", [redirectUri], fn);
    expect(calls[0]?.body.application_type).toBe(expected);
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

  it("does not register at an endpoint that is not https, and gives no client id", async () => {
    const { fn, calls } = fakeFetch(201, { client_id: "registered" });
    expect(await resolveClientId({ registration_endpoint: "http://as.example/register" }, undefined, REDIRECT, fn)).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("treats an empty client id document address as not set up, and registers instead", async () => {
    const { fn, calls } = fakeFetch(201, { client_id: "registered" });
    const metadata = { client_id_metadata_document_supported: true, registration_endpoint: "https://as.example/register" };
    expect(await resolveClientId(metadata, "", REDIRECT, fn)).toBe("registered");
    expect(calls).toHaveLength(1);
  });

  it("uses the client id document when it is set up and the server accepts one, registering nothing", async () => {
    const { fn, calls } = fakeFetch(201, { client_id: "registered" });
    const metadata = { client_id_metadata_document_supported: true, registration_endpoint: "https://as.example/register" };
    expect(await resolveClientId(metadata, CIMD, REDIRECT, fn)).toBe(CIMD);
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

describe("discoverSignInServer", () => {
  const MCP = "https://mcp.example.com/mcp";
  const CIMD = "https://afm.example.com/oauth/client-metadata.json";
  const published = {
    issuer: "https://auth.example.com",
    authorization_endpoint: config.authorizeUrl,
    token_endpoint: config.tokenUrl,
    code_challenge_methods_supported: ["S256"],
    registration_endpoint: "https://auth.example.com/register",
  };
  const provider: OAuthProviderRef = { authorizeUrl: config.authorizeUrl, tokenUrl: config.tokenUrl, clientId: config.clientId, resource: MCP };

  function serverFetch(as: Record<string, unknown> | null = published, resource: string = MCP) {
    const requested: string[] = [];
    const routes: Record<string, { status?: number; json?: unknown; headers?: Record<string, string> }> = {
      [MCP]: { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/prm"' } },
      "https://mcp.example.com/prm": { json: { resource, authorization_servers: ["https://auth.example.com"] } },
      "https://auth.example.com/register": { status: 201, json: { client_id: "registered" } },
      ...(as === null ? {} : { "https://auth.example.com/.well-known/oauth-authorization-server": { json: as } }),
    };
    const fn = (async (input: string) => {
      requested.push(String(input));
      const route = routes[String(input)];
      return route === undefined ? new Response("", { status: 404 }) : Response.json(route.json ?? {}, { status: route.status ?? 200, headers: route.headers });
    }) as unknown as typeof fetch;
    return { fn, requested };
  }

  const discover = (fn: typeof fetch, from = provider, cimdClientId?: string) =>
    discoverSignInServer(from, { fetchFn: fn, redirectUri: config.redirectUri, cimdClientId });

  it("takes the endpoints and the issuer from what the server publishes, not from the file", async () => {
    const fromFile = { ...provider, authorizeUrl: "https://attacker.example/authorize", tokenUrl: "https://attacker.example/token" };
    const found = await discover(serverFetch().fn, fromFile);
    expect(found).toMatchObject({ authorizeUrl: config.authorizeUrl, tokenUrl: config.tokenUrl, issuer: "https://auth.example.com" });
  });

  it("carries the scope the server asked for in its challenge, and nothing broader", async () => {
    const { fn } = serverFetch();
    const asking = (async (input: string, init?: RequestInit) =>
      String(input) === MCP
        ? Response.json({}, { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/prm", scope="files:read"' } })
        : fn(input, init)) as unknown as typeof fetch;
    expect((await discover(asking)).scopes).toEqual(["files:read"]);
    expect((await discover(fn)).scopes).toBeUndefined();
  });

  it("takes the resource from what the server publishes, as written, even when it is a parent of the server's address", async () => {
    expect((await discover(serverFetch(published, "https://mcp.example.com").fn)).resource).toBe("https://mcp.example.com");
    expect((await discover(serverFetch().fn)).resource).toBe(MCP);
  });

  it("keeps the file's client id for the authorization server it was set up with, registering nothing", async () => {
    const { fn, requested } = serverFetch();
    expect((await discover(fn)).clientId).toBe(config.clientId);
    expect(requested).not.toContain("https://auth.example.com/register");
  });

  it("compares the endpoints as normalised URLs", async () => {
    const found = await discover(serverFetch({ ...published, token_endpoint: "https://auth.example.com:443/oauth2/token" }).fn);
    expect(found.clientId).toBe(config.clientId);
  });

  it("registers a client when the file has none", async () => {
    expect((await discover(serverFetch().fn, { ...provider, clientId: "" })).clientId).toBe("registered");
  });

  describe("when the server uses a different authorization server than the file was set up with", () => {
    const moved = { ...provider, authorizeUrl: "https://old-auth.example.com/authorize", tokenUrl: "https://old-auth.example.com/token" };

    it("does not reuse the file's client id: it registers a new one", async () => {
      const { fn, requested } = serverFetch();
      expect((await discover(fn, moved)).clientId).toBe("registered");
      expect(requested).toContain("https://auth.example.com/register");
    });

    it("uses the client id document, when the server accepts one, registering nothing", async () => {
      const { fn, requested } = serverFetch({ ...published, client_id_metadata_document_supported: true });
      expect((await discover(fn, moved, CIMD)).clientId).toBe(CIMD);
      expect(requested).not.toContain("https://auth.example.com/register");
    });

    it("refuses when no client id can be had, so the user is asked for one", async () => {
      const { registration_endpoint: _omitted, ...noRegistration } = published;
      await expect(discover(serverFetch(noRegistration).fn, moved)).rejects.toThrow(/client ID/);
    });
  });

  it.each([
    ["sends one", true, true],
    ["does not say it sends one", undefined, false],
    ["says it does not send one", false, false],
  ])("notes whether the server %s", async (_label, flag, sent) => {
    const found = await discover(serverFetch({ ...published, authorization_response_iss_parameter_supported: flag }).fn);
    expect(found.issuerSent).toBe(sent);
  });

  it("refuses a server that publishes no resource document, so no sign-in starts", async () => {
    const { fn, requested } = serverFetch();
    const bare = (async (input: string, init?: RequestInit) =>
      String(input) === "https://mcp.example.com/prm" ? new Response("", { status: 404 }) : fn(input, init)) as unknown as typeof fetch;
    await expect(discover(bare)).rejects.toThrow(/publishes no sign-in metadata.*current one/);
    expect(requested).not.toContain("https://auth.example.com/register");
  });

  it("refuses a server whose resource document names another server", async () => {
    await expect(discover(serverFetch(published, "https://other.example.com/mcp").fn)).rejects.toThrow(/does not name this server/);
  });

  it("refuses a server whose authorization server does not pass the checks", async () => {
    await expect(discover(serverFetch({ ...published, issuer: "https://attacker.example" }).fn)).rejects.toThrow(/authorization server publishes no metadata/);
  });

  it("refuses a server that does not ask for a sign-in", async () => {
    const open = (async () => Response.json({}, { status: 200 })) as unknown as typeof fetch;
    await expect(discover(open)).rejects.toThrow(/did not ask for a sign-in/);
  });

  it("refuses a file that names no server address", async () => {
    await expect(discover(serverFetch().fn, { ...provider, resource: undefined })).rejects.toThrow(/did not ask for a sign-in/);
  });
});
