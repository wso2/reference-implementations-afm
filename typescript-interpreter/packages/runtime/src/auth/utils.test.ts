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
import { EXPIRY_SKEW_MS, expiryOf, generatePkce, isHttpsUrl, postTokenRequest, randomString, requireHttpsUrl, sameUrl } from "./utils";

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

describe("sameUrl", () => {
  it("compares addresses after normalising them", () => {
    expect(sameUrl("https://auth.example.com/token", "https://auth.example.com:443/token")).toBe(true);
    expect(sameUrl("HTTPS://AUTH.EXAMPLE.COM/token", "https://auth.example.com/token")).toBe(true);
  });

  it("tells apart addresses that differ in any part", () => {
    expect(sameUrl("https://auth.example.com/token", "https://auth.example.com/token/")).toBe(false);
    expect(sameUrl("https://auth.example.com/token", "https://other.example.com/token")).toBe(false);
  });

  it("is false when either side is not a URL", () => {
    expect(sameUrl("not a url", "https://auth.example.com/token")).toBe(false);
    expect(sameUrl("https://auth.example.com/token", "")).toBe(false);
    expect(sameUrl("", "")).toBe(false);
  });
});

describe("isHttpsUrl", () => {
  it("is true only for an https address", () => {
    expect(isHttpsUrl("https://auth.example.com/token")).toBe(true);
    expect(isHttpsUrl("HTTPS://AUTH.EXAMPLE.COM")).toBe(true);
  });

  it.each([["http://auth.example.com/token"], ["javascript:alert(1)"], ["not a url"], [""], [undefined], [null], [5]])("is false for %j", (value) => {
    expect(isHttpsUrl(value)).toBe(false);
  });
});

describe("expiryOf", () => {
  it("adds the lifetime the server gave to the current time", () => {
    const before = Date.now();
    expect(expiryOf({ expires_in: 60 })).toBeGreaterThanOrEqual(before + 60_000);
  });

  it.each([[undefined], ["3600"], [null]])("assumes an hour when the lifetime is %j", (expires_in) => {
    const before = Date.now();
    const expiresAt = expiryOf({ expires_in });
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(expiresAt).toBeLessThan(before + 3_600_000 + 1000);
  });

  it("keeps the expiry skew shorter than the shortest sensible lifetime", () => {
    expect(EXPIRY_SKEW_MS).toBe(30_000);
  });
});

describe("postTokenRequest", () => {
  const request = { headers: { accept: "application/json" }, body: new URLSearchParams({ grant_type: "x" }) };
  const answering = (status: number, json: unknown) =>
    (async () => ({ ok: status < 400, status, json: async () => json }) as Response) as unknown as typeof fetch;

  it("posts the request to the token endpoint and returns what it answered", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ access_token: "at" }) } as Response;
    }) as unknown as typeof fetch;
    expect(await postTokenRequest("https://auth.example.com/token", request, "failed", fetchFn)).toEqual({ access_token: "at" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://auth.example.com/token");
    expect(seen[0]?.init).toEqual({ method: "POST", redirect: "error", ...request });
  });

  it("names the step and the status when the endpoint refuses", async () => {
    await expect(postTokenRequest("https://auth.example.com/token", request, "OAuth2 token request failed", answering(503, {}))).rejects.toThrow(
      "OAuth2 token request failed: 503",
    );
  });

  it("does not send anything to an address that is not https", async () => {
    let sent = false;
    const fetchFn = (async () => ((sent = true), { ok: true, status: 200, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    await expect(postTokenRequest("http://auth.example.com/token", request, "failed", fetchFn)).rejects.toThrow(/token_url/);
    expect(sent).toBe(false);
  });

  it("does not follow a redirect, since the request carries codes and tokens", async () => {
    let redirect: RequestRedirect | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      redirect = init?.redirect;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    await postTokenRequest("https://auth.example.com/token", request, "failed", fetchFn);
    expect(redirect).toBe("error");
  });
});
