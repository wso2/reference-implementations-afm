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
import {
  advertisedMetadataUrl,
  challengeOf,
  checkedAuthorizationServer,
  checkedResource,
  discoverAuthorizationServer,
  parseChallengeScope,
  registerClient,
  resolveClientId,
  SignInRefusedError,
} from "./discovery";

const LINEAR_CHALLENGE =
  'Bearer realm="OAuth", resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp", ' +
  'error="invalid_token", error_description="Missing or invalid access token"';
const LINEAR_AS_METADATA = {
  issuer: "https://mcp.linear.app",
  authorization_endpoint: "https://mcp.linear.app/authorize",
  token_endpoint: "https://mcp.linear.app/token",
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  registration_endpoint: "https://mcp.linear.app/register",
  client_id_metadata_document_supported: true,
};

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

describe("challengeOf", () => {
  it("is null when the server answers without a 401 - no sign-in is asked for", async () => {
    const { fn } = routedFetch({ "https://mcp.linear.app/mcp": { status: 200 } });
    expect(await challengeOf("https://mcp.linear.app/mcp", fn)).toBeNull();
  });

  it("is null when the request fails outright (network or CORS) rather than throwing", async () => {
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await challengeOf("https://mcp.linear.app/mcp", offline)).toBeNull();
  });

  it("gives the challenge a 401 carries", async () => {
    const { fn } = routedFetch({ "https://mcp.linear.app/mcp": { status: 401, headers: { "www-authenticate": LINEAR_CHALLENGE } } });
    expect(await challengeOf("https://mcp.linear.app/mcp", fn)).toBe(LINEAR_CHALLENGE);
  });

  it("gives an empty challenge when a 401 carries none", async () => {
    const { fn } = routedFetch({ "https://mcp.linear.app/mcp": { status: 401 } });
    expect(await challengeOf("https://mcp.linear.app/mcp", fn)).toBe("");
  });
});

describe("advertisedMetadataUrl", () => {
  const server = "https://mcp.linear.app/mcp";

  it.each([
    ["Linear's real challenge", LINEAR_CHALLENGE, "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp"],
    ["the parameter name in any letter case", 'Bearer Resource_Metadata="https://mcp.linear.app/prm"', "https://mcp.linear.app/prm"],
    ["the parameter right after the scheme", 'Bearer resource_metadata="https://mcp.linear.app/prm", realm="x"', "https://mcp.linear.app/prm"],
  ])("gives the address in %s", (_label, challenge, expected) => {
    expect(advertisedMetadataUrl(challenge, server)).toEqual(new URL(expected));
  });

  it.each([
    ["no challenge", ""],
    ["a challenge without the parameter", 'Bearer realm="OAuth"'],
    ["a longer parameter name that ends the same way", 'Bearer xresource_metadata="https://mcp.linear.app/prm"'],
    ["an address on another host", 'Bearer resource_metadata="https://evil.example/prm"'],
    ["an address on a lookalike host", 'Bearer resource_metadata="https://mcp.linear.app.evil.example/prm"'],
    ["the same host over plain http", 'Bearer resource_metadata="http://mcp.linear.app/prm"'],
    ["something that is not an address", 'Bearer resource_metadata="not an address"'],
    ["a path with no host", 'Bearer resource_metadata="/prm"'],
  ])("ignores %s, so the standard address is used instead", (_label, challenge) => {
    expect(advertisedMetadataUrl(challenge, server)).toBeUndefined();
  });
});

describe("the resource a server's sign-in data names", () => {
  it("is refused, saying to use the current address, when the server publishes none", () => {
    expect(() => checkedResource("https://mcp.example.com/mcp", undefined)).toThrow(/publishes no sign-in metadata.*current one/);
    expect(() => checkedResource("https://mcp.example.com/mcp", undefined)).toThrow(SignInRefusedError);
  });

  it.each([
    ["the server's own address", "https://mcp.example.com/team/mcp", "https://mcp.example.com/team/mcp"],
    ["a parent path", "https://mcp.example.com/team/mcp", "https://mcp.example.com/team"],
    ["a parent path that ends at a slash", "https://mcp.example.com/team/mcp", "https://mcp.example.com/team/"],
    ["the bare origin", "https://mcp.example.com/team/mcp", "https://mcp.example.com"],
    ["the origin with its slash", "https://mcp.example.com/team/mcp", "https://mcp.example.com/"],
    ["a parent path on a non-default port", "https://mcp.example.com:8443/team/mcp", "https://mcp.example.com:8443/team"],
  ])("accepts %s", (_label, serverUrl, resource) => {
    expect(checkedResource(serverUrl, resource)).toEqual(new URL(resource));
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
  ])("refuses %s", (_label, serverUrl, resource) => {
    expect(() => checkedResource(serverUrl, resource)).toThrow(/does not name this server/);
  });
});

describe("checkedAuthorizationServer", () => {
  it("gives the metadata of an authorization server that passes the checks", async () => {
    const { fn } = routedFetch({ "https://mcp.linear.app/.well-known/oauth-authorization-server": { status: 200, json: LINEAR_AS_METADATA } });
    expect(await checkedAuthorizationServer("https://mcp.linear.app", fn)).toEqual(LINEAR_AS_METADATA);
  });

  it("refuses one that does not, saying which checks it failed", async () => {
    const { fn } = routedFetch({});
    await expect(checkedAuthorizationServer("https://mcp.linear.app", fn)).rejects.toThrow(/publishes no metadata that passes the checks/);
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

  it.each([[undefined], [[]], [["token"]]])("rejects a document whose response types are %j, because the code flow needs `code`", async (types) => {
    const { fn } = routedFetch({
      "https://mcp.linear.app/.well-known/oauth-authorization-server": { status: 200, json: { ...LINEAR_AS_METADATA, response_types_supported: types } },
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
