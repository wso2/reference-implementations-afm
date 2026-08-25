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
import { withSignIn } from "./sign-in-fetch";

function setup(statuses: number[], renew: (rejected: string) => Promise<boolean>) {
  const seen: { url: string; authorization: string | null; method?: string }[] = [];
  const answers = [...statuses];
  const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), method: init?.method });
    return new Response("", { status: answers.shift() ?? 200 });
  }) as typeof fetch;
  let current = 0;
  const token = vi.fn(async () => `token-${++current}`);
  return { seen, fetch: withSignIn(send, { token, renew }), token };
}

describe("withSignIn", () => {
  it("adds the access token to the request, keeping the rest of it", async () => {
    const { fetch, seen } = setup([200], async () => false);
    const response = await fetch("https://a.example/mcp", { method: "POST", headers: { "x-keep": "1" } });
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ url: "https://a.example/mcp", authorization: "Bearer token-1", method: "POST" }]);
  });

  it("replaces an Authorization header the caller set", async () => {
    const { fetch, seen } = setup([200], async () => false);
    await fetch("https://a.example/mcp", { headers: { authorization: "Bearer other" } });
    expect(seen[0]?.authorization).toBe("Bearer token-1");
  });

  it("renews once when the server turns the token down, then sends the request again with the new token", async () => {
    const renew = vi.fn(async () => true);
    const { fetch, seen } = setup([401, 200], renew);
    expect((await fetch("https://a.example/mcp")).status).toBe(200);
    expect(renew).toHaveBeenCalledExactlyOnceWith("token-1");
    expect(seen.map((request) => request.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("returns the 401 as it is when the token could not be renewed", async () => {
    const { fetch, seen } = setup([401], async () => false);
    expect((await fetch("https://a.example/mcp")).status).toBe(401);
    expect(seen).toHaveLength(1);
  });

  it("does not try a third time when the renewed token is turned down too", async () => {
    const { fetch, seen } = setup([401, 401, 200], async () => true);
    expect((await fetch("https://a.example/mcp")).status).toBe(401);
    expect(seen).toHaveLength(2);
  });

  it("does not ask to renew for any other status", async () => {
    const renew = vi.fn(async () => true);
    const { fetch } = setup([403], renew);
    expect((await fetch("https://a.example/mcp")).status).toBe(403);
    expect(renew).not.toHaveBeenCalled();
  });

  it("does not send the request when there is no token to send", async () => {
    const send = vi.fn(async () => new Response(""));
    const fetch = withSignIn(send as unknown as typeof globalThis.fetch, { token: async () => Promise.reject(new Error("sign in first")), renew: async () => false });
    await expect(fetch("https://a.example/mcp")).rejects.toThrow("sign in first");
    expect(send).not.toHaveBeenCalled();
  });
});
