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

import { describe, expect, it, vi } from "vitest";
import { authorizationCodeProviderKey, authorizationCodeRefreshKey } from "./authorization-code";
import type { SignInServer } from "./discovery";
import { createAuthorizationCodeSession, type KeyValueStore } from "./session";
import { config, fakeFetch } from "./test-support";

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

function fakeStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
}

describe("createAuthorizationCodeSession", () => {
  it("matches the key createAuthorizationCodeSession actually persists the refresh token under", async () => {
    const store = fakeStore();
    const fetchFn = (async () =>
      new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch;
    const session = createAuthorizationCodeSession(config, store);
    await session.startSignIn(server, redirectTo.capture);
    await session.completeSignIn("abc", redirectTo.state(), { fetchFn });

    expect(store.get(authorizationCodeRefreshKey(config))).toBe("rt");
  });

  const refreshKey = `afm.oauth.${authorizationCodeProviderKey(config)}.refresh`;
  const tokensFor = (accessToken: string, refreshToken = "rt", expiresIn = 3600) => ({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
  });

  async function signedIn(expiresIn: number, store = fakeStore()) {
    const session = createAuthorizationCodeSession(config, store);
    await session.startSignIn(server, redirectTo.capture);
    await session.completeSignIn("abc", redirectTo.state(), { fetchFn: fakeFetch(tokensFor("old", "rt", expiresIn)).fn });
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
    await session.completeSignIn("abc", redirectTo.state(), { fetchFn: exchange.fn });
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
    await session.completeSignIn("abc", redirectTo.state(), { fetchFn: fakeFetch(tokensFor("at")).fn });
    expect(store.get(authorizationCodeRefreshKey(forTeam))).toBe("rt");
  });

  it("exchanges the code, and later refreshes, at the server it was given with that server's client", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    await session.startSignIn({ ...server, tokenUrl: "https://elsewhere.example/token", clientId: "other-client" }, redirectTo.capture);
    const exchange = fakeFetch(tokensFor("old", "rt", 1));
    await session.completeSignIn("abc", redirectTo.state(), { fetchFn: exchange.fn });
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

    await session.completeSignIn("abc", redirectTo.state(), { fetchFn });
    expect(session.hasSession()).toBe(true);
    expect(await session.getAccessToken()).toBe("at");
  });

  it("keeps a sign-in whose refresh token could not be saved, instead of reporting it as failed", async () => {
    const store: KeyValueStore = {
      ...fakeStore(),
      set: async () => {
        throw new Error("storage refused");
      },
    };
    const session = createAuthorizationCodeSession(config, store);
    await session.startSignIn(server, redirectTo.capture);
    await session.completeSignIn("abc", redirectTo.state(), { fetchFn: fakeFetch(tokensFor("at")).fn });
    expect(session.hasSession()).toBe(true);
    expect(await session.getAccessToken()).toBe("at");
  });

  it("does not leave a refresh token behind when a sign-out comes while the save fails", async () => {
    const inner = fakeStore();
    const store: KeyValueStore = {
      ...inner,
      set: async (key, value) => {
        session.signOut();
        inner.set(key, value);
        throw new Error("storage refused after writing");
      },
    };
    const session = createAuthorizationCodeSession(config, store);
    await session.startSignIn(server, redirectTo.capture);
    await session.completeSignIn("abc", redirectTo.state(), { fetchFn: fakeFetch(tokensFor("at")).fn });
    expect(session.hasSession()).toBe(false);
    expect(inner.get(authorizationCodeRefreshKey(config))).toBeNull();
  });

  it("removes any previously stored refresh token before persisting a freshly signed-in one", async () => {
    const calls: string[] = [];
    const tracked = {
      get: (k: string) => fakeStore().get(k),
      set: (_k: string, v: string) => void calls.push(`set:${v}`),
      remove: (_k: string) => void calls.push("remove"),
    };
    const session = createAuthorizationCodeSession(config, tracked);
    await session.startSignIn(server, redirectTo.capture);
    await session.completeSignIn("abc", redirectTo.state(), { fetchFn: fakeFetch(tokensFor("at")).fn });
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
      await session.completeSignIn("abc", state, { fetchFn: fn, iss: server.issuer });
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
      await expect(session.completeSignIn("abc", state, { fetchFn: fn, iss })).rejects.toThrow(/expected provider/);
      expect(calls).toHaveLength(0);
      expect(session.hasSession()).toBe(false);
    });

    it("still checks an issuer the server did not say it sends", async () => {
      const { session, state, fn, calls } = await started(false);
      await expect(session.completeSignIn("abc", state, { fetchFn: fn, iss: "https://other.example.com" })).rejects.toThrow(/expected provider/);
      expect(calls).toHaveLength(0);
    });

    it("refuses an answer with no issuer when the server said it sends one, without exchanging the code", async () => {
      const { session, state, fn, calls } = await started(true);
      await expect(session.completeSignIn("abc", state, { fetchFn: fn })).rejects.toThrow(/expected provider/);
      expect(calls).toHaveLength(0);
    });

    it("lets an answer with no issuer through when the server does not send one", async () => {
      const { session, state, fn } = await started(false);
      await session.completeSignIn("abc", state, { fetchFn: fn });
      expect(session.hasSession()).toBe(true);
    });

    it("asks no server about the issuer", async () => {
      const { session, state, fn, calls } = await started(true);
      await session.completeSignIn("abc", state, { fetchFn: fn, iss: server.issuer });
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
      await expect(session.completeSignIn("abc", state, { fetchFn: fakeFetch(tokensFor("at")).fn })).rejects.toThrow(/No OAuth2 sign-in is waiting/);
    });
  });

  it("throws on a state mismatch (CSRF), and the sign-in cannot be retried with the right state", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    await session.startSignIn(server, redirectTo.capture);
    const state = redirectTo.state();
    const { fn, calls } = fakeFetch({ access_token: "at", expires_in: 3600 });

    await expect(session.completeSignIn("abc", "WRONG", { fetchFn: fn })).rejects.toThrow(/state mismatch/i);
    await expect(session.completeSignIn("abc", state, { fetchFn: fn })).rejects.toThrow(/No OAuth2 sign-in is waiting/);
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

    it("signs the person out when the provider turns the refresh token down, so a new sign-in is asked for", async () => {
      const { session, store } = await signedIn(1);
      expect(await session.getAccessToken(fakeFetch({ error: "invalid_grant" }, false).fn)).toBeNull();
      expect(session.hasSession()).toBe(false);
      expect(store.get(refreshKey)).toBeNull();
      expect(await session.getAccessToken(fakeFetch(tokensFor("unused")).fn)).toBeNull();
    });

    it("keeps the sign-in when the refresh fails for another reason, such as a busy server", async () => {
      const { session, store } = await signedIn(1);
      const busy = (async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: "temporarily_unavailable" }),
      })) as unknown as typeof fetch;
      await expect(session.getAccessToken(busy)).rejects.toThrow(/refresh failed: 503/);
      expect(session.hasSession()).toBe(true);
      expect(store.get(refreshKey)).toBe("rt");
      expect(await session.getAccessToken(fakeFetch(tokensFor("fresh")).fn)).toBe("fresh");
    });

    it("does not let a refresh the provider turned down sign out a newer sign-in", async () => {
      const { session, store } = await signedIn(1);
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slowRejection = (async () => {
        await gate;
        return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) };
      }) as unknown as typeof fetch;
      const call = session.getAccessToken(slowRejection);
      session.signOut();
      await session.startSignIn(server, redirectTo.capture);
      await session.completeSignIn("abc", redirectTo.state(), { fetchFn: fakeFetch(tokensFor("newer", "newer-rt")).fn });
      release();
      await call;
      expect(await session.getAccessToken()).toBe("newer");
      expect(store.get(refreshKey)).toBe("newer-rt");
    });

    it("keeps serving the new token when the rotated refresh token could not be saved", async () => {
      const inner = fakeStore();
      let refuse = false;
      const store: KeyValueStore = {
        ...inner,
        set: async (key, value) => {
          if (refuse) throw new Error("storage refused");
          inner.set(key, value);
        },
      };
      const { session } = await signedIn(1, store);
      refuse = true;
      expect(await session.getAccessToken(fakeFetch(tokensFor("fresh", "rt2")).fn)).toBe("fresh");
      expect(await session.getAccessToken()).toBe("fresh");
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
      await session.completeSignIn("abc", redirectTo.state(), { fetchFn: fakeFetch(tokensFor("newer", "newer-rt")).fn });
      refresh.release();
      await call;
      expect(await session.getAccessToken()).toBe("newer");
      expect(store.get(refreshKey)).toBe("newer-rt");
    });
  });

  it("does not make a new sign-in wait for a refresh that belongs to the previous one", async () => {
    const { session } = await signedIn(1);
    const stale = pausedFetch(tokensFor("stale", "stale-rt"));
    const staleCall = session.getAccessToken(stale.fn);
    session.signOut();
    await session.startSignIn(server, redirectTo.capture);
    await session.completeSignIn("abc", redirectTo.state(), { fetchFn: fakeFetch(tokensFor("second", "rt2", 1)).fn });
    const fresh = fakeFetch(tokensFor("fresh", "rt3"));
    expect(await session.getAccessToken(fresh.fn)).toBe("fresh");
    expect(fresh.calls).toHaveLength(1);
    stale.release();
    expect(await staleCall).toBe("fresh");
  });

  it("does not let an older sign-in that finishes last replace a newer one", async () => {
    const store = fakeStore();
    const session = createAuthorizationCodeSession(config, store);
    await session.startSignIn(server, redirectTo.capture);
    const older = pausedFetch(tokensFor("old", "old-rt"));
    const olderSignIn = session.completeSignIn("abc", redirectTo.state(), { fetchFn: older.fn });
    await session.startSignIn(server, redirectTo.capture);
    await session.completeSignIn("abc", redirectTo.state(), { fetchFn: fakeFetch(tokensFor("newer", "newer-rt")).fn });
    older.release();
    await expect(olderSignIn).rejects.toThrow(/newer sign-in/);
    expect(await session.getAccessToken()).toBe("newer");
    expect(store.get(refreshKey)).toBe("newer-rt");
  });

  it("signOut clears the session and the persisted refresh token", async () => {
    const { session, store } = await signedIn(3600);

    session.signOut();
    expect(session.hasSession()).toBe(false);
    expect(await session.getAccessToken()).toBeNull();
    expect(store.get(refreshKey)).toBeNull();
  });
});

