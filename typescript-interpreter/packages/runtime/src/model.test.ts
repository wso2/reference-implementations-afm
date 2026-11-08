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


import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createModel, type ModelOptions } from "./model";

type Seen = { url: string; headers: Headers; body: { model?: string } };

async function request(model: Parameters<typeof createModel>[0], options: ModelOptions = {}): Promise<Seen> {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  await generateText({ model: createModel(model, { ...options, fetch }), prompt: "hi", maxRetries: 0 }).catch(() => undefined);
  return seen[0]!;
}

const keyed = (provider: string, extra: object = {}) => ({ provider, authentication: { type: "api-key", api_key: "k-1" }, ...extra });

describe("createModel", () => {
  it("calls OpenAI Chat Completions with the key and the default model", async () => {
    const seen = await request(keyed("openai"));
    expect(seen.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen.headers.get("authorization")).toBe("Bearer k-1");
    expect(seen.body.model).toBe("gpt-4o");
  });

  it("calls Anthropic with the key in x-api-key, the default model, and no extra header", async () => {
    const seen = await request(keyed("anthropic"));
    expect(seen.url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen.headers.get("x-api-key")).toBe("k-1");
    expect([...seen.headers.keys()].filter((name) => name.includes("dangerous"))).toEqual([]);
    expect(seen.body.model).toBe("claude-sonnet-4-5");
  });

  it("uses OpenAI when no provider is named, and reads the provider without regard to case", async () => {
    expect((await request({ authentication: { type: "api-key", api_key: "k" } })).url).toContain("api.openai.com");
    expect((await request(keyed("Anthropic"))).url).toContain("api.anthropic.com");
  });

  it("uses the model name from the file", async () => {
    expect((await request(keyed("openai", { name: "gpt-4o-mini" }))).body.model).toBe("gpt-4o-mini");
  });

  it("treats the url as the base address of the provider's API", async () => {
    const seen = await request(keyed("openai", { name: "llama3", url: "http://localhost:11434/v1" }));
    expect(seen.url).toBe("http://localhost:11434/v1/chat/completions");
    expect((await request(keyed("anthropic", { url: "https://proxy.example.com/v1" }))).url).toBe("https://proxy.example.com/v1/messages");
  });

  it("sends a bearer token as the key", async () => {
    expect((await request({ provider: "openai", authentication: { type: "bearer", token: "t-1" } })).headers.get("authorization")).toBe("Bearer t-1");
  });

  it("takes the key from the environment when the model has no authentication", async () => {
    expect((await request({ provider: "openai" }, { env: { OPENAI_API_KEY: "from-env" } })).headers.get("authorization")).toBe("Bearer from-env");
    expect((await request({ provider: "anthropic" }, { env: { ANTHROPIC_API_KEY: "from-env" } })).headers.get("x-api-key")).toBe("from-env");
  });

  it("reads the process environment by default", async () => {
    const { env } = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process;
    env["OPENAI_API_KEY"] = "from-process";
    try {
      expect((await request({ provider: "openai" })).headers.get("authorization")).toBe("Bearer from-process");
    } finally {
      delete env["OPENAI_API_KEY"];
    }
  });

  it.each([
    ["no key anywhere", { provider: "openai" }, /set OPENAI_API_KEY/],
    ["an empty environment key", { provider: "anthropic" }, /set ANTHROPIC_API_KEY/],
    ["a bearer token that is missing", { provider: "openai", authentication: { type: "bearer" } }, /requires a 'token' field/],
    ["an api key that is missing", { provider: "openai", authentication: { type: "api-key" } }, /requires a 'api_key' field/],
    ["basic authentication", { provider: "openai", authentication: { type: "basic", username: "u", password: "p" } }, /not supported for model providers/],
    ["jwt authentication", { provider: "openai", authentication: { type: "jwt" } }, /'jwt' authentication is not yet supported by this interpreter/],
    ["another provider", { provider: "gemini", authentication: { type: "api-key", api_key: "k" } }, /'gemini' is not yet supported by this interpreter/],
    ["a provider that is a property of every object", { provider: "constructor" }, /not yet supported by this interpreter/],
  ])("refuses %s, saying what to do", (_label, model, message) => {
    expect(() => createModel(model, { env: {} })).toThrow(message);
  });

  it("never puts the key in an error message", () => {
    const message = (() => {
      try {
        createModel({ provider: "gemini", authentication: { type: "api-key", api_key: "SECRET-KEY" } });
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    })();
    expect(message).not.toBe("");
    expect(message).not.toContain("SECRET-KEY");
  });
});
