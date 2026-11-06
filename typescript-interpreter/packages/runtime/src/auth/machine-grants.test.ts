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
import { createOAuth2MachineClient } from "./machine-grants";
import type { OAuth2MachineConfig } from "./machine-grants";

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

describe("a refresh token that the provider replaces", () => {
  const config: OAuth2MachineConfig = { grantType: "refresh_token", tokenUrl: "https://auth.example.com/token", refreshToken: "rt-1" };
  const sent = (fetchFn: typeof fetch, name: string) =>
    (fetchFn as unknown as { calls: Array<{ init?: RequestInit }> }).calls.map((call) => (call.init!.body as URLSearchParams).get(name));
  const expiring = (extra: Record<string, unknown> = {}) => ({ body: { access_token: "a", expires_in: 1, ...extra } });

  it("is the one sent with the next request", async () => {
    const fetchFn = scriptedFetch([expiring({ refresh_token: "rt-2" }), expiring({ refresh_token: "rt-3" }), expiring()]);
    const client = createOAuth2MachineClient(config);
    for (let call = 0; call < 3; call++) await client.getAccessToken(fetchFn);
    expect(sent(fetchFn, "refresh_token")).toEqual(["rt-1", "rt-2", "rt-3"]);
  });

  it("stays the same when the provider sends no new one, or an empty one", async () => {
    const fetchFn = scriptedFetch([expiring(), expiring({ refresh_token: "" }), expiring({ refresh_token: 5 })]);
    const client = createOAuth2MachineClient(config);
    for (let call = 0; call < 3; call++) await client.getAccessToken(fetchFn);
    expect(sent(fetchFn, "refresh_token")).toEqual(["rt-1", "rt-1", "rt-1"]);
  });

  it("matters only to the refresh_token grant", async () => {
    const fetchFn = scriptedFetch([expiring({ refresh_token: "rt-2" }), expiring()]);
    const client = createOAuth2MachineClient({ grantType: "client_credentials", tokenUrl: "https://auth.example.com/token", clientId: "i", clientSecret: "s" });
    await client.getAccessToken(fetchFn);
    await client.getAccessToken(fetchFn);
    expect(sent(fetchFn, "refresh_token")).toEqual([null, null]);
  });
});

