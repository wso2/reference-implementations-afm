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
import { generatePkce, randomString, buildAuthorizeUrl, exchangeCodeForTokens, refreshAuthorizationCodeTokens, isExpired, authorizationCodeProviderKey, authorizationCodeRefreshKey, createAuthorizationCodeSession, discoverSignInServer, isInteractiveOAuth, oauthProviderFrom, createOAuth2MachineClient, requireHttpsUrl } from "./oauth";
import type { AuthorizationCodeConfig, AuthorizationCodeTokens, KeyValueStore, OAuth2MachineConfig, OAuthProviderRef, SignInServer } from "./oauth";

const config: AuthorizationCodeConfig = {
  authorizeUrl: "https://auth.example.com/oauth2/authorize",
  tokenUrl: "https://auth.example.com/oauth2/token",
  clientId: "client-123",
  redirectUri: "http://localhost:5173/run",
  scopes: ["read", "write"],
};

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const urlSafe = /^[A-Za-z0-9_-]+$/;

describe("PKCE primitives", () => {
  it("verifier and challenge are URL-safe, and challenge = S256(verifier)", async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier).toMatch(urlSafe);
    expect(challenge).toMatch(urlSafe);
    expect(challenge).toBe(await s256(verifier));
  });

  it("generates a different verifier each time", async () => {
    expect((await generatePkce()).verifier).not.toBe((await generatePkce()).verifier);
    expect(randomString()).not.toBe(randomString());
  });
});

describe("buildAuthorizeUrl", () => {
  it("sets the OAuth + PKCE query params, with no client_secret anywhere", () => {
    const url = new URL(buildAuthorizeUrl(config, { state: "st", codeChallenge: "ch" }));
    expect(url.origin + url.pathname).toBe("https://auth.example.com/oauth2/authorize");
    const q = url.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe("client-123");
    expect(q.get("redirect_uri")).toBe("http://localhost:5173/run");
    expect(q.get("scope")).toBe("read write");
    expect(q.get("state")).toBe("st");
    expect(q.get("code_challenge")).toBe("ch");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(url.toString()).not.toContain("secret");
  });

  it("omits the scope param when no scopes are declared", () => {
    const noScopes: AuthorizationCodeConfig = { ...config, scopes: undefined };
    const url = new URL(buildAuthorizeUrl(noScopes, { state: "s", codeChallenge: "c" }));
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("omits the resource param when there is no resource to bind to, as today", () => {
    const url = new URL(buildAuthorizeUrl(config, { state: "s", codeChallenge: "c" }));
    expect(url.searchParams.has("resource")).toBe(false);
  });

  it("includes the resource param (RFC 8707) when a resource is given", () => {
    const withResource: AuthorizationCodeConfig = { ...config, resource: "https://mcp.example.com/mcp" };
    const url = new URL(buildAuthorizeUrl(withResource, { state: "s", codeChallenge: "c" }));
    expect(url.searchParams.get("resource")).toBe("https://mcp.example.com/mcp");
  });
});

function fakeFetch(json: unknown, ok = true) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? ""), headers: { ...(init?.headers as Record<string, string>) } });
    return { ok, status: ok ? 200 : 400, json: async () => json } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const redirectTo = {
  url: "",
  capture: (url: string) => void (redirectTo.url = url),
  state: () => new URL(redirectTo.url).searchParams.get("state")!,
};

const server: SignInServer = {
  authorizeUrl: config.authorizeUrl,
  tokenUrl: config.tokenUrl,
  clientId: config.clientId,
  issuer: "https://auth.example.com",
  issuerSent: false,
  resource: "https://mcp.example.com/mcp",
};

