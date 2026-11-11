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

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizationCodeRefreshKey,
  createAuthorizationCodeSession,
  discoverSignIn,
  type AuthorizationCodeConfig,
  type AuthorizationCodeSession,
  type KeyValueStore,
} from "./session";

const directory = vi.hoisted(() => ({ addresses: [] as string[] }));
vi.mock("../mcp/mcp-directory", () => ({ isDirectoryAddress: (address: string) => directory.addresses.includes(address) }));
beforeEach(() => {
  directory.addresses = [];
});

const MCP = "https://mcp.example.com/mcp";
const AS = "https://auth.example.com";
const config: AuthorizationCodeConfig = {
  authorizeUrl: `${AS}/authorize`,
  tokenUrl: `${AS}/token`,
  clientId: "client-123",
  redirectUri: "https://afm.example.com/app/",
  scopes: ["read", "write"],
  resource: MCP,
};
const refreshKey = authorizationCodeRefreshKey(config);

const reply = (value: unknown, status = 200) => Response.json(value, { status });

interface World {
  asMetadata: Record<string, unknown>;
  resource: Record<string, unknown> | null;
  server: () => Response;
  requests: { url: string; body: URLSearchParams; redirect?: RequestRedirect }[];
  holdToken: Promise<void>;
  tokenAnswer: (body: URLSearchParams) => Response;
  fetchFn: typeof fetch;
}

function world(): World {
  let issued = 0;
  const w: World = {
    asMetadata: {
      issuer: AS,
      authorization_endpoint: `${AS}/authorize`,
      token_endpoint: `${AS}/token`,
      registration_endpoint: `${AS}/register`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    },
    resource: { resource: MCP, authorization_servers: [AS], scopes_supported: ["from-server"] },
    server: () => new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="OAuth"' } }),
    requests: [],
    holdToken: Promise.resolve(),
    tokenAnswer: (body) => {
      if (body.get("grant_type") === "refresh_token") {
        return body.get("refresh_token") === "refresh-1" ? reply({ access_token: `access-${++issued}`, token_type: "Bearer" }) : reply({ error: "invalid_grant" }, 400);
      }
      return body.get("code") === "good-code"
        ? reply({ access_token: `access-${++issued}`, token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1" })
        : reply({ error: "invalid_grant" }, 400);
    },
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      const body = new URLSearchParams(typeof init?.body === "string" || init?.body instanceof URLSearchParams ? init.body.toString() : "");
      w.requests.push({ url: url.href, body, redirect: init?.redirect });
      if (url.href === MCP) return w.server();
      if (url.href === "https://mcp.example.com/prm") return reply(w.resource);
      if (url.href.startsWith("https://mcp.example.com/.well-known/oauth-protected-resource")) {
        return w.resource === null ? new Response("", { status: 404 }) : reply(w.resource);
      }
      if (url.href === `${AS}/.well-known/oauth-authorization-server`) return reply(w.asMetadata);
      if (url.href === `${AS}/register`) return reply({ client_id: "registered", redirect_uris: [config.redirectUri] }, 201);
      if (url.href === `${AS}/token`) {
        await w.holdToken;
        return w.tokenAnswer(body);
      }
      return new Response("", { status: 404 });
    },
  };
  return w;
}

function memoryStore(failSet = false): KeyValueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      if (failSet) throw new Error("storage is full");
      values.set(key, value);
    },
    remove: (key) => {
      values.delete(key);
    },
  };
}

function setup(overrides: Partial<AuthorizationCodeConfig> = {}, store = memoryStore(), w = world()) {
  const session = createAuthorizationCodeSession({ ...config, ...overrides }, store, w.fetchFn);
  return { w, store, session };
}

async function startedAt(session: AuthorizationCodeSession): Promise<URL> {
  let url = "";
  await session.startSignIn((to) => {
    url = to;
  });
  return new URL(url);
}

async function signedIn(overrides: Partial<AuthorizationCodeConfig> = {}) {
  const made = setup(overrides);
  const authorize = await startedAt(made.session);
  await made.session.completeSignIn("good-code", authorize.searchParams.get("state")!);
  return { ...made, authorize };
}

const tokenRequests = (w: World) => w.requests.filter((r) => r.url === `${AS}/token`);