describe("insecure endpoints in an untrusted agent file", () => {
  it("does not redirect the browser when the authorization endpoint is not https", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    let redirected: string | null = null;
    await expect(
      session.startSignIn({ ...server, authorizeUrl: "http://auth.example.com/oauth2/authorize" }, (u) => void (redirected = u)),
    ).rejects.toThrow(/must use https/);
    expect(redirected).toBeNull();
  });

  it("still lets an ordinary https provider through, redirect and exchange both", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    await session.startSignIn(server, redirectTo.capture);
    expect(redirectTo.url.startsWith("https://auth.example.com/oauth2/authorize?")).toBe(true);

    const { fn, calls } = fakeFetch({ access_token: "at", expires_in: 3600 });
    await session.completeSignIn("abc", redirectTo.state(), { fetchFn: fn });
    expect(calls).toHaveLength(1);
  });
});

describe("the scope a sign-in asks for", () => {
  const asked = async (configured: string[] | undefined, discovered: string[] | undefined) => {
    const session = createAuthorizationCodeSession({ ...config, scopes: configured }, fakeStore());
    await session.startSignIn({ ...server, scopes: discovered }, redirectTo.capture);
    return new URL(redirectTo.url).searchParams.get("scope");
  };

  it("is the scope the server asked for, when the agent file sets none", async () => {
    expect(await asked(undefined, ["files:read", "files:write"])).toBe("files:read files:write");
    expect(await asked([], ["files:read"])).toBe("files:read");
  });

  it("is the agent file's own scope when it sets one, whatever the server asked for", async () => {
    expect(await asked(["read"], ["files:read"])).toBe("read");
  });

  it("is no scope when neither the file nor the server names one", async () => {
    expect(await asked(undefined, undefined)).toBeNull();
  });
});

