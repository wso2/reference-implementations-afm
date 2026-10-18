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
import { modelEventsFromPart, toModelMessages, toToolSet, createAnthropicModel, createOpenAIModel, checkModelKey } from "./model";
import type { TextStreamPart, ToolSet } from "ai";
import type { ChatMessage, ToolDescriptor, ModelPort } from "@afm/engine";

describe("modelEventsFromPart", () => {
  it("maps a text-delta", () => {
    const part = { type: "text-delta", id: "1", text: "hi" } as TextStreamPart<ToolSet>;
    expect(modelEventsFromPart(part)).toEqual([{ type: "text-delta", text: "hi" }]);
  });

  it("maps a tool-call", () => {
    const part = {
      type: "tool-call",
      toolCallId: "c1",
      toolName: "t",
      input: { a: 1 },
    } as unknown as TextStreamPart<ToolSet>;
    expect(modelEventsFromPart(part)).toEqual([
      { type: "tool-call", id: "c1", name: "t", args: { a: 1 } },
    ]);
  });

  it("maps finish to usage + finish, collapsing unknown reasons to stop", () => {
    const part = {
      type: "finish",
      finishReason: "content-filter",
      rawFinishReason: "x",
      totalUsage: { inputTokens: 10, outputTokens: 5 },
    } as unknown as TextStreamPart<ToolSet>;
    expect(modelEventsFromPart(part)).toEqual([
      { type: "usage", inputTokens: 10, outputTokens: 5 },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("preserves the tool-calls finish reason", () => {
    const part = {
      type: "finish",
      finishReason: "tool-calls",
      rawFinishReason: "x",
      totalUsage: { inputTokens: 0, outputTokens: 0 },
    } as unknown as TextStreamPart<ToolSet>;
    expect(modelEventsFromPart(part).at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
  });

  it("ignores parts the loop does not need", () => {
    const part = { type: "text-start", id: "1" } as TextStreamPart<ToolSet>;
    expect(modelEventsFromPart(part)).toEqual([]);
  });

});

describe("toModelMessages", () => {
  it("maps plain user and assistant messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(toModelMessages(messages)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("maps an assistant tool-call turn to tool-call parts", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_time", args: { tz: "UTC" } }] },
    ];
    expect(toModelMessages(messages)[0]).toEqual({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "get_time", input: { tz: "UTC" } }],
    });
  });

  it("keeps assistant text before the tool calls when both exist", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "let me check", toolCalls: [{ id: "c1", name: "t", args: {} }] },
    ];
    expect(toModelMessages(messages)[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "let me check" },
        { type: "tool-call", toolCallId: "c1", toolName: "t", input: {} },
      ],
    });
  });

  it("maps a user message with an image part to the AI SDK's UserContent array", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", data: "base64pixels", mediaType: "image/png" },
        ],
      },
    ];
    expect(toModelMessages(messages)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", image: "base64pixels", mediaType: "image/png" },
        ],
      },
    ]);
  });

  it("maps a tool result, filling the tool name from the matching call", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "get_time", args: {} }] },
      { role: "tool", toolCallId: "c1", content: "12:00" },
    ];
    expect(toModelMessages(messages)[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "get_time",
          output: { type: "text", value: "12:00" },
        },
      ],
    });
  });
});

describe("toToolSet", () => {
  it("creates one entry per descriptor, with no execute", () => {
    const descriptors: ToolDescriptor[] = [
      {
        name: "search",
        description: "search the web",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ];
    const set = toToolSet(descriptors);
    expect(Object.keys(set)).toEqual(["search"]);
    expect(set.search?.description).toBe("search the web");
    expect(set.search?.execute).toBeUndefined();
  });

  it("returns an empty set when there are no tools", () => {
    expect(Object.keys(toToolSet([]))).toEqual([]);
  });
});

function rejectingFetch(status: number, body: string): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

async function surfaceFailure(port: ModelPort): Promise<void> {
  for await (const _event of port.stream(
    { system: "s", messages: [{ role: "user", content: "hi" }], tools: [] },
    new AbortController().signal,
  )) {
  }
}

describe("a provider that rejects the request", () => {
  it("fails the Anthropic stream with the reason the provider gave", async () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "CORS requests are not allowed for this Organization" },
    });
    const port = createAnthropicModel({ apiKey: "sk-1", fetch: rejectingFetch(401, body) });
    await expect(surfaceFailure(port)).rejects.toThrow(/CORS requests are not allowed for this Organization/);
  });

  it("fails the OpenAI stream the same way", async () => {
    const body = JSON.stringify({ error: { message: "Incorrect API key provided", code: "invalid_api_key" } });
    const port = createOpenAIModel({ apiKey: "sk-1", fetch: rejectingFetch(401, body) });
    await expect(surfaceFailure(port)).rejects.toThrow(/Incorrect API key provided/);
  });

  it("fails when the provider gives up part-way through a 200 stream", async () => {
    const stream = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half an ans"}}\n\n`,
      `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`,
    ].join("");
    const sse = (async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

    const port = createAnthropicModel({ apiKey: "sk-1", fetch: sse });
    await expect(surfaceFailure(port)).rejects.toThrow(/Overloaded/);
  });
});

const ANTHROPIC_STREAM = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"claude","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
].join("");

const OPENAI_STREAM = `data: [DONE]\n\n`;

function recordingFetch(stream: string) {
  const bodies: Record<string, unknown>[] = [];
  const fn = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

async function drain(port: ModelPort, system: string): Promise<void> {
  try {
    for await (const _event of port.stream(
      { system, messages: [{ role: "user", content: "hi" }], tools: [] },
      new AbortController().signal,
    )) {
    }
  } catch {
  }
}

describe("system prompt handling", () => {
  it("omits a blank system prompt on Anthropic instead of sending an empty content block", async () => {
    const recorder = recordingFetch(ANTHROPIC_STREAM);
    await drain(createAnthropicModel({ apiKey: "k", model: "claude-sonnet-4-5", fetch: recorder.fn }), "");
    expect(recorder.bodies[0]).not.toHaveProperty("system");
  });

  it("omits a whitespace-only system prompt too", async () => {
    const recorder = recordingFetch(ANTHROPIC_STREAM);
    await drain(createAnthropicModel({ apiKey: "k", model: "claude-sonnet-4-5", fetch: recorder.fn }), "\n  \n");
    expect(recorder.bodies[0]).not.toHaveProperty("system");
  });

  it("still sends a real system prompt on Anthropic", async () => {
    const recorder = recordingFetch(ANTHROPIC_STREAM);
    await drain(createAnthropicModel({ apiKey: "k", model: "claude-sonnet-4-5", fetch: recorder.fn }), "You are a tutor.");
    const system = recorder.bodies[0]?.["system"];
    expect(JSON.stringify(system)).toContain("You are a tutor.");
  });

  it("applies the same rule on OpenAI, which previously tolerated the empty message", async () => {
    const blank = recordingFetch(OPENAI_STREAM);
    await drain(createOpenAIModel({ apiKey: "k", model: "gpt-4o", fetch: blank.fn }), "");
    const input = blank.bodies[0]?.["input"] as { role: string }[];
    expect(input.some((entry) => entry.role === "system")).toBe(false);

    const real = recordingFetch(OPENAI_STREAM);
    await drain(createOpenAIModel({ apiKey: "k", model: "gpt-4o", fetch: real.fn }), "You are a tutor.");
    const withSystem = real.bodies[0]?.["input"] as { role: string; content: string }[];
    expect(withSystem[0]).toEqual({ role: "system", content: "You are a tutor." });
  });
});

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
