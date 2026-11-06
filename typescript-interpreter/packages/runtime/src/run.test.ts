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

import { APICallError, simulateReadableStream, tool } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentTurnInput, type LoopEvent, runAgentTurn } from "./run";

type Chunk = Record<string, unknown>;

const usage = { inputTokens: { total: 10 }, outputTokens: { total: 5 } };
const finish = (reason: string): Chunk => ({ type: "finish", finishReason: { unified: reason, raw: reason }, usage });
const text = (value: string, reason = "stop"): Chunk[] => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: value },
  { type: "text-end", id: "t" },
  finish(reason),
];
const call = (id: string, name: string, input: object = {}): Chunk => ({
  type: "tool-call",
  toolCallId: id,
  toolName: name,
  input: JSON.stringify(input),
});
const calls = (...items: Chunk[]): Chunk[] => [...items, finish("tool-calls")];

function modelOf(...steps: Chunk[][]): MockLanguageModelV3 {
  let next = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const step = steps[Math.min(next, steps.length - 1)] ?? [];
      next += 1;
      return { stream: simulateReadableStream({ chunks: step }) } as never;
    },
  });
}

const echo = tool({
  inputSchema: z.object({ x: z.number().optional() }),
  execute: async ({ x }) => ({ ok: true, content: `echo ${x ?? ""}` }),
  toModelOutput: ({ output }) => ({ type: "text", value: (output as { content: string }).content }),
});

const user: ModelMessage = { role: "user", content: "hi" };

async function run(model: MockLanguageModelV3, extra: Partial<AgentTurnInput> = {}): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of runAgentTurn({ system: "s", messages: [user], model, tools: {}, ...extra })) events.push(event);
  return events;
}

const types = (events: LoopEvent[]): string[] => events.map((event) => event.type);
const finishOf = (events: LoopEvent[]) => events.find((event) => event.type === "finish");
const completeOf = (events: LoopEvent[]) => events.find((event) => event.type === "turn-complete");

describe("a turn without tools", () => {
  it("streams the text, then completes with the whole conversation", async () => {
    const events = await run(modelOf(text("hello")));
    expect(types(events)).toEqual(["text-delta", "budget-update", "turn-complete", "finish"]);
    expect(finishOf(events)).toEqual({ type: "finish", reason: "stop" });
    expect(completeOf(events)).toMatchObject({ messages: [user, { role: "assistant" }] });
  });

  it("reports tokens and the step number", async () => {
    const events = await run(modelOf(text("hello")), { budget: { maxTokens: 1000, maxWallClockMs: 60_000 } });
    expect(events.find((event) => event.type === "budget-update")).toMatchObject({
      totalTokens: 15,
      inputTokens: 10,
      outputTokens: 5,
      maxTokens: 1000,
      iteration: 1,
      maxIterations: 10,
      maxWallClockMs: 60_000,
    });
  });

  it.each(["length", "content-filter", "other"])("ends with %s when the model ended that way", async (reason) => {
    expect(finishOf(await run(modelOf(text("cut off", reason))))).toEqual({ type: "finish", reason });
  });

  it("does not keep an empty answer in the conversation", async () => {
    const events = await run(modelOf([finish("stop")]));
    expect(completeOf(events)).toMatchObject({ messages: [user] });
  });
});

