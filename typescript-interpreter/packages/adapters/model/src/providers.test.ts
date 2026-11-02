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
import { checkModelKey } from "./providers";

describe("checkModelKey", () => {
  const answering = (status: number) => (async () => new Response("{}", { status })) as typeof fetch;

  it("accepts a key the provider lists models for", async () => {
    expect(await checkModelKey("openai", "sk-ok", answering(200))).toEqual({ ok: true });
  });

  it("sends the key the way each provider expects it", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const record = (async (url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      return new Response("{}");
    }) as unknown as typeof fetch;
    await checkModelKey("openai", "sk-1", record);
    await checkModelKey("anthropic", "ak-1", record);
    expect(seen[0]).toEqual({ url: "https://api.openai.com/v1/models", headers: { authorization: "Bearer sk-1" } });
    expect(seen[1]?.url).toBe("https://api.anthropic.com/v1/models?limit=1");
    expect(seen[1]?.headers["x-api-key"]).toBe("ak-1");
    expect(seen[1]?.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  it("reports the status of a refusal", async () => {
    expect(await checkModelKey("anthropic", "bad", answering(401))).toEqual({ ok: false, status: 401 });
  });

  it("reports a request that never arrived as no status", async () => {
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await checkModelKey("openai", "sk", offline)).toEqual({ ok: false, status: null });
  });

  it("reports a provider that never answers as a timeout", async () => {
    const timedOut = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(await checkModelKey("openai", "sk", timedOut)).toEqual({ ok: false, status: 408 });
  });
});
