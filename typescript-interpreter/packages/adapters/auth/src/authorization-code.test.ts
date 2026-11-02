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
  type AuthorizationCodeConfig,
  authorizationCodeProviderKey,
  authorizationCodeRefreshKey,
  type AuthorizationCodeTokens,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  isExpired,
  isInteractiveOAuth,
  oauthProviderFrom,
  refreshAuthorizationCodeTokens,
} from "./authorization-code";
import { config, fakeFetch } from "./test-support";

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
  it("does not need redirectUri - a caller checking for a stored session does not have one", () => {
    const { authorizeUrl, tokenUrl, clientId, resource } = { ...config, resource: "https://mcp.example.com/mcp" };
    expect(authorizationCodeRefreshKey({ authorizeUrl, tokenUrl, clientId, resource })).toBe(
      `afm.oauth.${authorizationCodeProviderKey({ authorizeUrl, tokenUrl, clientId, resource })}.refresh`,
    );
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

describe("insecure endpoints in an untrusted agent file", () => {
  const insecure = ["http://auth.example.com/oauth2/authorize", "javascript:alert(1)", "data:text/html,x"];

  it("refuses to build an authorize URL for a non-https endpoint", () => {
    for (const authorizeUrl of insecure) {
      expect(() => buildAuthorizeUrl({ ...config, authorizeUrl }, { state: "s", codeChallenge: "c" })).toThrow(
        /authorize_url/,
      );
    }
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
});