describe("exchangeCodeForTokens", () => {
  it("POSTs the code + verifier and returns tokens", async () => {
    const { fn, calls } = fakeFetch({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    const before = Date.now();
    const tokens = await exchangeCodeForTokens(config, "the-code", "the-verifier", fn);
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(calls[0]?.url).toBe(config.tokenUrl);
    expect(calls[0]?.body).toContain("grant_type=authorization_code");
    expect(calls[0]?.body).toContain("code=the-code");
    expect(calls[0]?.body).toContain("code_verifier=the-verifier");
    expect(calls[0]?.body).not.toContain("resource=");
  });

  it("includes the resource param in the token request when the config has one", async () => {
    const { fn, calls } = fakeFetch({ access_token: "at", expires_in: 3600 });
    const withResource: AuthorizationCodeConfig = { ...config, resource: "https://mcp.example.com/mcp" };
    await exchangeCodeForTokens(withResource, "c", "v", fn);
    expect(new URLSearchParams(calls[0]?.body).get("resource")).toBe("https://mcp.example.com/mcp");
  });

  it("throws on a non-OK response", async () => {
    const { fn } = fakeFetch({}, false);
    await expect(exchangeCodeForTokens(config, "c", "v", fn)).rejects.toThrow(/token exchange failed/i);
  });

  it("sends 'accept: application/json' - required by real providers like GitHub, which otherwise reply form-encoded", async () => {
    const { fn, calls } = fakeFetch({ access_token: "at", expires_in: 3600 });
    await exchangeCodeForTokens(config, "c", "v", fn);
    expect(calls[0]?.headers.accept).toBe("application/json");
  });
});

describe("refreshAuthorizationCodeTokens", () => {
  it("uses grant_type=refresh_token and keeps the old refresh token if not rotated", async () => {
    const { fn, calls } = fakeFetch({ access_token: "at2", expires_in: 1800 });
    const tokens = await refreshAuthorizationCodeTokens(config, "old-refresh", fn);
    expect(tokens.accessToken).toBe("at2");
    expect(tokens.refreshToken).toBe("old-refresh");
    expect(calls[0]?.body).toContain("grant_type=refresh_token");
    expect(calls[0]?.body).toContain("refresh_token=old-refresh");
    expect(calls[0]?.headers.accept).toBe("application/json");
  });

  it("includes the resource param on refresh too, when the config has one", async () => {
    const { fn, calls } = fakeFetch({ access_token: "at2", expires_in: 1800 });
    const withResource: AuthorizationCodeConfig = { ...config, resource: "https://mcp.example.com/mcp" };
    await refreshAuthorizationCodeTokens(withResource, "old-refresh", fn);
    expect(new URLSearchParams(calls[0]?.body).get("resource")).toBe("https://mcp.example.com/mcp");
  });
});

describe("isExpired", () => {
  it("is true at/after expiry (with skew) and false well before", () => {
    const soon: AuthorizationCodeTokens = { accessToken: "x", expiresAt: Date.now() + 10_000 };
    const later: AuthorizationCodeTokens = { accessToken: "x", expiresAt: Date.now() + 600_000 };
    expect(isExpired(soon)).toBe(true);
    expect(isExpired(later)).toBe(false);
  });
});

describe("authorizationCodeProviderKey", () => {
  it("is stable for the same provider config", () => {
    const key = authorizationCodeProviderKey(config);
    expect(authorizationCodeProviderKey({ ...config })).toBe(key);
  });

  it("differs when any part of the provider differs", () => {
    const key = authorizationCodeProviderKey(config);
    expect(authorizationCodeProviderKey({ ...config, clientId: "other-client" })).not.toBe(key);
    expect(authorizationCodeProviderKey({ ...config, authorizeUrl: "https://other.example.com/authorize" })).not.toBe(key);
    expect(authorizationCodeProviderKey({ ...config, tokenUrl: "https://other.example.com/token" })).not.toBe(key);
    expect(authorizationCodeProviderKey({ ...config, resource: "https://mcp.example.com/mcp" })).not.toBe(key);
  });

  it("differs for two MCP servers that share an authorization server and client_id", () => {
    const serverA: AuthorizationCodeConfig = { ...config, resource: "https://mcp-a.example.com/mcp" };
    const serverB: AuthorizationCodeConfig = { ...config, resource: "https://mcp-b.example.com/mcp" };
    expect(authorizationCodeProviderKey(serverA)).not.toBe(authorizationCodeProviderKey(serverB));
  });

  it("tells apart server addresses that differ only slightly", () => {
    const resources = [
      "https://mcp.example.com/team",
      "https://mcp.example.com/team/",
      "https://mcp.example.com/team-other",
      "https://mcp.example.com:8443/team",
      "http://mcp.example.com/team",
      "https://mcp.example.com/Team",
      "",
    ];
    const keys = resources.map((resource) => authorizationCodeProviderKey({ ...config, resource }));
    expect(new Set(keys).size).toBe(resources.length);
  });

  it("does not let one field run into the next", () => {
    const first = authorizationCodeProviderKey({ ...config, clientId: "a", resource: "b" });
    const second = authorizationCodeProviderKey({ ...config, clientId: 'a","b', resource: undefined });
    expect(first).not.toBe(second);
  });

  it("survives a very long authorizeUrl without losing the client_id or the resource", () => {
    const longConfig: AuthorizationCodeConfig = { ...config, authorizeUrl: `https://auth.example.com/${"x".repeat(200)}/authorize` };
    const serverA: AuthorizationCodeConfig = { ...longConfig, resource: "https://mcp-a.example.com/mcp" };
    const serverB: AuthorizationCodeConfig = { ...longConfig, resource: "https://mcp-b.example.com/mcp" };
    expect(authorizationCodeProviderKey(serverA)).not.toBe(authorizationCodeProviderKey(serverB));
    expect(authorizationCodeProviderKey({ ...longConfig, clientId: "other-client" })).not.toBe(authorizationCodeProviderKey(longConfig));
  });
});

describe("authorizationCodeRefreshKey", () => {
  it("matches the key createAuthorizationCodeSession actually persists the refresh token under", async () => {
    const store = fakeStore();
    const fetchFn = (async () =>
      new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
    const session = createAuthorizationCodeSession(config, store);
    await session.startSignIn(server, redirectTo.capture);
    await session.completeSignIn("abc", redirectTo.state(), fetchFn);

    expect(store.get(authorizationCodeRefreshKey(config))).toBe("rt");
  });

  it("does not need redirectUri - a caller checking for a stored session does not have one", () => {
    const { authorizeUrl, tokenUrl, clientId, resource } = { ...config, resource: "https://mcp.example.com/mcp" };
    expect(authorizationCodeRefreshKey({ authorizeUrl, tokenUrl, clientId, resource })).toBe(
      `afm.oauth.${authorizationCodeProviderKey({ authorizeUrl, tokenUrl, clientId, resource })}.refresh`,
    );
  });
});

function fakeStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}

describe("createAuthorizationCodeSession", () => {
  const refreshKey = `afm.oauth.${authorizationCodeProviderKey(config)}.refresh`;
  const tokensFor = (accessToken: string, refreshToken = "rt", expiresIn = 3600) => ({ access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn });

  async function signedIn(expiresIn: number, store = fakeStore()) {
    const session = createAuthorizationCodeSession(config, store);
    await session.startSignIn(server, redirectTo.capture);
    await session.completeSignIn("abc", redirectTo.state(), fakeFetch(tokensFor("old", "rt", expiresIn)).fn);
    return { session, store };
  }

  function pausedFetch(json: unknown) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    const fn = (async (_url: string, init?: RequestInit) => {
      calls.push(String(init?.body));
      await gate;
      return { ok: true, status: 200, json: async () => json } as Response;
    }) as unknown as typeof fetch;
    return { fn, calls, release: () => release() };
  }

  it("startSignIn redirects to a PKCE authorize URL and leaves no session yet", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    await session.startSignIn(server, redirectTo.capture);

    const url = new URL(redirectTo.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).not.toBeNull();
    expect(session.hasSession()).toBe(false);
  });

  it("sends the user to the server it was given, with that server's client", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    await session.startSignIn({ ...server, authorizeUrl: "https://elsewhere.example/authorize", clientId: "other-client" }, redirectTo.capture);

    const url = new URL(redirectTo.url);
    expect(url.origin + url.pathname).toBe("https://elsewhere.example/authorize");
    expect(url.searchParams.get("client_id")).toBe("other-client");
  });

  it("asks for the resource the server named, not the address the file was configured with, in every request", async () => {
    const forTeam = { ...config, resource: "https://mcp.example.com/team/mcp" };
    const session = createAuthorizationCodeSession(forTeam, fakeStore());
    await session.startSignIn({ ...server, resource: "https://mcp.example.com" }, redirectTo.capture);
    expect(new URL(redirectTo.url).searchParams.get("resource")).toBe("https://mcp.example.com");
    const exchange = fakeFetch(tokensFor("old", "rt", 1));
    await session.completeSignIn("abc", redirectTo.state(), exchange.fn);
    const refresh = fakeFetch(tokensFor("fresh"));
    await session.getAccessToken(refresh.fn);
    for (const call of [exchange.calls[0]!, refresh.calls[0]!]) {
      expect(new URLSearchParams(call.body).get("resource")).toBe("https://mcp.example.com");
    }
  });

  it("keeps the sign-in under the server's own address, whatever resource it asked for", async () => {
    const forTeam = { ...config, resource: "https://mcp.example.com/team/mcp" };
    const store = fakeStore();
    const session = createAuthorizationCodeSession(forTeam, store);
    await session.startSignIn({ ...server, resource: "https://mcp.example.com" }, redirectTo.capture);
    await session.completeSignIn("abc", redirectTo.state(), fakeFetch(tokensFor("at")).fn);
    expect(store.get(authorizationCodeRefreshKey(forTeam))).toBe("rt");
  });

  it("exchanges the code, and later refreshes, at the server it was given with that server's client", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    await session.startSignIn({ ...server, tokenUrl: "https://elsewhere.example/token", clientId: "other-client" }, redirectTo.capture);
    const exchange = fakeFetch(tokensFor("old", "rt", 1));
    await session.completeSignIn("abc", redirectTo.state(), exchange.fn);
    const refresh = fakeFetch(tokensFor("fresh"));
    await session.getAccessToken(refresh.fn);

    for (const call of [exchange.calls[0]!, refresh.calls[0]!]) {
      expect(call.url).toBe("https://elsewhere.example/token");
      expect(new URLSearchParams(call.body).get("client_id")).toBe("other-client");
    }
  });

  it("exchanges the code for tokens when the state matches", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    await session.startSignIn(server, redirectTo.capture);
    const fetchFn = fakeFetch(tokensFor("at")).fn;

    await session.completeSignIn("abc", redirectTo.state(), fetchFn);
    expect(session.hasSession()).toBe(true);
    expect(await session.getAccessToken()).toBe("at");
  });

  it("removes any previously stored refresh token before persisting a freshly signed-in one", async () => {
    const calls: string[] = [];
    const tracked = {
      get: (k: string) => fakeStore().get(k),
      set: (k: string, v: string) => void calls.push(`set:${v}`),
      remove: (_k: string) => void calls.push("remove"),
    };
    const session = createAuthorizationCodeSession(config, tracked);
    await session.startSignIn(server, redirectTo.capture);
    await session.completeSignIn("abc", redirectTo.state(), fakeFetch(tokensFor("at")).fn);
    expect(calls).toEqual(["remove", "set:rt"]);
  });

  it("refuses a code when no sign-in is waiting for it", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    await expect(session.completeSignIn("abc", "someone-elses-state")).rejects.toThrow(/No OAuth2 sign-in is waiting/);
    expect(session.hasSession()).toBe(false);
  });

  describe("the issuer the answer names", () => {
    async function started(issuerSent: boolean) {
      const session = createAuthorizationCodeSession(config, fakeStore());
      await session.startSignIn({ ...server, issuerSent }, redirectTo.capture);
      const { fn, calls } = fakeFetch(tokensFor("at"));
      return { session, state: redirectTo.state(), fn, calls };
    }

    it("lets the sign-in finish when it is the one the sign-in started with", async () => {
      const { session, state, fn } = await started(true);
      await session.completeSignIn("abc", state, fn, server.issuer);
      expect(session.hasSession()).toBe(true);
    });

    it.each([
      ["another server", "https://other.example.com"],
      ["the same server with a trailing slash", "https://auth.example.com/"],
      ["the same server in capitals", "HTTPS://AUTH.EXAMPLE.COM"],
      ["the same server with its default port", "https://auth.example.com:443"],
      ["something that is not a URL", "not a url"],
    ])("refuses %s, without exchanging the code", async (_label, iss) => {
      const { session, state, fn, calls } = await started(true);
      await expect(session.completeSignIn("abc", state, fn, iss)).rejects.toThrow(/expected provider/);
      expect(calls).toHaveLength(0);
      expect(session.hasSession()).toBe(false);
    });

    it("still checks an issuer the server did not say it sends", async () => {
      const { session, state, fn, calls } = await started(false);
      await expect(session.completeSignIn("abc", state, fn, "https://other.example.com")).rejects.toThrow(/expected provider/);
      expect(calls).toHaveLength(0);
    });

    it("refuses an answer with no issuer when the server said it sends one, without exchanging the code", async () => {
      const { session, state, fn, calls } = await started(true);
      await expect(session.completeSignIn("abc", state, fn)).rejects.toThrow(/expected provider/);
      expect(calls).toHaveLength(0);
    });

    it("lets an answer with no issuer through when the server does not send one", async () => {
      const { session, state, fn } = await started(false);
      await session.completeSignIn("abc", state, fn);
      expect(session.hasSession()).toBe(true);
    });

    it("asks no server about the issuer", async () => {
      const { session, state, fn, calls } = await started(true);
      await session.completeSignIn("abc", state, fn, server.issuer);
      expect(calls.map((call) => call.url)).toEqual([config.tokenUrl]);
    });
  });

  describe("a refusal from the provider", () => {
    async function started(issuerSent: boolean) {
      const session = createAuthorizationCodeSession(config, fakeStore());
      await session.startSignIn({ ...server, issuerSent }, redirectTo.capture);
      return { session, state: redirectTo.state() };
    }

    it("is let through when it names the issuer the sign-in started with", async () => {
      const { session, state } = await started(true);
      expect(() => session.declineSignIn(state, server.issuer)).not.toThrow();
    });

    it.each([
      ["names another server", "https://other.example.com", true],
      ["names the same server with a trailing slash", "https://auth.example.com/", true],
      ["names another server although the server does not say it sends one", "https://other.example.com", false],
      ["names no server although the server said it sends one", undefined, true],
    ])("is dropped when it %s", async (_label, iss, issuerSent) => {
      const { session, state } = await started(issuerSent);
      expect(() => session.declineSignIn(state, iss)).toThrow(/expected provider/);
    });

    it("is let through when it names no server and the server does not say it sends one", async () => {
      const { session, state } = await started(false);
      expect(() => session.declineSignIn(state)).not.toThrow();
    });

    it("is dropped when it carries the wrong state", async () => {
      const { session } = await started(false);
      expect(() => session.declineSignIn("WRONG")).toThrow(/state mismatch/i);
    });

    it("ends the sign-in, so a later answer for it is refused", async () => {
      const { session, state } = await started(false);
      session.declineSignIn(state);
      await expect(session.completeSignIn("abc", state, fakeFetch(tokensFor("at")).fn)).rejects.toThrow(/No OAuth2 sign-in is waiting/);
    });
  });

  it("throws on a state mismatch (CSRF), and the sign-in cannot be retried with the right state", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    await session.startSignIn(server, redirectTo.capture);
    const state = redirectTo.state();
    const { fn, calls } = fakeFetch({ access_token: "at", expires_in: 3600 });

    await expect(session.completeSignIn("abc", "WRONG", fn)).rejects.toThrow(/state mismatch/i);
    await expect(session.completeSignIn("abc", state, fn)).rejects.toThrow(/No OAuth2 sign-in is waiting/);
    expect(calls).toHaveLength(0);
  });

  it("getAccessToken refreshes an expired token automatically, and persists the rotated refresh token", async () => {
    const { session, store } = await signedIn(1);
    expect(await session.getAccessToken(fakeFetch(tokensFor("fresh-token", "rotated-rt")).fn)).toBe("fresh-token");
    expect(store.get(refreshKey)).toBe("rotated-rt");
  });

  describe("refreshing", () => {
    it("runs one refresh for the calls that arrive while it is under way, and serves them all the new token", async () => {
      const { session } = await signedIn(1);
      const refresh = pausedFetch(tokensFor("fresh"));
      const calls = [session.getAccessToken(refresh.fn), session.getAccessToken(refresh.fn), session.getAccessToken(refresh.fn)];
      refresh.release();
      expect(await Promise.all(calls)).toEqual(["fresh", "fresh", "fresh"]);
      expect(refresh.calls).toHaveLength(1);
    });

    it("refreshes again when the new token has expired as well", async () => {
      const { session } = await signedIn(1);
      const first = fakeFetch(tokensFor("second", "rt2", 1));
      await session.getAccessToken(first.fn);
      const second = fakeFetch(tokensFor("third", "rt3"));
      expect(await session.getAccessToken(second.fn)).toBe("third");
      expect(new URLSearchParams(second.calls[0]!.body).get("refresh_token")).toBe("rt2");
    });

    it("lets the next call try again after a refresh failed", async () => {
      const { session } = await signedIn(1);
      await expect(session.getAccessToken(fakeFetch({}, false).fn)).rejects.toThrow(/refresh failed/);
      expect(await session.getAccessToken(fakeFetch(tokensFor("fresh")).fn)).toBe("fresh");
    });

    it("drops a refresh that finishes after sign-out, so the user stays signed out", async () => {
      const { session, store } = await signedIn(1);
      const refresh = pausedFetch(tokensFor("fresh", "rt2"));
      const call = session.getAccessToken(refresh.fn);
      session.signOut();
      refresh.release();
      expect(await call).toBeNull();
      expect(session.hasSession()).toBe(false);
      expect(store.get(refreshKey)).toBeNull();
    });

    it("drops a refresh that finishes after a newer sign-in, which keeps its own tokens", async () => {
      const { session, store } = await signedIn(1);
      const refresh = pausedFetch(tokensFor("stale", "stale-rt"));
      const call = session.getAccessToken(refresh.fn);
      session.signOut();
      await session.startSignIn(server, redirectTo.capture);
      await session.completeSignIn("abc", redirectTo.state(), fakeFetch(tokensFor("newer", "newer-rt")).fn);
      refresh.release();
      await call;
      expect(await session.getAccessToken()).toBe("newer");
      expect(store.get(refreshKey)).toBe("newer-rt");
    });
  });

  it("signOut clears the session and the persisted refresh token", async () => {
    const { session, store } = await signedIn(3600);

    session.signOut();
    expect(session.hasSession()).toBe(false);
    expect(await session.getAccessToken()).toBeNull();
    expect(store.get(refreshKey)).toBeNull();
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
    const found = await discover(serverFetch().fn, { ...provider, authorizeUrl: "https://attacker.example/authorize", tokenUrl: "https://attacker.example/token" });
    expect(found).toMatchObject({ authorizeUrl: config.authorizeUrl, tokenUrl: config.tokenUrl, issuer: "https://auth.example.com" });
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
    const bare = (async (input: string, init?: RequestInit) => (String(input) === "https://mcp.example.com/prm" ? new Response("", { status: 404 }) : fn(input, init))) as unknown as typeof fetch;
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

describe("isInteractiveOAuth", () => {
  it("is true only for oauth2 with the authorization_code grant, whatever the casing", () => {
    expect(isInteractiveOAuth({ type: "oauth2", grant_type: "authorization_code" })).toBe(true);
    expect(isInteractiveOAuth({ type: "OAuth2", grant_type: "Authorization_Code" })).toBe(true);
    expect(isInteractiveOAuth({ type: "oauth2", grant_type: "client_credentials" })).toBe(false);
    expect(isInteractiveOAuth({ type: "bearer" })).toBe(false);
    expect(isInteractiveOAuth({ type: 5, grant_type: 6 })).toBe(false);
    expect(isInteractiveOAuth(undefined)).toBe(false);
  });
});

describe("oauthProviderFrom", () => {
  it("maps an authentication block to a provider, with empty strings for anything missing", () => {
    expect(
      oauthProviderFrom({ authorize_url: "https://a/authorize", token_url: "https://a/token", client_id: "c", scopes: ["mcp"] }, "https://mcp.example.com/mcp"),
    ).toEqual({
      authorizeUrl: "https://a/authorize",
      tokenUrl: "https://a/token",
      clientId: "c",
      scopes: ["mcp"],
      resource: "https://mcp.example.com/mcp",
    });
    expect(oauthProviderFrom({})).toEqual({ authorizeUrl: "", tokenUrl: "", clientId: "", scopes: undefined, resource: undefined });
  });
});

describe("insecure endpoints in an untrusted agent file", () => {
  const insecure = ["http://auth.example.com/oauth2/authorize", "javascript:alert(1)", "data:text/html,x"];

  it("refuses to build an authorize URL for a non-https endpoint", () => {
    for (const authorizeUrl of insecure) {
      expect(() => buildAuthorizeUrl({ ...config, authorizeUrl }, { state: "s", codeChallenge: "c" })).toThrow(
        /authorize_url/,
      );
    }
  });

  it("does not redirect the browser when the authorization endpoint is not https", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    let redirected: string | null = null;
    await expect(
      session.startSignIn({ ...server, authorizeUrl: "http://auth.example.com/oauth2/authorize" }, (u) => void (redirected = u)),
    ).rejects.toThrow(/must use https/);
    expect(redirected).toBeNull();
  });

  it("does not POST the code or verifier when token_url is not https", async () => {
    for (const tokenUrl of ["http://auth.example.com/oauth2/token", "javascript:alert(1)"]) {
      const { fn, calls } = fakeFetch({ access_token: "at" });
      await expect(exchangeCodeForTokens({ ...config, tokenUrl }, "the-code", "the-verifier", fn)).rejects.toThrow(
        /token_url/,
      );
      expect(calls).toHaveLength(0);
    }
  });

  it("does not POST the refresh token when token_url is not https", async () => {
    const { fn, calls } = fakeFetch({ access_token: "at" });
    await expect(
      refreshAuthorizationCodeTokens({ ...config, tokenUrl: "http://auth.example.com/oauth2/token" }, "rt", fn),
    ).rejects.toThrow(/token_url/);
    expect(calls).toHaveLength(0);
  });

  it("still lets an ordinary https provider through, redirect and exchange both", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    await session.startSignIn(server, redirectTo.capture);
    expect(redirectTo.url.startsWith("https://auth.example.com/oauth2/authorize?")).toBe(true);

    const { fn, calls } = fakeFetch({ access_token: "at", expires_in: 3600 });
    await session.completeSignIn("abc", redirectTo.state(), fn);
    expect(calls).toHaveLength(1);
  });
});