describe("a turn with tools", () => {
  const tools: ToolSet = { echo };

  it("runs the tool, sends its result back and ends with the next answer", async () => {
    const model = modelOf(calls(call("c1", "echo", { x: 2 })), text("done"));
    const events = await run(model, { tools });
    expect(types(events)).toEqual([
      "tool-call",
      "tool-result",
      "turn-checkpoint",
      "budget-update",
      "text-delta",
      "budget-update",
      "turn-complete",
      "finish",
    ]);
    expect(events[1]).toEqual({ type: "tool-result", id: "c1", name: "echo", ok: true, content: "echo 2" });
    const sent = model.doStreamCalls[1]?.prompt.map((message) => message.role);
    expect(sent).toEqual(["system", "user", "assistant", "tool"]);
  });

  it("sends only the text of a result to the model", async () => {
    const model = modelOf(calls(call("c1", "echo", { x: 1 })), text("done"));
    await run(model, { tools });
    const toolMessage = model.doStreamCalls[1]?.prompt.find((message) => message.role === "tool");
    expect(JSON.stringify(toolMessage?.content)).toContain('"output":{"type":"text","value":"echo 1"}');
  });

  it("saves the conversation after each step that ran tools", async () => {
    const events = await run(modelOf(calls(call("c1", "echo")), text("done")), { tools });
    const checkpoint = events.find((event) => event.type === "turn-checkpoint");
    expect(checkpoint).toMatchObject({ messages: [user, { role: "assistant" }, { role: "tool" }] });
  });

  it("reports a tool that the SDK could not run as a failed result", async () => {
    const events = await run(modelOf(calls(call("c1", "missing")), text("done")), { tools });
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({ id: "c1", name: "missing", ok: false });
    expect(finishOf(events)).toEqual({ type: "finish", reason: "stop" });
  });

  it("carries failed results through as failed", async () => {
    const failing: ToolSet = {
      bad: tool({
        inputSchema: z.object({}),
        execute: async () => ({ ok: false, content: "nope" }),
        toModelOutput: ({ output }) => ({ type: "text", value: (output as { content: string }).content }),
      }),
    };
    const events = await run(modelOf(calls(call("c1", "bad")), text("done")), { tools: failing });
    expect(events.find((event) => event.type === "tool-result")).toMatchObject({ ok: false, content: "nope" });
  });
});

describe("the limits of a turn", () => {
  const endless = modelOf(calls(call("c", "echo")));
  const tools: ToolSet = { echo };

  it("stops after 10 steps by default and says so", async () => {
    const model = modelOf(calls(call("c", "echo")));
    const events = await run(model, { tools });
    expect(model.doStreamCalls).toHaveLength(10);
    expect(finishOf(events)).toEqual({ type: "finish", reason: "max-iterations" });
  });

  it("uses the step limit from the agent file", async () => {
    const events = await run(endless, { tools, budget: { maxIterations: 2 } });
    expect(endless.doStreamCalls).toHaveLength(2);
    expect(finishOf(events)).toEqual({ type: "finish", reason: "max-iterations" });
  });

  it("stops when the token budget is used up", async () => {
    const model = modelOf(calls(call("c", "echo")));
    const events = await run(model, { tools, budget: { maxTokens: 30 } });
    expect(model.doStreamCalls).toHaveLength(2);
    expect(finishOf(events)).toEqual({ type: "finish", reason: "budget" });
  });

  it("stops when the time is up", async () => {
    const slow = new MockLanguageModelV3({
      doStream: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { stream: simulateReadableStream({ chunks: calls(call("c", "echo")) }) } as never;
      },
    });
    const events = await run(slow, { tools, budget: { maxWallClockMs: 30 } });
    expect(finishOf(events)).toEqual({ type: "finish", reason: "budget" });
  });
});

describe("Stop", () => {
  it("ends the turn as aborted when the signal fires before the model answers", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = modelOf(text("never"));
    const events = await run(model, { signal: controller.signal });
    expect(model.doStreamCalls).toHaveLength(0);
    expect(finishOf(events)).toEqual({ type: "finish", reason: "aborted" });
  });

  it("keeps the text that was already shown", async () => {
    const controller = new AbortController();
    const model = new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            async start(stream) {
              stream.enqueue({ type: "text-start", id: "t" });
              stream.enqueue({ type: "text-delta", id: "t", delta: "partial" });
              await new Promise((resolve) => setTimeout(resolve, 20));
              controller.abort();
              await new Promise((resolve) => setTimeout(resolve, 20));
              stream.close();
            },
          }),
        }) as never,
    });
    const events = await run(model, { signal: controller.signal });
    expect(finishOf(events)).toEqual({ type: "finish", reason: "aborted" });
    expect(completeOf(events)).toMatchObject({ messages: [user, { role: "assistant", content: "partial" }] });
  });

  it("is passed to a running tool", async () => {
    const controller = new AbortController();
    let seen: boolean | undefined;
    const tools: ToolSet = {
      wait: tool({
        inputSchema: z.object({}),
        execute: async (_input, { abortSignal }) => {
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 10));
          seen = abortSignal?.aborted;
          return { ok: false, content: "cancelled" };
        },
      }),
    };
    const model = modelOf(calls(call("c1", "wait")), text("never"));
    const events = await run(model, { tools, signal: controller.signal });
    expect(seen).toBe(true);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(finishOf(events)).toEqual({ type: "finish", reason: "aborted" });
  });
});

