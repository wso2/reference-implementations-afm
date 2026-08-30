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
import { createOAuthManager, type OAuthManagerDeps } from "./oauth-manager";
import { authorizationCodeRefreshKey, type KeyValueStore, type OAuthProviderRef } from "@afm/adapter-auth";
import { SignInRequiredError } from "../chat/failure";
import type { ServerMessage } from "../runtime/protocol";
import { createWorkerSecretStore } from "../secrets/worker-secret-store";

const MCP = "https://mcp.example.com/mcp";

const provider: OAuthProviderRef = {
  authorizeUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  clientId: "client-1",
  resource: MCP,
};

const published = {
  issuer: "https://auth.example.com",
  authorization_endpoint: provider.authorizeUrl,
  token_endpoint: provider.tokenUrl,
  registration_endpoint: "https://auth.example.com/register",
  code_challenge_methods_supported: ["S256"],
};

function memoryStore(): KeyValueStore {
  const entries = new Map<string, string>();
  return {
    get: (key) => entries.get(key) ?? null,
    set: (key, value) => void entries.set(key, value),
    remove: (key) => void entries.delete(key),
  };
}

const issued = { access_token: "at", refresh_token: "rt", expires_in: 3600 };
const listed = { listed: true };

function authServerFetch({
  as = published,
  servers = [MCP],
  resource = undefined as string | undefined,
  token = (_init?: RequestInit) => Response.json(issued),
  requested = [] as string[],
}: {
  as?: Record<string, unknown> | null;
  servers?: string[];
  resource?: string;
  token?: (init?: RequestInit) => Response;
  requested?: string[];
} = {}): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    const named = servers.find((server) => `${server}/prm` === url);
    if (servers.includes(url))
      return new Response("", {
        status: 401,
        headers: { "www-authenticate": `Bearer resource_metadata="${url}/prm"` },
      });
    if (named !== undefined)
      return Response.json({ resource: resource ?? named, authorization_servers: ["https://auth.example.com"] });
    if (url === "https://auth.example.com/.well-known/oauth-authorization-server" && as !== null)
      return Response.json(as);
    if (url === "https://auth.example.com/register") return Response.json({ client_id: "registered" }, { status: 201 });
    if (url === provider.tokenUrl) return token(init);
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

function makeManager(overrides: Partial<OAuthManagerDeps> = {}) {
  const emitted: {
    url?: { id: string; url: string };
    confirm?: { id: string; host: string };
    result?: { id: string; ok: boolean; error?: string };
  } = {};
  const refreshStore = overrides.refreshStore ?? memoryStore();
  const manager = createOAuthManager({
    fetchFn: authServerFetch(),
    redirectUri: "https://app.example.com/",
    refreshStore,
    emitAuthorizeUrl: (id, url) => (emitted.url = { id, url }),
    emitSignInConfirm: (id, host) => (emitted.confirm = { id, host }),
    emitSignInResult: (id, ok, error) => (emitted.result = { id, ok, error }),
    ...overrides,
  });
  return { manager, emitted, refreshStore };
}

async function signIn(
  manager: ReturnType<typeof makeManager>["manager"],
  emitted: ReturnType<typeof makeManager>["emitted"],
  id: string,
): Promise<void> {
  await manager.startSignIn(id, provider, listed);
  const state = new URL(emitted.url!.url).searchParams.get("state")!;
  await manager.completeSignIn(id, "the-code", state);
}

