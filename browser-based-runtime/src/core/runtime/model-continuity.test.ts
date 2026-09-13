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
import { runAgentTurn, allowAllPermissions } from "@afm/engine";
import type { ChatMessage, LoopEvent, ToolPort } from "@afm/engine";
import { createOpenAIModel, createAnthropicModel } from "@afm/adapter-model";

const tools: ToolPort = {
  async list() {
    return [{ name: "lookup", inputSchema: { type: "object", properties: {} } }];
  },
  async execute() {
    return { ok: true, content: "Confirmed project evidence" };
  },
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
  {
    type: "response.output_text.delta",
    output_index: 1,
    item_id: "msg_1",
    content_index: 0,
    delta: "Checking the evidence.",
  },
  { type: "response.output_item.done", output_index: 1, item: commentary },
  { type: "response.output_item.added", output_index: 2, item: call },
  { type: "response.output_item.done", output_index: 2, item: { ...call, status: "completed" } },
  completed,
]);
const final = sse([
  created,
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...commentary, id: "msg_final", phase: "final_answer" },
  },
  {
    type: "response.output_text.delta",
    output_index: 0,
    item_id: "msg_final",
    content_index: 0,
    delta: "Here is your preparation plan.",
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { ...commentary, id: "msg_final", phase: "final_answer" },
  },
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

async function turn(
  port: ReturnType<typeof setup>["port"],
  messages: ChatMessage[],
  system = "Help me prepare for an interview.",
) {
  const events: LoopEvent[] = [];
  for await (const event of runAgentTurn({ system, messages, model: port, tools, permission: allowAllPermissions }))
    events.push(event);
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
    expect(input).toContainEqual(
      expect.objectContaining({ type: "reasoning", encrypted_content: "opaque-test-ciphertext" }),
    );
    expect(input).toContainEqual(expect.objectContaining({ role: "assistant", phase: "commentary" }));
    expect(input).toContainEqual(
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call_1",
        output: "Confirmed project evidence",
      }),
    );
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
    const eventStream = (events: Record<string, unknown>[]) =>
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
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
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Synthetic fixture reasoning" },
      },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-signature" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call_1", name: "lookup", input: {} },
      },
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
      return new Response(bodies.length === 1 ? thinking : answer, {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const port = createAnthropicModel({ apiKey: "fixture-key", fetch: fetcher });
    const result = await turn(port, [{ role: "user", content: "Prepare me." }]);
    expect(JSON.stringify(bodies[1]?.messages)).toContain('"signature":"fixture-signature"');
    expect(JSON.stringify(bodies[1]?.messages)).toContain('"type":"tool_result"');
    expect(JSON.stringify(result.events)).not.toContain("fixture-signature");
  });
});