describe("signing out while a sign-in is under way", () => {
  const tokens = { access_token: "at", refresh_token: "rt", expires_in: 3600 };

  it("refuses the answer to a sign-in that was started before the sign-out", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    await session.startSignIn(server, redirectTo.capture);
    const state = redirectTo.state();
    session.signOut();
    await expect(session.completeSignIn("abc", state, { fetchFn: fakeFetch(tokens).fn })).rejects.toThrow(/No OAuth2 sign-in is waiting/);
    expect(session.hasSession()).toBe(false);
  });

  it("does not sign back in when the token exchange finishes after the sign-out", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowFetch = (async () => {
      await gate;
      return { ok: true, status: 200, json: async () => tokens } as Response;
    }) as unknown as typeof fetch;
    const store = fakeStore();
    const session = createAuthorizationCodeSession(config, store);
    await session.startSignIn(server, redirectTo.capture);
    const completing = session.completeSignIn("abc", redirectTo.state(), { fetchFn: slowFetch });
    session.signOut();
    release();
    await expect(completing).rejects.toThrow(/signed out/);
    expect(session.hasSession()).toBe(false);
    expect(store.get(authorizationCodeRefreshKey(config))).toBeNull();
  });

  it("does not leave a refresh token behind when a slow write lands after the sign-out", async () => {
    const data = new Map<string, string>();
    let writeStarted = () => {};
    const started = new Promise<void>((resolve) => (writeStarted = resolve));
    let finishWrite = () => {};
    const finished = new Promise<void>((resolve) => (finishWrite = resolve));
    const store: KeyValueStore = {
      get: (key) => data.get(key) ?? null,
      set: async (key, value) => {
        writeStarted();
        await finished;
        data.set(key, value);
      },
      remove: (key) => void data.delete(key),
    };
    const session = createAuthorizationCodeSession(config, store);
    await session.startSignIn(server, redirectTo.capture);
    const completing = session.completeSignIn("abc", redirectTo.state(), { fetchFn: fakeFetch(tokens).fn });
    await started;
    session.signOut();
    finishWrite();
    await completing;
    expect(session.hasSession()).toBe(false);
    expect(store.get(authorizationCodeRefreshKey(config))).toBeNull();
  });

  it("does not start a sign-in when the person signs out while its challenge is being made", async () => {
    const session = createAuthorizationCodeSession(config, fakeStore());
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args: Parameters<SubtleCrypto["digest"]>) => {
      session.signOut();
      return digest(...args);
    });
    let redirected = false;
    try {
      await expect(session.startSignIn(server, () => void (redirected = true))).rejects.toThrow(/signed out/);
    } finally {
      spy.mockRestore();
    }
    expect(redirected).toBe(false);
  });
});