describe("a machine client that several callers use at once", () => {
  const credentials: OAuth2MachineConfig = { grantType: "client_credentials", tokenUrl: "https://auth.example.com/token", clientId: "i", clientSecret: "s" };
  const refreshing: OAuth2MachineConfig = { grantType: "refresh_token", tokenUrl: "https://auth.example.com/token", refreshToken: "rt-1" };
  const requests = (fetchFn: typeof fetch) => (fetchFn as unknown as { calls: unknown[] }).calls.length;
  const sent = (fetchFn: typeof fetch) =>
    (fetchFn as unknown as { calls: Array<{ init?: RequestInit }> }).calls.map((call) => (call.init!.body as URLSearchParams).get("refresh_token"));
  const token = (name: string, extra: Record<string, unknown> = {}) => ({ body: { access_token: name, expires_in: 3600, ...extra } });

  it("sends one token request for callers that arrive together", async () => {
    const fetchFn = scriptedFetch([token("tok-1"), token("tok-2")]);
    const client = createOAuth2MachineClient(credentials);
    const tokens = await Promise.all([client.getAccessToken(fetchFn), client.getAccessToken(fetchFn), client.getAccessToken(fetchFn)]);
    expect(tokens).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(requests(fetchFn)).toBe(1);
  });

  it("spends a refresh token once, so the provider never sees it used twice", async () => {
    const fetchFn = scriptedFetch([token("tok-1", { refresh_token: "rt-2" }), token("tok-2")]);
    const client = createOAuth2MachineClient(refreshing);
    await Promise.all([client.getAccessToken(fetchFn), client.getAccessToken(fetchFn)]);
    expect(sent(fetchFn)).toEqual(["rt-1"]);
  });

  it("gives every waiting caller the same failure, then asks again on the next call", async () => {
    const fetchFn = scriptedFetch([{ status: 500 }, token("tok-1")]);
    const client = createOAuth2MachineClient(credentials);
    const waiting = await Promise.allSettled([client.getAccessToken(fetchFn), client.getAccessToken(fetchFn)]);
    expect(waiting.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(requests(fetchFn)).toBe(1);
    expect(await client.getAccessToken(fetchFn)).toBe("tok-1");
    expect(requests(fetchFn)).toBe(2);
  });

  it("asks for a new token after invalidate, and keeps the cached one until then", async () => {
    const fetchFn = scriptedFetch([token("tok-1"), token("tok-2")]);
    const client = createOAuth2MachineClient(credentials);
    expect(await client.getAccessToken(fetchFn)).toBe("tok-1");
    expect(await client.getAccessToken(fetchFn)).toBe("tok-1");
    client.invalidate();
    expect(await client.getAccessToken(fetchFn)).toBe("tok-2");
    expect(requests(fetchFn)).toBe(2);
  });

  it("does not throw away a token that is still on its way when invalidate is called", async () => {
    const fetchFn = scriptedFetch([token("tok-1"), token("tok-2")]);
    const client = createOAuth2MachineClient(credentials);
    const arriving = client.getAccessToken(fetchFn);
    client.invalidate();
    expect(await arriving).toBe("tok-1");
    expect(await client.getAccessToken(fetchFn)).toBe("tok-1");
    expect(requests(fetchFn)).toBe(1);
  });

  it("keeps the replaced refresh token when invalidate is called", async () => {
    const fetchFn = scriptedFetch([token("tok-1", { refresh_token: "rt-2" }), token("tok-2")]);
    const client = createOAuth2MachineClient(refreshing);
    await client.getAccessToken(fetchFn);
    client.invalidate();
    await client.getAccessToken(fetchFn);
    expect(sent(fetchFn)).toEqual(["rt-1", "rt-2"]);
  });
});

describe("the HTTP Basic header for client credentials", () => {
  const basicHeaderFor = async (clientId: string, clientSecret: string): Promise<string> => {
    const fetchFn = scriptedFetch([{ body: { access_token: "tok", expires_in: 3600 } }]);
    const config: OAuth2MachineConfig = { grantType: "client_credentials", tokenUrl: "https://auth.example.com/token", clientId, clientSecret };
    await createOAuth2MachineClient(config).getAccessToken(fetchFn);
    const headers = (fetchFn as unknown as { calls: Array<{ init?: RequestInit }> }).calls[0]!.init!.headers as Record<string, string>;
    return headers.authorization!;
  };
  const credentialsIn = (header: string): string => atob(header.replace("Basic ", ""));

  it("matches the example in RFC 6749", async () => {
    expect(await basicHeaderFor("s6BhdRkqt3", "7Fjfp0ZBr1KtDRbnfVdmIw")).toBe("Basic czZCaGRSa3F0Mzo3RmpmcDBaQnIxS3REUmJuZlZkbUl3");
  });

  it("leaves letters, digits and - _ . * as they are", async () => {
    expect(credentialsIn(await basicHeaderFor("Ab1-_.*", "Cd2-_.*"))).toBe("Ab1-_.*:Cd2-_.*");
  });

  it("form-encodes every other character before the base64 step", async () => {
    expect(credentialsIn(await basicHeaderFor("client one", "p@ss:w+rd%&=~"))).toBe("client+one:p%40ss%3Aw%2Brd%25%26%3D%7E");
  });

  it("encodes characters outside ASCII as UTF-8", async () => {
    expect(credentialsIn(await basicHeaderFor("id", "pässwörd"))).toBe("id:p%C3%A4ssw%C3%B6rd");
  });

  it("keeps a colon in the client id from moving the split between id and secret", async () => {
    const credentials = credentialsIn(await basicHeaderFor("https://app.example/client", "secret"));
    expect(credentials.split(":")).toEqual(["https%3A%2F%2Fapp.example%2Fclient", "secret"]);
  });

  it("gives a server that decodes the form encoding the original id and secret back", async () => {
    const id = "my app:1";
    const secret = "p@ss w+rd%&=~ä";
    const [encodedId, encodedSecret] = credentialsIn(await basicHeaderFor(id, secret)).split(":");
    const decode = (value: string) => decodeURIComponent(value.replace(/\+/g, " "));
    expect([decode(encodedId!), decode(encodedSecret!)]).toEqual([id, secret]);
  });
});
