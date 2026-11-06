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

import type { AuthorizationCodeConfig } from "./authorization-code";

export const config: AuthorizationCodeConfig = {
  authorizeUrl: "https://auth.example.com/oauth2/authorize",
  tokenUrl: "https://auth.example.com/oauth2/token",
  clientId: "client-123",
  redirectUri: "http://localhost:5173/run",
  scopes: ["read", "write"],
};

export function fakeFetch(json: unknown, ok = true) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? ""), headers: { ...(init?.headers as Record<string, string>) } });
    return { ok, status: ok ? 200 : 400, json: async () => json } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