describe("createOAuthManager", () => {
  it("throws a sign-in error when there is no session", async () => {
    const { manager } = makeManager();
    await expect(manager.getAccessToken(provider)).rejects.toBeInstanceOf(SignInRequiredError);
  });

  it("signs in, then serves the access token", async () => {
    const { manager, emitted } = makeManager();
    await signIn(manager, emitted, "id-1");
    expect(emitted.result).toEqual({ id: "id-1", ok: true, error: undefined });
    expect(await manager.getAccessToken(provider)).toBe("at");
  });

  it("stores the refresh token in refreshStore after sign-in", async () => {
    const { manager, emitted, refreshStore } = makeManager();
    await signIn(manager, emitted, "id-2");
    expect(refreshStore.get(authorizationCodeRefreshKey(provider))).toBe("rt");
  });

  it("asks for a new sign-in when the provider turns down the refresh token during a session", async () => {
    let refused = false;
    const token = () =>
      refused
        ? Response.json({ error: "invalid_grant" }, { status: 400 })
        : Response.json({ ...issued, expires_in: 0 });
    const { manager, emitted, refreshStore } = makeManager({ fetchFn: authServerFetch({ token }) });
    await signIn(manager, emitted, "id-turned-down");
    refused = true;
    await expect(manager.getAccessToken(provider)).rejects.toBeInstanceOf(SignInRequiredError);
    expect(refreshStore.get(authorizationCodeRefreshKey(provider))).toBeNull();
  });

  it("keeps a sign-in for the server it was made for, even next to a server with a similar address", async () => {
    const team = { ...provider, resource: "https://mcp.example.com/team" };
    const other = { ...provider, resource: "https://mcp.example.com/team-other" };
    const { manager, emitted } = makeManager({
      fetchFn: authServerFetch({ servers: [team.resource, other.resource] }),
    });
    await manager.startSignIn("id-team", team, listed);
    await manager.completeSignIn("id-team", "the-code", new URL(emitted.url!.url).searchParams.get("state")!);
    expect(await manager.getAccessToken(team)).toBe("at");
    await expect(manager.getAccessToken(other)).rejects.toBeInstanceOf(SignInRequiredError);
  });

  it("reports a state mismatch as a failed sign-in rather than throwing", async () => {
    const { manager, emitted } = makeManager();
    await manager.startSignIn("id-3", provider, listed);
    await manager.completeSignIn("id-3", "the-code", "wrong-state");
    expect(emitted.result?.ok).toBe(false);
    expect(emitted.result?.error).toMatch(/state mismatch/i);
  });

  it.each([
    ["names a different server", "https://other.example.com", published],
    [
      "names no server, though the server said it sends one",
      undefined,
      { ...published, authorization_response_iss_parameter_supported: true },
    ],
  ])("reports an answer that %s as a failed sign-in, without exchanging the code", async (_label, iss, as) => {
    const requested: string[] = [];
    const { manager, emitted } = makeManager({ fetchFn: authServerFetch({ as, requested }) });
    await manager.startSignIn("id-5", provider, listed);
    const state = new URL(emitted.url!.url).searchParams.get("state")!;

    await manager.completeSignIn("id-5", "the-code", state, iss);

    expect(emitted.result).toMatchObject({ id: "id-5", ok: false });
    expect(emitted.result?.error).toMatch(/expected provider/);
    expect(requested).not.toContain(provider.tokenUrl);
  });

  it("reports a server whose sign-in details cannot be checked, rather than leaving the popup waiting", async () => {
    const { manager, emitted } = makeManager({ fetchFn: authServerFetch({ as: null }) });
    await manager.startSignIn("id-x", provider, listed);
    expect(emitted.url).toBeUndefined();
    expect(emitted.result).toMatchObject({ id: "id-x", ok: false });
    expect(emitted.result?.error).toMatch(/authorization server publishes no metadata/);
  });

  it("reports an authorization endpoint that is not https, rather than leaving the popup waiting", async () => {
    const http = { ...published, authorization_endpoint: "http://auth.example.com/authorize" };
    const { manager, emitted } = makeManager({ fetchFn: authServerFetch({ as: http }) });
    await manager.startSignIn("id-y", { ...provider, authorizeUrl: http.authorization_endpoint }, listed);
    expect(emitted.url).toBeUndefined();
    expect(emitted.result).toMatchObject({ id: "id-y", ok: false });
    expect(emitted.result?.error).toMatch(/https/);
  });

  it("signs in at the endpoints the server publishes, not at the ones an agent file names", async () => {
    const requested: string[] = [];
    const { manager, emitted } = makeManager({ fetchFn: authServerFetch({ requested }) });
    const edited = {
      ...provider,
      authorizeUrl: "https://attacker.example/authorize",
      tokenUrl: "https://attacker.example/token",
    };
    await manager.startSignIn("id-6", edited, listed);
    expect(new URL(emitted.url!.url).origin).toBe("https://auth.example.com");

    await manager.completeSignIn("id-6", "the-code", new URL(emitted.url!.url).searchParams.get("state")!);
    expect(emitted.result?.ok).toBe(true);
    expect(requested.filter((url) => url.startsWith("https://attacker.example"))).toEqual([]);
    expect(requested).toContain(provider.tokenUrl);
  });

  it("asks for the resource the server names, as written, in the sign-in page and the code exchange", async () => {
    const bodies: string[] = [];
    const token = (init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json(issued);
    };
    const { manager, emitted } = makeManager({
      fetchFn: authServerFetch({ resource: "https://mcp.example.com", token }),
    });
    await manager.startSignIn("id-r", provider, listed);
    expect(new URL(emitted.url!.url).searchParams.get("resource")).toBe("https://mcp.example.com");
    await manager.completeSignIn("id-r", "the-code", new URL(emitted.url!.url).searchParams.get("state")!);
    expect(new URLSearchParams(bodies[0]).get("resource")).toBe("https://mcp.example.com");
    expect(await manager.getAccessToken(provider)).toBe("at");
  });

  it("registers a client for an authorization server the file was not set up with, rather than reusing the file's", async () => {
    const { manager, emitted } = makeManager({ fetchFn: authServerFetch() });
    await manager.startSignIn(
      "id-7",
      {
        ...provider,
        authorizeUrl: "https://old-auth.example.com/authorize",
        tokenUrl: "https://old-auth.example.com/token",
      },
      listed,
    );
    expect(new URL(emitted.url!.url).searchParams.get("client_id")).toBe("registered");
  });

  it("uses the client id document it was given, when the authorization server accepts one", async () => {
    const cimdClientId = "https://app.example.com/oauth/client-metadata.json";
    const { manager, emitted } = makeManager({
      cimdClientId,
      fetchFn: authServerFetch({ as: { ...published, client_id_metadata_document_supported: true } }),
    });
    await manager.startSignIn("id-8", { ...provider, authorizeUrl: "https://old-auth.example.com/authorize" }, listed);
    expect(new URL(emitted.url!.url).searchParams.get("client_id")).toBe(cimdClientId);
  });

  describe("a server that cannot be vouched for", () => {
    const quiet = { ...published, authorization_response_iss_parameter_supported: false };

    async function started(vetting: { listed: boolean; confirmedHost?: string }, as: Record<string, unknown> = quiet) {
      const made = makeManager({ fetchFn: authServerFetch({ as }) });
      await made.manager.startSignIn("id-c", provider, vetting);
      return made;
    }

    it("is not signed in to until the user has seen the provider's host and said yes", async () => {
      const { emitted } = await started({ listed: false });
      expect(emitted.confirm).toEqual({ id: "id-c", host: "auth.example.com" });
      expect(emitted.url).toBeUndefined();
      expect(emitted.result).toBeUndefined();
    });

    it("is signed in to once the user has said yes to that host", async () => {
      const { emitted } = await started({ listed: false, confirmedHost: "auth.example.com" });
      expect(emitted.confirm).toBeUndefined();
      expect(new URL(emitted.url!.url).origin).toBe("https://auth.example.com");
    });

    it("asks again when the provider's host is not the one the user said yes to", async () => {
      const { emitted } = await started({ listed: false, confirmedHost: "elsewhere.example.com" });
      expect(emitted.confirm).toEqual({ id: "id-c", host: "auth.example.com" });
      expect(emitted.url).toBeUndefined();
    });

    it("is signed in to without asking when the server is in the directory", async () => {
      const { emitted } = await started({ listed: true });
      expect(emitted.confirm).toBeUndefined();
      expect(emitted.url).toBeDefined();
    });

    it("is signed in to without asking when the provider says who is answering", async () => {
      const { emitted } = await started(
        { listed: false },
        { ...published, authorization_response_iss_parameter_supported: true },
      );
      expect(emitted.confirm).toBeUndefined();
      expect(emitted.url).toBeDefined();
    });
  });

  describe("a refusal from the provider", () => {
    const sends = { ...published, authorization_response_iss_parameter_supported: true };

    async function started() {
      const made = makeManager({ fetchFn: authServerFetch({ as: sends }) });
      await made.manager.startSignIn("id-d", provider, listed);
      return { ...made, state: new URL(made.emitted.url!.url).searchParams.get("state")! };
    }

    it("is reported with the provider's reason when it names the provider the sign-in started with", async () => {
      const { manager, emitted, state } = await started();
      manager.declineSignIn("id-d", "access_denied", state, "https://auth.example.com");
      expect(emitted.result).toEqual({
        id: "id-d",
        ok: false,
        error: "The provider declined the sign-in (access_denied).",
      });
    });

    it.each([
      ["names another provider", "https://other.example.com"],
      ["names no provider although the server said it sends one", undefined],
    ])("is dropped, with none of its text shown, when it %s", async (_label, iss) => {
      const { manager, emitted, state } = await started();
      manager.declineSignIn("id-d", "access_denied", state, iss);
      expect(emitted.result).toMatchObject({ id: "id-d", ok: false });
      expect(emitted.result?.error).toMatch(/expected provider/);
      expect(emitted.result?.error).not.toContain("access_denied");
    });

    it("cuts a very long reason short", async () => {
      const { manager, emitted, state } = await started();
      manager.declineSignIn("id-d", "x".repeat(500), state, "https://auth.example.com");
      expect(emitted.result?.error?.length).toBeLessThan(150);
    });

    it("ends the sign-in, so the same sign-in cannot then be completed", async () => {
      const { manager, emitted, state } = await started();
      manager.declineSignIn("id-d", "access_denied", state, "https://auth.example.com");
      await manager.completeSignIn("id-d", "the-code", state, "https://auth.example.com");
      expect(emitted.result?.error).toMatch(/no longer waiting/);
    });

    it("is reported as failed for an unknown sign-in", () => {
      const { manager, emitted } = makeManager();
      manager.declineSignIn("never-started", "access_denied", "state");
      expect(emitted.result).toMatchObject({ id: "never-started", ok: false });
    });
  });

  it("reports a code for an unknown sign-in as failed", async () => {
    const { manager, emitted } = makeManager();
    await manager.completeSignIn("never-started", "code", "state");
    expect(emitted.result?.ok).toBe(false);
  });

  it("signOut drops the session so the next call needs a sign-in again", async () => {
    const { manager, emitted } = makeManager();
    await signIn(manager, emitted, "id-4");
    manager.signOut(provider);
    await expect(manager.getAccessToken(provider)).rejects.toBeInstanceOf(SignInRequiredError);
  });
});