describe("starting a sign-in", () => {
  it("sends the person to the server's authorize address with PKCE S256, a state, the file's client and the resource the server named", async () => {
    const { session } = setup();
    const url = await startedAt(session);
    const p = url.searchParams;
    expect(`${url.origin}${url.pathname}`).toBe(config.authorizeUrl);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("client-123");
    expect(p.get("redirect_uri")).toBe(config.redirectUri);
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("state")).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(p.get("resource")).toBe(MCP);
    expect(session.hasSession()).toBe(false);
  });

  it("uses a different state and challenge each time", async () => {
    const { session } = setup();
    const [first, second] = [await startedAt(session), await startedAt(session)];
    expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"));
    expect(first.searchParams.get("code_challenge")).not.toBe(second.searchParams.get("code_challenge"));
  });

  it.each([
    ["the file's own scope, whatever the server lists", { scopes: ["mine"] }, "mine"],
    ["the scopes the server lists, when the file sets none", { scopes: undefined }, "from-server"],
    ["the scopes the server lists, when the file's list is empty", { scopes: [] }, "from-server"],
  ])("asks for %s", async (_label, overrides, scope) => {
    const url = await startedAt(setup(overrides).session);
    expect(url.searchParams.get("scope")).toBe(scope);
  });

  it("registers a client only when the file has none", async () => {
    const withId = setup();
    await startedAt(withId.session);
    expect(withId.w.requests.some((r) => r.url === `${AS}/register`)).toBe(false);

    const without = setup({ clientId: "" });
    expect((await startedAt(without.session)).searchParams.get("client_id")).toBe("registered");
  });

  it("does not sign out a person who starts a new sign-in", async () => {
    const { session } = await signedIn();
    await startedAt(session);
    expect(session.hasSession()).toBe(true);
  });
});

describe("what the server publishes is checked", () => {
  it.each([
    ["an authorization server that does not list S256", (w: World) => (w.asMetadata = { ...w.asMetadata, code_challenge_methods_supported: ["plain"] })],
    ["an authorization server whose issuer is another address", (w: World) => (w.asMetadata = { ...w.asMetadata, issuer: "https://attacker.example" })],
    ["a resource document that names another server", (w: World) => (w.resource = { ...w.resource, resource: "https://other.example.com/mcp" })],
  ])("refuses %s", async (_label, change) => {
    const { session, w } = setup();
    change(w);
    await expect(startedAt(session)).rejects.toThrow();
  });

  it("reads the sign-in data from the address the server advertises, for the sign-in, the code exchange and every renewal", async () => {
    const { session, w } = setup();
    w.server = () => new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/prm"' } });
    const authorize = await startedAt(session);
    await session.completeSignIn("good-code", authorize.searchParams.get("state")!);
    expect(await session.renew("access-1")).toBe(true);
    const documents = w.requests.map((r) => r.url).filter((url) => url.includes("prm") || url.includes("oauth-protected-resource"));
    expect(new Set(documents)).toEqual(new Set(["https://mcp.example.com/prm"]));
  });

  it("says so when the server publishes no sign-in metadata, instead of guessing where to sign in", async () => {
    const { session, w } = setup();
    w.resource = null;
    await expect(startedAt(session)).rejects.toThrow(/publishes no sign-in metadata.*current one/);
  });

  it("says so when the server's sign-in metadata names another server", async () => {
    const { session, w } = setup();
    w.resource = { ...w.resource, resource: "https://other.example.com/mcp" };
    await expect(startedAt(session)).rejects.toThrow(/does not name this server/);
  });

  it("refuses an authorization server that publishes no metadata, instead of guessing its endpoints", async () => {
    const { session, w } = setup();
    w.asMetadata = {};
    await expect(startedAt(session)).rejects.toThrow(/publishes no metadata that passes the checks/);
  });

  it("refuses an authorize address that is not https, before the page ever gets it", async () => {
    const { session, w } = setup();
    w.asMetadata = { ...w.asMetadata, authorization_endpoint: "http://auth.example.com/authorize" };
    await expect(startedAt(session)).rejects.toThrow(/publishes no metadata that passes the checks/);
  });

  it("does not register a client at an address that is not https", async () => {
    const { session, w } = setup({ clientId: "" });
    w.asMetadata = { ...w.asMetadata, registration_endpoint: "http://auth.example.com/register" };
    await expect(startedAt(session)).rejects.toThrow(/https/);
    expect(w.requests.some((r) => r.url.startsWith("http://"))).toBe(false);
  });

  it("never sends anything to an address that is not https", async () => {
    const made = setup();
    made.w.asMetadata = { ...made.w.asMetadata, token_endpoint: "http://auth.example.com/token" };
    await expect(startedAt(made.session)).rejects.toThrow();
    expect(made.w.requests.some((r) => r.url.startsWith("http://"))).toBe(false);
  });
});

