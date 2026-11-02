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

import { allowAllPermissions, type ChatMessage, type LoopEvent, type ModelPort, runAgentTurn, type ToolPort } from "@afm/engine";
import { describe, expect, it } from "vitest";
import { createAnthropicModel, createOpenAIModel } from "./providers";
import { type Continuation, createContinuationStore } from "./stream";

const ANTHROPIC_MESSAGE_START = [
  "event: message_start\n",
  'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","model":"claude","content":[],',
  '"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
].join("");

function rejectingFetch(status: number, body: string): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

async function consume(port: ModelPort, system = "s"): Promise<void> {
  for await (const event of port.stream(
    { system, messages: [{ role: "user", content: "hi" }], tools: [] },
    new AbortController().signal,
  )) void event;
}

describe("a provider that rejects the request", () => {
  it("fails the Anthropic stream with the reason the provider gave", async () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "CORS requests are not allowed for this Organization" },
    });
    const port = createAnthropicModel({ apiKey: "sk-1", fetch: rejectingFetch(401, body) });
    await expect(consume(port)).rejects.toThrow(/CORS requests are not allowed for this Organization/);
  });

  it("fails the OpenAI stream the same way", async () => {
    const body = JSON.stringify({ error: { message: "Incorrect API key provided", code: "invalid_api_key" } });
    const port = createOpenAIModel({ apiKey: "sk-1", fetch: rejectingFetch(401, body) });
    await expect(consume(port)).rejects.toThrow(/Incorrect API key provided/);
  });

  it("fails when the provider gives up part-way through a 200 stream", async () => {
    const stream = [
      ANTHROPIC_MESSAGE_START,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"half an ans"}}\n\n`,
      `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`,
    ].join("");
    const sse = (async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

    const port = createAnthropicModel({ apiKey: "sk-1", fetch: sse });
    await expect(consume(port)).rejects.toThrow(/Overloaded/);
  });
});

const ANTHROPIC_STREAM = [
  ANTHROPIC_MESSAGE_START,
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
  await consume(port, system).catch(() => undefined);
}

describe("system prompt handling", () => {
  it("omits a blank system prompt on Anthropic instead of sending an empty content block", async () => {
    const recorder = recordingFetch(ANTHROPIC_STREAM);
    await drain(createAnthropicModel({ apiKey: "k", model: "claude-sonnet-4-5", fetch: recorder.fn }), "");
    expect(recorder.bodies[0]).not.toHaveProperty("system");
  });

  it("leaves a blank system message in the conversation out of the request", async () => {
    const recorder = recordingFetch(ANTHROPIC_STREAM);
    const port = createAnthropicModel({ apiKey: "k", model: "claude-sonnet-4-5", fetch: recorder.fn });
    const messages: ChatMessage[] = [
      { role: "system", content: "  " },
      { role: "user", content: "hi" },
    ];
    for await (const event of port.stream({ system: "Be brief.", messages, tools: [] }, new AbortController().signal)) void event;
    expect(recorder.bodies[0]?.system).toEqual([{ type: "text", text: "Be brief." }]);
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

const tools: ToolPort = {
  async list() { return [{ name: "lookup", inputSchema: { type: "object", properties: {} } }]; },
  async execute() { return { ok: true, content: "Confirmed project evidence" }; },
};

const sse = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const created = { type: "response.created", response: { id: "resp_1", model: "gpt-6.1-sol", created_at: 1 } };
const completed = { type: "response.completed", response: { usage: { input_tokens: 20, output_tokens: 5 } } };
const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "opaque-test-ciphertext" };
const commentary = { type: "message", id: "msg_1", phase: "commentary" };
const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{}" };
const first = sse([
  created,
  { type: "response.output_item.added", output_index: 0, item: reasoning },
  { type: "response.output_item.done", output_index: 0, item: reasoning },
  { type: "response.output_item.added", output_index: 1, item: commentary },
  { type: "response.output_text.delta", output_index: 1, item_id: "msg_1", content_index: 0, delta: "Checking the evidence." },
  { type: "response.output_item.done", output_index: 1, item: commentary },
  { type: "response.output_item.added", output_index: 2, item: call },
  { type: "response.output_item.done", output_index: 2, item: { ...call, status: "completed" } },
  completed,
]);
const final = sse([
  created,
  { type: "response.output_item.added", output_index: 0, item: { ...commentary, id: "msg_final", phase: "final_answer" } },
  { type: "response.output_text.delta", output_index: 0, item_id: "msg_final", content_index: 0, delta: "Here is your preparation plan." },
  { type: "response.output_item.done", output_index: 0, item: { ...commentary, id: "msg_final", phase: "final_answer" } },
  completed,
]);

function setup() {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(bodies.length === 1 ? first : final, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { bodies, port: createOpenAIModel({ apiKey: "fixture-key", model: "gpt-6.1-sol", fetch: fetcher }) };
}

async function turn(port: ReturnType<typeof setup>["port"], messages: ChatMessage[], system = "Help me prepare for an interview.") {
  const events: LoopEvent[] = [];
  for await (const event of runAgentTurn({ system, messages, model: port, tools, permission: allowAllPermissions })) events.push(event);
  const complete = events.find((event) => event.type === "turn-complete");
  if (complete?.type !== "turn-complete") throw new Error("No completed transcript");
  return { events, messages: complete.messages };
}

describe("provider continuity through the real SDK and agent loop", () => {
  it("replays opaque reasoning and message phase alongside tool outputs", async () => {
    const { bodies, port } = setup();
    const result = await turn(port, [{ role: "user", content: "Use my project to prepare me." }]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.store).toBe(false);
    expect(bodies[0]?.include).toContain("reasoning.encrypted_content");
    const input = bodies[1]?.input as Record<string, unknown>[];
    expect(input).toContainEqual(expect.objectContaining({ type: "reasoning", encrypted_content: "opaque-test-ciphertext" }));
    expect(input).toContainEqual(expect.objectContaining({ role: "assistant", phase: "commentary" }));
    expect(input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_1", output: "Confirmed project evidence" }));
    expect(result.events).toContainEqual({ type: "text-delta", text: "Here is your preparation plan." });
    expect(JSON.stringify(result.events)).not.toContain("opaque-test-ciphertext");
  });

  it("keeps native history across a follow-up without duplicating reasoning items", async () => {
    const { bodies, port } = setup();
    const firstTurn = await turn(port, [{ role: "user", content: "Prepare me." }]);
    await turn(port, [...firstTurn.messages, { role: "user", content: "Now give me one practice question." }]);
    const input = bodies[2]?.input as Record<string, unknown>[];
    expect(input.filter((item) => item.type === "reasoning")).toHaveLength(1);
    expect(input.filter((item) => item.type === "function_call_output")).toHaveLength(1);
    expect(input).toContainEqual(expect.objectContaining({ role: "assistant", phase: "final_answer" }));
  });

  it("does not inject a continuation into an edited conversation", async () => {
    const { bodies, port } = setup();
    await turn(port, [{ role: "user", content: "Prepare me." }]);
    await turn(port, [{ role: "user", content: "A different task." }]);
    expect(JSON.stringify(bodies[2]?.input)).not.toContain("opaque-test-ciphertext");
    expect(JSON.stringify(bodies[2]?.input)).not.toContain("Confirmed project evidence");
  });

  it("does not reuse provider state under different system instructions", async () => {
    const { bodies, port } = setup();
    const previous = await turn(port, [{ role: "user", content: "Prepare me." }]);
    await turn(port, [...previous.messages, { role: "user", content: "Continue." }], "A different role.");
    expect(JSON.stringify(bodies[2]?.input)).not.toContain("opaque-test-ciphertext");
  });

  it("retains Anthropic thinking signatures beside a tool result", async () => {
    const eventStream = (events: Record<string, unknown>[]) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    const start = {
      type: "message_start",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    const thinking = eventStream([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Synthetic fixture reasoning" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-signature" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_1", name: "lookup", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ]);
    const answer = eventStream([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Here is the plan." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ]);
    const bodies: Record<string, unknown>[] = [];
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(bodies.length === 1 ? thinking : answer, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const port = createAnthropicModel({ apiKey: "fixture-key", fetch: fetcher });
    const result = await turn(port, [{ role: "user", content: "Prepare me." }]);
    expect(JSON.stringify(bodies[1]?.messages)).toContain('"signature":"fixture-signature"');
    expect(JSON.stringify(bodies[1]?.messages)).toContain('"type":"tool_result"');
    expect(JSON.stringify(result.events)).not.toContain("fixture-signature");
  });
});

describe("createContinuationStore", () => {
  const user = (content: string): ChatMessage => ({ role: "user", content });
  const assistant = (content: string, toolCalls?: Array<{ id: string; name: string; args: unknown }>): ChatMessage => ({
    role: "assistant",
    content,
    toolCalls,
  });
  const kept = (system: string, visible: ChatMessage[]): Continuation => ({ system, visible, native: [] });

  it("finds nothing before anything is remembered", () => {
    expect(createContinuationStore().find("s", [user("hi")])).toBeUndefined();
  });

  it("finds the continuation whose history the request repeats, and not a different system prompt", () => {
    const store = createContinuationStore();
    const history = [user("hi"), assistant("hello")];
    const continuation = kept("s", history);
    store.remember(continuation);
    expect(store.find("s", [...history, user("more")])?.native).toBe(continuation.native);
    expect(store.find("other", [...history, user("more")])).toBeUndefined();
  });

  it("compares messages by what they say, not by identity", () => {
    const store = createContinuationStore();
    const continuation = kept("s", [user("hi"), assistant("hello", [{ id: "c1", name: "lookup", args: { q: 1 } }])]);
    store.remember(continuation);
    const copy = JSON.parse(JSON.stringify(continuation.visible)) as ChatMessage[];
    expect(store.find("s", [...copy, user("more")])?.native).toBe(continuation.native);
  });

  it("is not fooled when the caller edits a message it handed over after the turn", () => {
    const store = createContinuationStore();
    const question = user("What is 2 + 2?");
    const tools = [{ id: "c1", name: "lookup", args: { q: { page: 1 } } }];
    const reply = assistant("Checking.", tools);
    store.remember(kept("s", [question, reply]));
    expect(store.find("s", [question, reply, user("more")])).toBeDefined();

    question.content = "What is 3 + 3?";
    expect(store.find("s", [question, reply, user("more")])).toBeUndefined();
    question.content = "What is 2 + 2?";
    (tools[0]!.args as { q: { page: number } }).q.page = 2;
    expect(store.find("s", [question, reply, user("more")])).toBeUndefined();
  });

  it("does not mind the order of the keys in a tool call's arguments or in a message's parts", () => {
    const store = createContinuationStore();
    const asked = { id: "c1", name: "lookup", args: { q: 1, filters: { b: 2, a: 1 } } };
    const continuation = kept("s", [user("hi"), assistant("hello", [asked])]);
    store.remember(continuation);
    const reordered = { id: "c1", name: "lookup", args: { filters: { a: 1, b: 2 }, q: 1 } };
    expect(store.find("s", [user("hi"), assistant("hello", [reordered]), user("more")])?.native).toBe(continuation.native);
  });

  it("still tells apart arguments that really differ, and arrays whose order differs", () => {
    const store = createContinuationStore();
    store.remember(kept("s", [user("hi"), assistant("hello", [{ id: "c1", name: "lookup", args: { list: [1, 2], q: 1 } }])]));
    const other = (args: unknown) => [user("hi"), assistant("hello", [{ id: "c1", name: "lookup", args }])];
    expect(store.find("s", other({ list: [2, 1], q: 1 }))).toBeUndefined();
    expect(store.find("s", other({ list: [1, 2], q: 2 }))).toBeUndefined();
  });

  it.each([
    ["an earlier message changed", [user("hi!"), assistant("hello")]],
    ["the history is shorter than the one remembered", [user("hi")]],
    ["a tool call took other arguments", [user("hi"), assistant("hello", [{ id: "c1", name: "lookup", args: { q: 2 } }])]],
    ["a tool result answers another call", [user("hi"), assistant("hello"), { role: "tool", toolCallId: "other", content: "r" } as ChatMessage]],
  ])("does not continue when %s", (_label, request) => {
    const store = createContinuationStore();
    const call = { id: "c1", name: "lookup", args: { q: 1 } };
    store.remember(kept("s", [user("hi"), assistant("hello", [call]), { role: "tool", toolCallId: "c1", content: "r" }]));
    expect(store.find("s", request)).toBeUndefined();
  });

  it("prefers the longest of two continuations that both fit, even when a shorter one was stored later", () => {
    const store = createContinuationStore();
    const longer = kept("s", [user("hi"), assistant("hello")]);
    const shorter = kept("s", [user("hi")]);
    store.remember(longer);
    store.remember(shorter);
    expect(store.find("s", [user("hi"), assistant("hello"), user("more")])?.native).toBe(longer.native);
  });

  it("prefers the most recent of two continuations that both fit", () => {
    const store = createContinuationStore();
    const older = kept("s", [user("hi")]);
    const newer = kept("s", [user("hi"), assistant("hello")]);
    store.remember(older);
    store.remember(newer);
    expect(store.find("s", [user("hi"), assistant("hello"), user("more")])?.native).toBe(newer.native);
  });

  it("forgets the oldest continuation once more than sixty-four are kept", () => {
    const store = createContinuationStore();
    const all = Array.from({ length: 65 }, (_, index) => kept("s", [user(`conversation ${index}`)]));
    for (const continuation of all) store.remember(continuation);
    expect(store.find("s", [user("conversation 0")])).toBeUndefined();
    expect(store.find("s", [user("conversation 1")])?.native).toBe(all[1]?.native);
  });
});