describe("a sign-in held by the real worker secret store", () => {
  function rotatingServer() {
    let n = 0;
    const valid = new Set<string>();
    let revoked = false;
    return ((init) => {
      const body = new URLSearchParams(String((init as RequestInit).body));
      if (body.get("grant_type") === "authorization_code") {
        const token = `R${n++}`;
        valid.add(token);
        return Response.json({ access_token: "at", refresh_token: token, expires_in: 0 });
      }
      const refreshToken = body.get("refresh_token")!;
      if (revoked || !valid.has(refreshToken)) {
        revoked = true;
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      valid.delete(refreshToken);
      const next = `R${n++}`;
      valid.add(next);
      return Response.json({ access_token: "at", refresh_token: next, expires_in: 0 });
    }) as (init?: RequestInit) => Response;
  }

  function tab(token = rotatingServer()) {
    const posted: ServerMessage[] = [];
    const store = createWorkerSecretStore((message) => posted.push(message));
    let authorizeUrl = "";
    const manager = createOAuthManager({
      fetchFn: authServerFetch({ token }),
      redirectUri: "https://afm.example/",
      refreshStore: store.refreshStore,
      emitAuthorizeUrl: (_id, url) => (authorizeUrl = url),
      emitSignInConfirm: () => {},
      emitSignInResult: () => {},
    });
    return { store, manager, posted, state: () => new URL(authorizeUrl).searchParams.get("state")! };
  }

  async function signedInTab(token?: ReturnType<typeof rotatingServer>) {
    const signedIn = tab(token);
    await signedIn.manager.startSignIn("s1", provider, listed);
    await signedIn.manager.completeSignIn("s1", "code", signedIn.state());
    return signedIn;
  }

  it("keeps the newest refresh token in memory as the server rotates it, and tells the page only its name", async () => {
    const { store, manager, posted } = await signedInTab();
    await manager.getAccessToken(provider);
    await manager.getAccessToken(provider);
    expect(store.refreshStore.get(authorizationCodeRefreshKey(provider))).toBe("R2");
    expect(posted.at(-1)).toEqual({ type: "secrets-list", names: [authorizationCodeRefreshKey(provider)] });
  });

  it("drops it on sign-out, so the next call needs a sign-in again", async () => {
    const { store, manager } = await signedInTab();
    manager.signOut(provider);
    expect(store.refreshStore.get(authorizationCodeRefreshKey(provider))).toBeNull();
    await expect(manager.getAccessToken(provider)).rejects.toBeInstanceOf(SignInRequiredError);
  });
});