describe("finishing a sign-in", () => {
  it("exchanges the code with the verifier, the file's client and the resource, and keeps the tokens", async () => {
    const { session, w, store } = await signedIn();
    const [request] = tokenRequests(w);
    expect(Object.fromEntries(request!.body)).toMatchObject({
      grant_type: "authorization_code",
      code: "good-code",
      client_id: "client-123",
      redirect_uri: config.redirectUri,
      resource: MCP,
    });
    expect(request!.body.get("code_verifier")).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(request!.redirect).toBe("error");
    expect(session.hasSession()).toBe(true);
    expect(session.accessToken()).toBe("access-1");
    expect(store.values.get(refreshKey)).toBe("refresh-1");
  });

  it("keeps a sign-in whose refresh token could not be saved, instead of reporting it as failed", async () => {
    const made = setup({}, memoryStore(true));
    const authorize = await startedAt(made.session);
    await made.session.completeSignIn("good-code", authorize.searchParams.get("state")!);
    expect(made.session.accessToken()).toBe("access-1");
  });

  it("does not keep a refresh token the new sign-in did not bring", async () => {
    const made = setup();
    made.store.set(refreshKey, "old-refresh");
    made.w.tokenAnswer = () => reply({ access_token: "a", token_type: "Bearer" });
    const authorize = await startedAt(made.session);
    await made.session.completeSignIn("good-code", authorize.searchParams.get("state")!);
    expect(made.store.values.has(refreshKey)).toBe(false);
  });

  it("refuses a token answer that has no token_type", async () => {
    const made = setup();
    made.w.tokenAnswer = () => reply({ access_token: "a" });
    const authorize = await startedAt(made.session);
    await expect(made.session.completeSignIn("good-code", authorize.searchParams.get("state")!)).rejects.toThrow();
    expect(made.session.hasSession()).toBe(false);
  });

  it("refuses an answer when no sign-in is waiting for it", async () => {
    const { session, w } = setup();
    await expect(session.completeSignIn("good-code", "any")).rejects.toThrow(/No OAuth2 sign-in is waiting/);
    expect(tokenRequests(w)).toHaveLength(0);
  });

  it("refuses a wrong state without asking for tokens, and the sign-in cannot be retried with the right one", async () => {
    const { session, w } = setup();
    const authorize = await startedAt(session);
    await expect(session.completeSignIn("good-code", "forged")).rejects.toThrow(/state mismatch/);
    await expect(session.completeSignIn("good-code", authorize.searchParams.get("state")!)).rejects.toThrow(/No OAuth2 sign-in is waiting/);
    expect(tokenRequests(w)).toHaveLength(0);
  });

  describe("the issuer an answer names", () => {
    const promised = (w: World) => {
      w.asMetadata = { ...w.asMetadata, authorization_response_iss_parameter_supported: true };
    };

    it("lets the sign-in finish when it is exactly the recorded issuer", async () => {
      const { session } = setup();
      const authorize = await startedAt(session);
      await session.completeSignIn("good-code", authorize.searchParams.get("state")!, AS);
      expect(session.hasSession()).toBe(true);
    });

    it("refuses the recorded issuer with a slash added, because the two must be identical", async () => {
      const { session, w } = setup();
      const authorize = await startedAt(session);
      await expect(session.completeSignIn("good-code", authorize.searchParams.get("state")!, `${AS}/`)).rejects.toThrow(/expected provider/);
      expect(tokenRequests(w)).toHaveLength(0);
    });

    it("lets an answer with no issuer through when the server never said it would send one", async () => {
      const { session } = setup();
      const authorize = await startedAt(session);
      await session.completeSignIn("good-code", authorize.searchParams.get("state")!);
      expect(session.hasSession()).toBe(true);
    });

    it("refuses an answer from another issuer, without asking for tokens", async () => {
      const { session, w } = setup();
      const authorize = await startedAt(session);
      await expect(session.completeSignIn("good-code", authorize.searchParams.get("state")!, "https://attacker.example")).rejects.toThrow(/expected provider/);
      expect(tokenRequests(w)).toHaveLength(0);
    });

    it("refuses an answer with no issuer when the server said it would send one, without asking for tokens", async () => {
      const { session, w } = setup();
      promised(w);
      const authorize = await startedAt(session);
      await expect(session.completeSignIn("good-code", authorize.searchParams.get("state")!)).rejects.toThrow(/expected provider/);
      expect(tokenRequests(w)).toHaveLength(0);
    });

    it("lets an answer through when the server said it would send an issuer and did", async () => {
      const { session, w } = setup();
      promised(w);
      const authorize = await startedAt(session);
      await session.completeSignIn("good-code", authorize.searchParams.get("state")!, AS);
      expect(session.hasSession()).toBe(true);
    });

    it("uses the login server it discovered, never the one the file names", async () => {
      const { session, w } = setup({ authorizeUrl: "https://attacker.example/authorize", tokenUrl: "https://attacker.example/token" });
      const authorize = await startedAt(session);
      expect(authorize.origin).toBe(AS);
      await session.completeSignIn("good-code", authorize.searchParams.get("state")!, AS);
      expect(w.requests.map((r) => new URL(r.url).origin)).not.toContain("https://attacker.example");
      expect(tokenRequests(w)).toHaveLength(1);
    });

    describe("for a server the directory lists", () => {
      it.each([["no issuer", undefined], ["another issuer", "https://attacker.example"], ["a slash added", `${AS}/`]])(
        "is not held to it: an answer with %s still finishes the sign-in",
        async (_name, iss) => {
          directory.addresses = [MCP];
          const { session, w } = setup();
          promised(w);
          const authorize = await startedAt(session);
          await session.completeSignIn("good-code", authorize.searchParams.get("state")!, iss);
          expect(session.hasSession()).toBe(true);
        },
      );

      it("is still signed in at the login server the directory server itself names, not one the file names", async () => {
        directory.addresses = [MCP];
        const { session, w } = setup({ authorizeUrl: "https://attacker.example/authorize", tokenUrl: "https://attacker.example/token" });
        const authorize = await startedAt(session);
        expect(authorize.origin).toBe(AS);
        await session.completeSignIn("good-code", authorize.searchParams.get("state")!, "https://attacker.example");
        expect(w.requests.map((r) => new URL(r.url).origin)).not.toContain("https://attacker.example");
      });

      it("still needs the right state", async () => {
        directory.addresses = [MCP];
        const { session } = setup();
        await startedAt(session);
        await expect(session.completeSignIn("good-code", "forged")).rejects.toThrow(/state mismatch/);
      });
    });
  });

  describe("a refusal from the provider", () => {
    it("ends the sign-in, so a later answer for it is refused", async () => {
      const { session } = setup();
      const state = (await startedAt(session)).searchParams.get("state")!;
      session.declineSignIn(state, AS);
      await expect(session.completeSignIn("good-code", state)).rejects.toThrow(/No OAuth2 sign-in is waiting/);
    });

    it("is dropped when it carries the wrong state or issuer", async () => {
      const { session } = setup();
      const state = (await startedAt(session)).searchParams.get("state")!;
      expect(() => session.declineSignIn("forged")).toThrow(/state mismatch/);
      const again = (await startedAt(session)).searchParams.get("state")!;
      expect(() => session.declineSignIn(again, "https://attacker.example")).toThrow(/expected provider/);
      expect(state).not.toBe(again);
    });

    it("is dropped when it has no issuer and the server said it would send one", async () => {
      const { session, w } = setup();
      w.asMetadata = { ...w.asMetadata, authorization_response_iss_parameter_supported: true };
      const state = (await startedAt(session)).searchParams.get("state")!;
      expect(() => session.declineSignIn(state)).toThrow(/expected provider/);
    });
  });
});