describe("keeping the conversation valid", () => {
  const tools: ToolSet = { echo };

  it("saves a finished tool result before a later model failure", async () => {
    let step = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        step += 1;
        if (step === 2) throw new APICallError({ message: "bad key", url: "u", requestBodyValues: {}, statusCode: 401, isRetryable: false });
        return { stream: simulateReadableStream({ chunks: calls(call("c1", "echo")) }) } as never;
      },
    });
    const seen: LoopEvent[] = [];
    await expect(
      (async () => {
        for await (const event of runAgentTurn({ system: "s", messages: [user], model, tools })) seen.push(event);
      })(),
    ).rejects.toThrow(/bad key/);
    expect(seen.find((event) => event.type === "turn-checkpoint")).toMatchObject({
      messages: [user, { role: "assistant" }, { role: "tool" }],
    });
  });

  it("never ends with a tool call that has no result, even when Stop comes while the tool waits", async () => {
    const controller = new AbortController();
    const waiting: ToolSet = {
      wait: tool({
        inputSchema: z.object({}),
        execute: async () => {
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { ok: false, content: "cancelled" };
        },
      }),
    };
    const events = await run(modelOf(calls(call("c1", "wait"))), { tools: waiting, signal: controller.signal });
    const messages = (completeOf(events) as { messages: ModelMessage[] }).messages;
    expect(messages.some((message) => message.role === "assistant" && Array.isArray(message.content))).toBe(false);
  });
});

describe("a listener that goes away", () => {
  it("stops the model request when nobody is reading the turn any more", async () => {
    let seen: AbortSignal | undefined;
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        seen = options.abortSignal;
        return {
          stream: new ReadableStream({
            start(stream) {
              stream.enqueue({ type: "text-start", id: "t" });
              stream.enqueue({ type: "text-delta", id: "t", delta: "first" });
            },
          }),
        } as never;
      },
    });
    for await (const event of runAgentTurn({ system: "s", messages: [user], model, tools: {} })) {
      if (event.type === "text-delta") break;
    }
    expect(seen?.aborted).toBe(true);
  });
});

describe("errors from the model", () => {
  const rateLimit = (headers: Record<string, string>) =>
    new APICallError({ message: "rate limit", url: "u", requestBodyValues: {}, statusCode: 429, isRetryable: true, responseHeaders: headers });

  it("retries a rate limit before any output, using the delay the provider asks for", async () => {
    let attempts = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        attempts += 1;
        if (attempts < 3) throw rateLimit({ "retry-after-ms": "5" });
        return { stream: simulateReadableStream({ chunks: text("fine") }) } as never;
      },
    });
    const events = await run(model);
    expect(attempts).toBe(3);
    expect(finishOf(events)).toEqual({ type: "finish", reason: "stop" });
  });

  it("gives up after the retries and reports the error", async () => {
    let attempts = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        attempts += 1;
        throw rateLimit({ "retry-after-ms": "1" });
      },
    });
    await expect(run(model)).rejects.toThrow(/Failed after 5 attempts.*rate limit/);
    expect(attempts).toBe(5);
  });

  it("does not retry an error that retrying cannot fix", async () => {
    let attempts = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        attempts += 1;
        throw new APICallError({ message: "bad key", url: "u", requestBodyValues: {}, statusCode: 401, isRetryable: false });
      },
    });
    await expect(run(model)).rejects.toThrow(/bad key/);
    expect(attempts).toBe(1);
  });

  it("throws an error that breaks the stream after some text", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(stream) {
              stream.enqueue({ type: "text-start", id: "t" });
              stream.enqueue({ type: "text-delta", id: "t", delta: "abc" });
              stream.enqueue({ type: "error", error: new Error("stream broke") });
              stream.close();
            },
          }),
        }) as never,
    });
    await expect(run(model)).rejects.toThrow("stream broke");
  });
});
