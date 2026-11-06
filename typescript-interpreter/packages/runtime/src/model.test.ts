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

import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { checkModelKey, completeText, createAnthropicModel, createOpenAIModel } from "./model";

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

describe("the models", () => {
  it("asks OpenAI not to keep the conversation, at the fixed OpenAI address", async () => {
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const spy = (async (url: string, init?: RequestInit) => {
      seen = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      return new Response("{}", { status: 400 });
    }) as unknown as typeof fetch;
    const model = createOpenAIModel({ apiKey: "sk-test", fetch: spy });
    await streamText({ model, prompt: "hi", maxRetries: 0, onError: () => {} }).consumeStream();
    expect(seen?.url).toMatch(/^https:\/\/api\.openai\.com\//);
    expect(seen?.body.store).toBe(false);
    expect(seen?.body.model).toBe("gpt-4o");
    expect(seen?.headers.get("authorization")).toBe("Bearer sk-test");
  });

  it("opens Anthropic for the browser, at the fixed Anthropic address", async () => {
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const spy = (async (url: string, init?: RequestInit) => {
      seen = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      return new Response("{}", { status: 400 });
    }) as unknown as typeof fetch;
    const model = createAnthropicModel({ apiKey: "ak-test", model: "claude-test", fetch: spy });
    await streamText({ model, prompt: "hi", maxRetries: 0, onError: () => {} }).consumeStream();
    expect(seen?.url).toMatch(/^https:\/\/api\.anthropic\.com\//);
    expect(seen?.headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(seen?.headers.get("x-api-key")).toBe("ak-test");
    expect(seen?.body.model).toBe("claude-test");
  });
});

describe("completeText", () => {
  const streaming = (...parts: Record<string, unknown>[]) =>
    new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks: parts }) }) as never });
  const finish = { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } };

  it("joins the text the model wrote and ignores everything else", async () => {
    const model = streaming(
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "a dra" },
      { type: "tool-call", toolCallId: "x", toolName: "nope", input: "{}" },
      { type: "text-delta", id: "a", delta: "ft" },
      { type: "text-end", id: "a" },
      finish,
    );
    expect(await completeText(model, "write one")).toBe("a draft");
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain("write one");
  });

  it("throws the error that broke the stream, without a partial answer", async () => {
    const failure = new Error("stream failed");
    const model = new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "a" });
              controller.enqueue({ type: "text-delta", id: "a", delta: "partial" });
              controller.enqueue({ type: "error", error: failure });
              controller.close();
            },
          }),
        }) as never,
    });
    await expect(completeText(model, "write one")).rejects.toBe(failure);
  });
});