describe("renewing after the server turned an access token down", () => {
  it("gets a new access token with the refresh token, and keeps the refresh token", async () => {
    const { session, w, store } = await signedIn();
    expect(await session.renew("access-1")).toBe(true);
    expect(session.accessToken()).toBe("access-2");
    expect(Object.fromEntries(tokenRequests(w)[1]!.body)).toMatchObject({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "client-123", resource: MCP });
    expect(store.values.get(refreshKey)).toBe("refresh-1");
  });

  it("runs one renewal for the calls that arrive while it is under way", async () => {
    const { session, w } = await signedIn();
    const results = await Promise.all([session.renew("access-1"), session.renew("access-1"), session.renew("access-1")]);
    expect(results).toEqual([true, true, true]);
    expect(tokenRequests(w)).toHaveLength(2);
  });

  it("does not renew again for a token that has already been replaced", async () => {
    const { session, w } = await signedIn();
    await session.renew("access-1");
    expect(await session.renew("access-1")).toBe(true);
    expect(tokenRequests(w)).toHaveLength(2);
  });

  it("signs the person out when the refresh token is turned down, so a new sign-in is asked for", async () => {
    const { session, w, store } = await signedIn();
    w.tokenAnswer = () => reply({ error: "invalid_grant" }, 400);
    expect(await session.renew("access-1")).toBe(false);
    expect(session.hasSession()).toBe(false);
    expect(store.values.has(refreshKey)).toBe(false);
  });

  it("signs the person out when there is no refresh token to renew with", async () => {
    const made = setup();
    made.w.tokenAnswer = () => reply({ access_token: "a", token_type: "Bearer" });
    const authorize = await startedAt(made.session);
    await made.session.completeSignIn("good-code", authorize.searchParams.get("state")!);
    expect(await made.session.renew("a")).toBe(false);
    expect(made.session.hasSession()).toBe(false);
  });

  it("is false when nobody is signed in", async () => {
    expect(await setup().session.renew("anything")).toBe(false);
  });

  it("keeps a rotated refresh token", async () => {
    const { session, w, store } = await signedIn();
    w.tokenAnswer = () => reply({ access_token: "rotated", token_type: "Bearer", refresh_token: "refresh-2" });
    await session.renew("access-1");
    expect(store.values.get(refreshKey)).toBe("refresh-2");
  });

  it("does not sign back in when the sign-out comes while the renewal is under way", async () => {
    const { session, w, store } = await signedIn();
    let release = () => {};
    w.holdToken = new Promise<void>((resolve) => (release = resolve));
    const renewing = session.renew("access-1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.signOut();
    release();
    expect(await renewing).toBe(false);
    expect(session.hasSession()).toBe(false);
    expect(store.values.has(refreshKey)).toBe(false);
  });
});

describe("signing out", () => {
  it("clears the session and the saved refresh token", async () => {
    const { session, store } = await signedIn();
    session.signOut();
    expect(session.hasSession()).toBe(false);
    expect(session.accessToken()).toBeNull();
    expect(store.values.has(refreshKey)).toBe(false);
  });

  it("refuses the answer to a sign-in that was started before the sign-out", async () => {
    const { session } = setup();
    const state = (await startedAt(session)).searchParams.get("state")!;
    session.signOut();
    await expect(session.completeSignIn("good-code", state)).rejects.toThrow(/No OAuth2 sign-in is waiting/);
  });

  it("does not sign back in when the token exchange finishes after the sign-out", async () => {
    const { session, w, store } = setup();
    const state = (await startedAt(session)).searchParams.get("state")!;
    let release = () => {};
    w.holdToken = new Promise<void>((resolve) => (release = resolve));
    const completing = session.completeSignIn("good-code", state);
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.signOut();
    release();
    await expect(completing).rejects.toThrow(/signed out/);
    expect(session.hasSession()).toBe(false);
    expect(store.values.has(refreshKey)).toBe(false);
  });
});

describe("discoverSignIn", () => {
  const find = (w: World) => discoverSignIn(MCP, { fetchFn: w.fetchFn, redirectUri: config.redirectUri });

  it("finds the checked authorization server and the scopes the server lists", async () => {
    const w = world();
    expect(await find(w)).toEqual({ metadata: w.asMetadata, scopes: ["from-server"] });
  });

  it("prefers the scopes the 401 asked for", async () => {
    const w = world();
    w.server = () => new Response("", { status: 401, headers: { "www-authenticate": 'Bearer scope="files:read files:write"' } });
    expect((await find(w))?.scopes).toEqual(["files:read", "files:write"]);
  });

  it("finds no scopes when neither the 401 nor the server names any", async () => {
    const w = world();
    w.resource = { resource: MCP, authorization_servers: [AS] };
    expect((await find(w))?.scopes).toBeUndefined();
  });

  it("finds nothing to sign in to when the server answers without a 401", async () => {
    const w = world();
    w.server = () => new Response("{}", { status: 200 });
    expect(await find(w)).toBeNull();
    expect(w.requests.map((r) => r.url)).toEqual([MCP]);
  });

  it("registers no client and asks for no tokens, whatever it finds", async () => {
    const w = world();
    await find(w);
    expect(w.requests.some((r) => r.url === `${AS}/register` || r.url === `${AS}/token`)).toBe(false);
  });

  it.each([
    ["a server that publishes no sign-in metadata", (w: World) => (w.resource = null), /publishes no sign-in metadata/],
    ["sign-in metadata that names another server", (w: World) => (w.resource = { ...w.resource, resource: "https://other.example.com/mcp" }), /does not name this server/],
    ["an authorization server whose metadata fails the checks", (w: World) => (w.asMetadata = { ...w.asMetadata, issuer: "https://attacker.example" }), /publishes no metadata that passes the checks/],
  ])("refuses %s", async (_label, change, message) => {
    const w = world();
    change(w);
    await expect(find(w)).rejects.toThrow(message);
  });
});