function scriptedFetch(responses: Array<{ status?: number; body?: unknown }>): typeof fetch {
  let call = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const entry = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return {
      ok: (entry.status ?? 200) < 400,
      status: entry.status ?? 200,
      json: async () => entry.body,
    } as Response;
  }) as unknown as typeof fetch;
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn;
}

describe("createOAuth2MachineClient", () => {
  it("client_credentials sends client_id/secret as HTTP Basic by default", async () => {
    const config: OAuth2MachineConfig = {
      grantType: "client_credentials",
      tokenUrl: "https://auth.example.com/token",
      clientId: "id",
      clientSecret: "secret",
      scopes: ["read", "write"],
    };
    const fetchFn = scriptedFetch([{ body: { access_token: "tok-1", expires_in: 3600 } }]);
    const client = createOAuth2MachineClient(config);
    const token = await client.getAccessToken(fetchFn);
    expect(token).toBe("tok-1");

    const calls = (fetchFn as unknown as { calls: Array<{ url: string; init?: RequestInit }> }).calls;
    expect(calls[0]!.url).toBe("https://auth.example.com/token");
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa("id:secret")}`);
    const body = calls[0]!.init!.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("scope")).toBe("read write");
    expect(body.get("client_id")).toBeNull();
  });

  it("post_body credential_bearer sends client_id/secret in the form body, not a header", async () => {
    const config: OAuth2MachineConfig = {
      grantType: "client_credentials",
      tokenUrl: "https://auth.example.com/token",
      clientId: "id",
      clientSecret: "secret",
      credentialBearer: "post_body",
    };
    const fetchFn = scriptedFetch([{ body: { access_token: "tok-1" } }]);
    await createOAuth2MachineClient(config).getAccessToken(fetchFn);
    const calls = (fetchFn as unknown as { calls: Array<{ init?: RequestInit }> }).calls;
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    const body = calls[0]!.init!.body as URLSearchParams;
    expect(body.get("client_id")).toBe("id");
    expect(body.get("client_secret")).toBe("secret");
  });

  it("password grant sends username/password", async () => {
    const fetchFn = scriptedFetch([{ body: { access_token: "tok-1" } }]);
    await createOAuth2MachineClient({
      grantType: "password",
      tokenUrl: "https://auth.example.com/token",
      username: "u",
      password: "p",
    }).getAccessToken(fetchFn);
    const body = ((fetchFn as unknown as { calls: Array<{ init?: RequestInit }> }).calls[0]!.init!.body) as URLSearchParams;
    expect(body.get("grant_type")).toBe("password");
    expect(body.get("username")).toBe("u");
    expect(body.get("password")).toBe("p");
  });

  it("refresh_token grant sends refresh_token", async () => {
    const fetchFn = scriptedFetch([{ body: { access_token: "tok-1" } }]);
    await createOAuth2MachineClient({
      grantType: "refresh_token",
      tokenUrl: "https://auth.example.com/token",
      refreshToken: "rt-1",
    }).getAccessToken(fetchFn);
    const body = ((fetchFn as unknown as { calls: Array<{ init?: RequestInit }> }).calls[0]!.init!.body) as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
  });

  it("jwt_bearer grant sends the RFC 7523 URN and the assertion", async () => {
    const fetchFn = scriptedFetch([{ body: { access_token: "tok-1" } }]);
    await createOAuth2MachineClient({
      grantType: "jwt_bearer",
      tokenUrl: "https://auth.example.com/token",
      assertion: "signed-jwt",
    }).getAccessToken(fetchFn);
    const body = ((fetchFn as unknown as { calls: Array<{ init?: RequestInit }> }).calls[0]!.init!.body) as URLSearchParams;
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(body.get("assertion")).toBe("signed-jwt");
  });

  it("caches the token and does not re-fetch while still valid", async () => {
    const fetchFn = scriptedFetch([{ body: { access_token: "tok-1", expires_in: 3600 } }]);
    const client = createOAuth2MachineClient({ grantType: "client_credentials", tokenUrl: "https://x/token", clientId: "i", clientSecret: "s" });
    const first = await client.getAccessToken(fetchFn);
    const second = await client.getAccessToken(fetchFn);
    expect(first).toBe("tok-1");
    expect(second).toBe("tok-1");
    expect((fetchFn as unknown as { calls: unknown[] }).calls.length).toBe(1);
  });

  it("re-fetches once the cached token is within the expiry skew", async () => {
    const fetchFn = scriptedFetch([{ body: { access_token: "tok-1", expires_in: 1 } }, { body: { access_token: "tok-2", expires_in: 3600 } }]);
    const client = createOAuth2MachineClient({ grantType: "client_credentials", tokenUrl: "https://x/token", clientId: "i", clientSecret: "s" });
    const first = await client.getAccessToken(fetchFn);
    expect(first).toBe("tok-1");
    const second = await client.getAccessToken(fetchFn);
    expect(second).toBe("tok-2");
  });

  it("throws when the token endpoint returns a non-ok status", async () => {
    const fetchFn = scriptedFetch([{ status: 401, body: { error: "invalid_client" } }]);
    const client = createOAuth2MachineClient({ grantType: "client_credentials", tokenUrl: "https://x/token", clientId: "i", clientSecret: "s" });
    await expect(client.getAccessToken(fetchFn)).rejects.toThrow(/OAuth2 token request failed: 401/);
  });

  it("throws when the response has no access_token", async () => {
    const fetchFn = scriptedFetch([{ body: {} }]);
    const client = createOAuth2MachineClient({ grantType: "client_credentials", tokenUrl: "https://x/token", clientId: "i", clientSecret: "s" });
    await expect(client.getAccessToken(fetchFn)).rejects.toThrow(/did not contain 'access_token'/);
  });

  it("never sends the client secret to a non-https token_url", async () => {
    for (const tokenUrl of ["http://auth.example.com/token", "javascript:alert(1)", "data:text/plain,x"]) {
      const fetchFn = scriptedFetch([{ body: { access_token: "tok" } }]);
      const client = createOAuth2MachineClient({ grantType: "client_credentials", tokenUrl, clientId: "i", clientSecret: "s" });
      await expect(client.getAccessToken(fetchFn)).rejects.toThrow(/token_url/);
      expect((fetchFn as unknown as { calls: unknown[] }).calls).toHaveLength(0);
    }
  });
});

describe("requireHttpsUrl", () => {
  it("accepts an https URL and returns it", () => {
    expect(requireHttpsUrl("https://gitlab.com/oauth/authorize", "authorize_url")).toBe(
      "https://gitlab.com/oauth/authorize",
    );
  });

  it("keeps the query and port an authorization server may need", () => {
    expect(requireHttpsUrl("https://id.example.com:8443/authorize?tenant=acme", "authorize_url")).toBe(
      "https://id.example.com:8443/authorize?tenant=acme",
    );
  });

  it("rejects cleartext http, naming the field", () => {
    expect(() => requireHttpsUrl("http://id.example.com/token", "token_url")).toThrow(/token_url/);
    expect(() => requireHttpsUrl("http://id.example.com/token", "token_url")).toThrow(/must use https/);
  });

  it("rejects http on loopback too", () => {
    expect(() => requireHttpsUrl("http://localhost:8080/token", "token_url")).toThrow(/must use https/);
    expect(() => requireHttpsUrl("http://127.0.0.1:8080/token", "token_url")).toThrow(/must use https/);
  });

  it("rejects schemes that are not transport at all", () => {
    for (const raw of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd"]) {
      expect(() => requireHttpsUrl(raw, "authorize_url")).toThrow(/must use https/);
    }
  });

  it("rejects something that is not a URL", () => {
    for (const raw of ["", "   ", "not a url", "/oauth/authorize"]) {
      expect(() => requireHttpsUrl(raw, "token_url")).toThrow(/not a valid URL/);
    }
  });
});
