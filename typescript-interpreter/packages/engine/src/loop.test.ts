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
import { runAgentTurn, allowAllPermissions, MAX_TOOL_RESULT_CHARS } from "./loop";
import type { AgentTurnInput, LoopEvent, PermissionBroker } from "./loop";
import type { ModelEvent, ModelPort, ModelRequest, ToolPort, ToolResult, ToolCall, ToolDescriptor } from "./types";

function scriptedModel(turns: ModelEvent[][]): { port: ModelPort; calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  let index = 0;
  const port: ModelPort = {
    async *stream(request) {
      calls.push(request);
      const events: ModelEvent[] = turns[index] ?? [{ type: "finish", reason: "stop" }];
      index += 1;
      for (const event of events) {
        yield event;
      }
      if (!events.some((event) => event.type === "finish")) {
        yield { type: "finish", reason: events.some((event) => event.type === "tool-call") ? "tool-calls" : "stop" };
      }
    },
  };
  return { port, calls };
}

function scriptedTools(results: Record<string, ToolResult | (() => ToolResult)>): {
  port: ToolPort;
  executed: ToolCall[];
} {
  const executed: ToolCall[] = [];
  const port: ToolPort = {
    async list(): Promise<ToolDescriptor[]> {
      return Object.keys(results).map((name) => ({ name, inputSchema: {} }));
    },
    async execute(call) {
      executed.push(call);
      const entry = results[call.name];
      if (entry === undefined) {
        return { ok: false, content: "no such tool" };
      }
      return typeof entry === "function" ? entry() : entry;
    },
  };
  return { port, executed };
}

const denyAll: PermissionBroker = {
  async request() {
    return "deny";
  },
};

async function collect(events: AsyncIterable<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

function collectWithBudget(model: ModelPort, tools: ToolPort, budget: AgentTurnInput["budget"]): Promise<LoopEvent[]> {
  return collect(runAgentTurn({ system: "S", messages: [], model, tools, permission: allowAllPermissions, budget }));
}

function joinText(events: LoopEvent[]): string {
  return events.flatMap((e) => (e.type === "text-delta" ? [e.text] : [])).join("");
}

describe("runAgentTurn", () => {
  it("streams a plain answer with no tools", async () => {
    const { port: model, calls } = scriptedModel([
      [
        { type: "text-delta", text: "Hello" },
        { type: "text-delta", text: " world" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const { port: tools } = scriptedTools({});
    const events = await collect(
      runAgentTurn({
        system: "S",
        messages: [{ role: "user", content: "hi" }],
        model,
        tools,
        permission: allowAllPermissions,
      }),
    );
    expect(joinText(events)).toBe("Hello world");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(calls).toHaveLength(1);
  });

  it("reports an output limit as incomplete and never runs a truncated tool call", async () => {
    const { port: model } = scriptedModel([
      [
        { type: "text-delta", text: "Partial" },
        { type: "tool-call", id: "c1", name: "write", args: {} },
        { type: "finish", reason: "length" },
      ],
    ]);
    const { port: tools, executed } = scriptedTools({ write: { ok: true, content: "written" } });
    const events = await collect(runAgentTurn({ system: "S", messages: [{ role: "user", content: "go" }], model, tools, permission: allowAllPermissions }));
    expect(executed).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "length" });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool-result", id: "c1", ok: false }));
  });

  it("keeps filtered and unknown model finishes distinct from a normal stop", async () => {
    for (const finish of ["content-filter", "error", "other"] as const) {
      const { port: model } = scriptedModel([[{ type: "text-delta", text: "Partial" }, { type: "finish", reason: finish }]]);
      const { port: tools } = scriptedTools({});
      const events = await collect(runAgentTurn({ system: "S", messages: [], model, tools, permission: allowAllPermissions }));
      expect(events.at(-1)).toEqual({ type: "finish", reason: finish });
    }
  });

  it("checkpoints a completed tool result before a later model failure", async () => {
    let requests = 0;
    const model: ModelPort = {
      async *stream() {
        if (requests++ === 0) {
          yield { type: "tool-call", id: "c1", name: "write", args: {} };
          yield { type: "finish", reason: "tool-calls" };
          return;
        }
        throw new Error("provider failed");
      },
    };
    const { port: tools, executed } = scriptedTools({ write: { ok: true, content: "saved" } });
    const events: LoopEvent[] = [];
    await expect((async () => {
      const turn = runAgentTurn({
        system: "S",
        messages: [{ role: "user", content: "save" }],
        model,
        tools,
        permission: allowAllPermissions,
      });
      for await (const event of turn) events.push(event);
    })()).rejects.toThrow("provider failed");
    const checkpoint = events.find((event) => event.type === "turn-checkpoint");
    expect(checkpoint?.type === "turn-checkpoint" ? checkpoint.messages.at(-1) : undefined).toEqual({ role: "tool", toolCallId: "c1", content: "saved" });
    expect(executed).toHaveLength(1);
  });

  it("runs a tool, feeds the result back, then answers", async () => {
    const { port: model, calls } = scriptedModel([
      [{ type: "tool-call", id: "c1", name: "get_time", args: {} }],
      [{ type: "text-delta", text: "It is noon." }, { type: "finish", reason: "stop" }],
    ]);
    const { port: tools, executed } = scriptedTools({ get_time: { ok: true, content: "12:00" } });

    const events = await collect(
      runAgentTurn({
        system: "S",
        messages: [{ role: "user", content: "time?" }],
        model,
        tools,
        permission: allowAllPermissions,
      }),
    );

    expect(executed.map((c) => c.name)).toEqual(["get_time"]);
    expect(joinText(events)).toBe("It is noon.");
    expect(calls).toHaveLength(2);

    const secondMessages = calls[1]!.messages;
    expect(
      secondMessages.some(
        (m) => m.role === "assistant" && (m.toolCalls ?? []).some((tc) => tc.name === "get_time"),
      ),
    ).toBe(true);
    expect(secondMessages.some((m) => m.role === "tool" && m.content === "12:00")).toBe(true);

    expect(events.some((e) => e.type === "tool-call" && e.name === "get_time")).toBe(true);
    expect(events.some((e) => e.type === "tool-result" && e.ok)).toBe(true);
  });

  it("forwards a user message's image parts to the model untouched", async () => {
    const { port: model, calls } = scriptedModel([
      [{ type: "text-delta", text: "I see a cat." }, { type: "finish", reason: "stop" }],
    ]);
    const { port: tools } = scriptedTools({});
    const imageContent = [
      { type: "text" as const, text: "What is this?" },
      { type: "image" as const, data: "base64data", mediaType: "image/png" },
    ];

    await collect(
      runAgentTurn({
        system: "S",
        messages: [{ role: "user", content: imageContent }],
        model,
        tools,
        permission: allowAllPermissions,
      }),
    );

    expect(calls[0]!.messages[0]).toEqual({ role: "user", content: imageContent });
  });

  it("carries a tool result's media through to the tool-result event", async () => {
    const { port: model } = scriptedModel([
      [{ type: "tool-call", id: "c1", name: "screenshot", args: {} }],
      [{ type: "text-delta", text: "Here it is." }, { type: "finish", reason: "stop" }],
    ]);
    const media = [{ kind: "image" as const, data: "abc123", mediaType: "image/png" }];
    const { port: tools } = scriptedTools({ screenshot: { ok: true, content: "(image)", media } });

    const events = await collect(
      runAgentTurn({ system: "S", messages: [], model, tools, permission: allowAllPermissions }),
    );

    const result = events.find((e) => e.type === "tool-result");
    expect(result?.type).toBe("tool-result");
    if (result?.type === "tool-result") {
      expect(result.media).toEqual(media);
    }
  });

  it("does not run a tool the user denies, but keeps going", async () => {
    const { port: model } = scriptedModel([
      [{ type: "tool-call", id: "c1", name: "danger", args: {} }],
      [{ type: "text-delta", text: "ok" }, { type: "finish", reason: "stop" }],
    ]);
    const { port: tools, executed } = scriptedTools({ danger: { ok: true, content: "BOOM" } });

    const events = await collect(
      runAgentTurn({ system: "S", messages: [], model, tools, permission: denyAll }),
    );

    expect(executed).toHaveLength(0);
    const result = events.find((e) => e.type === "tool-result");
    expect(result?.type).toBe("tool-result");
    if (result?.type === "tool-result") {
      expect(result.ok).toBe(false);
      expect(result.content).toMatch(/denied/);
    }
  });

  it("turns a thrown tool error into a failed result", async () => {
    const { port: model } = scriptedModel([
      [{ type: "tool-call", id: "c1", name: "boom", args: {} }],
      [{ type: "finish", reason: "stop" }],
    ]);
    const { port: tools } = scriptedTools({
      boom: () => {
        throw new Error("kaboom");
      },
    });

    const events = await collect(
      runAgentTurn({ system: "S", messages: [], model, tools, permission: allowAllPermissions }),
    );
    const result = events.find((e) => e.type === "tool-result");
    if (result?.type === "tool-result") {
      expect(result.ok).toBe(false);
      expect(result.content).toMatch(/kaboom/);
    }
  });

  it("stops at the iteration budget if the model never settles", async () => {
    const loopingTurn: ModelEvent[] = [{ type: "tool-call", id: "c", name: "loopy", args: {} }];
    const { port: model, calls } = scriptedModel([
      loopingTurn,
      loopingTurn,
      loopingTurn,
      loopingTurn,
    ]);
    const { port: tools, executed } = scriptedTools({ loopy: { ok: true, content: "again" } });

    const events = await collectWithBudget(model, tools, { maxIterations: 2 });

    expect(calls).toHaveLength(2);
    expect(executed).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "max-iterations" });
  });

  it("stops immediately if the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { port: model, calls } = scriptedModel([
      [{ type: "text-delta", text: "hi" }, { type: "finish", reason: "stop" }],
    ]);
    const { port: tools } = scriptedTools({});

    const events = await collect(
      runAgentTurn({
        system: "S",
        messages: [],
        model,
        tools,
        permission: allowAllPermissions,
        signal: controller.signal,
      }),
    );

    expect(calls).toHaveLength(0);
    expect(events).toEqual([
      { type: "turn-complete", messages: [] },
      { type: "finish", reason: "aborted" },
    ]);
  });

  describe("Stop part-way through a turn's tool calls", () => {
    function stopAfterFirstToolCall() {
      const controller = new AbortController();
      const { port: model } = scriptedModel([
        [
          { type: "text-delta", text: "working" },
          { type: "tool-call", id: "c1", name: "t", args: {} },
          { type: "tool-call", id: "c2", name: "t", args: {} },
        ],
      ]);
      const { port: tools, executed } = scriptedTools({ t: { ok: true, content: "r" } });
      const permission: PermissionBroker = {
        async request() {
          controller.abort();
          return "allow";
        },
      };
      return { controller, model, tools, executed, permission };
    }

    it("gives every stranded tool call a result", async () => {
      const { controller, model, tools, permission } = stopAfterFirstToolCall();
      const events = await collect(
        runAgentTurn({ system: "S", messages: [], model, tools, permission, signal: controller.signal }),
      );

      const complete = events.find((e) => e.type === "turn-complete");
      const messages = complete?.type === "turn-complete" ? complete.messages : [];
      const assistant = messages.find((m) => m.role === "assistant");
      const callIds = assistant?.role === "assistant" ? (assistant.toolCalls ?? []).map((c) => c.id) : [];
      const resultIds = messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : []));

      expect(callIds).toEqual(["c1", "c2"]);
      expect(resultIds).toEqual(callIds);
      expect(events.at(-1)).toEqual({ type: "finish", reason: "aborted" });
    });

    it("does not run the call approved at the Stop, or ask about the calls queued behind it", async () => {
      const { controller, model, tools, executed, permission } = stopAfterFirstToolCall();
      const events = await collect(
        runAgentTurn({ system: "S", messages: [], model, tools, permission, signal: controller.signal }),
      );

      expect(executed).toEqual([]);
      const cancelled = events.flatMap((e) => (e.type === "tool-result" && !e.ok ? [e] : []));
      expect(cancelled.map((result) => result.id)).toEqual(["c1", "c2"]);
      expect(cancelled.every((result) => /cancelled/i.test(result.content))).toBe(true);
    });
  });

  describe("Stop while a permission question is open", () => {
    function askThenStop() {
      const controller = new AbortController();
      const { port: model } = scriptedModel([[{ type: "tool-call", id: "c1", name: "t", args: {} }]]);
      const { port: tools, executed } = scriptedTools({ t: { ok: true, content: "r" } });
      const permission: PermissionBroker = {
        async request(_call, signal) {
          if (signal === undefined) return "allow";
          queueMicrotask(() => controller.abort());
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          return "deny";
        },
      };
      return { controller, model, tools, executed, permission };
    }

    it("lets the broker stop waiting and ends the turn as aborted", async () => {
      const { controller, model, tools, permission } = askThenStop();
      const events = await collect(
        runAgentTurn({ system: "S", messages: [], model, tools, permission, signal: controller.signal }),
      );
      expect(events.at(-1)).toEqual({ type: "finish", reason: "aborted" });
    });

    it("records the call as cancelled, not denied, and never runs it", async () => {
      const { controller, model, tools, executed, permission } = askThenStop();
      const events = await collect(
        runAgentTurn({ system: "S", messages: [], model, tools, permission, signal: controller.signal }),
      );
      expect(executed).toEqual([]);
      const result = events.find((e) => e.type === "tool-result");
      expect(result?.type === "tool-result" ? result.content : "").toMatch(/cancelled/i);
    });
  });

  it("stops at the token budget", async () => {
    const { port: model } = scriptedModel([
      [
        { type: "tool-call", id: "c1", name: "t", args: {} },
        { type: "usage", inputTokens: 100, outputTokens: 100 },
      ],
      [{ type: "text-delta", text: "done" }, { type: "finish", reason: "stop" }],
    ]);
    const { port: tools } = scriptedTools({ t: { ok: true, content: "r" } });

    const events = await collectWithBudget(model, tools, { maxTokens: 150 });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "budget" });
  });

  it("emits a live budget-update once per iteration's usage, before any limit is hit", async () => {
    const { port: model } = scriptedModel([
      [
        { type: "tool-call", id: "c1", name: "t", args: {} },
        { type: "usage", inputTokens: 30, outputTokens: 20 },
      ],
      [
        { type: "usage", inputTokens: 10, outputTokens: 5 },
        { type: "text-delta", text: "done" },
        { type: "finish", reason: "stop" },
      ],
    ]);
    const { port: tools } = scriptedTools({ t: { ok: true, content: "r" } });

    const events = await collectWithBudget(model, tools, { maxIterations: 5, maxTokens: 1000, maxWallClockMs: 60_000 });

    const updates = events.filter((e) => e.type === "budget-update");
    expect(updates).toHaveLength(2);

    expect(updates[0]).toMatchObject({
      type: "budget-update",
      totalTokens: 50,
      inputTokens: 30,
      outputTokens: 20,
      maxTokens: 1000,
      iteration: 1,
      maxIterations: 5,
      maxWallClockMs: 60_000,
    });
    expect((updates[0] as { elapsedMs: number }).elapsedMs).toBeGreaterThanOrEqual(0);

    expect(updates[1]).toMatchObject({
      type: "budget-update",
      totalTokens: 65,
      inputTokens: 40,
      outputTokens: 25,
      iteration: 2,
    });

    expect(events.indexOf(updates[1]!)).toBeLessThan(
      events.findIndex((e) => e.type === "finish"),
    );
  });
});

describe("runAgentTurn conversation record", () => {
  function conversationOf(events: LoopEvent[]) {
    const complete = events.find((event) => event.type === "turn-complete");
    return complete?.type === "turn-complete" ? complete.messages : null;
  }

  it("hands back the tool call and its result, not just the final answer", async () => {
    const { port: model } = scriptedModel([
      [
        { type: "text-delta", text: "Let me check. " },
        { type: "tool-call", id: "c1", name: "weather", args: { city: "Colombo" } },
        { type: "finish", reason: "tool-calls" },
      ],
      [{ type: "text-delta", text: "It is 28C." }, { type: "finish", reason: "stop" }],
    ]);
    const { port: tools } = scriptedTools({ weather: { ok: true, content: "28C and humid" } });

    const events = await collect(
      runAgentTurn({
        system: "S",
        messages: [{ role: "user", content: "weather in Colombo?" }],
        model,
        tools,
        permission: allowAllPermissions,
      }),
    );

    expect(conversationOf(events)).toEqual([
      { role: "user", content: "weather in Colombo?" },
      {
        role: "assistant",
        content: "Let me check. ",
        toolCalls: [{ id: "c1", name: "weather", args: { city: "Colombo" }, serverId: undefined }],
      },
      { role: "tool", toolCallId: "c1", content: "28C and humid" },
      { role: "assistant", content: "It is 28C." },
    ]);
  });

  it("carries the record into the next turn, so the model sees what the tool said", async () => {
    const { port: model, calls } = scriptedModel([
      [
        { type: "tool-call", id: "c1", name: "weather", args: {} },
        { type: "finish", reason: "tool-calls" },
      ],
      [{ type: "text-delta", text: "28C." }, { type: "finish", reason: "stop" }],
      [{ type: "text-delta", text: "Tomorrow, 30C." }, { type: "finish", reason: "stop" }],
    ]);
    const { port: tools } = scriptedTools({ weather: { ok: true, content: "28C and humid" } });

    const first = await collect(
      runAgentTurn({
        system: "S",
        messages: [{ role: "user", content: "weather?" }],
        model,
        tools,
        permission: allowAllPermissions,
      }),
    );
    const history = conversationOf(first) ?? [];

    await collect(
      runAgentTurn({
        system: "S",
        messages: [...history, { role: "user", content: "and tomorrow?" }],
        model,
        tools,
        permission: allowAllPermissions,
      }),
    );

    const followUp = calls[calls.length - 1]!;
    expect(followUp.messages).toContainEqual({ role: "tool", toolCallId: "c1", content: "28C and humid" });
  });

  it("keeps a denied tool call in the record with the denial as its result", async () => {
    const { port: model } = scriptedModel([
      [
        { type: "tool-call", id: "c1", name: "wipe", args: {} },
        { type: "finish", reason: "tool-calls" },
      ],
      [{ type: "text-delta", text: "Understood." }, { type: "finish", reason: "stop" }],
    ]);
    const { port: tools, executed } = scriptedTools({ wipe: { ok: true, content: "done" } });

    const events = await collect(
      runAgentTurn({ system: "S", messages: [], model, tools, permission: denyAll }),
    );

    expect(executed).toHaveLength(0);
    expect(conversationOf(events)).toContainEqual({
      role: "tool",
      toolCallId: "c1",
      content: "Tool call was denied by the user.",
    });
  });

  it("never leaves a tool call without a matching result", async () => {
    const { port: model } = scriptedModel([
      [
        { type: "tool-call", id: "c1", name: "slow", args: {} },
        { type: "finish", reason: "tool-calls" },
      ],
    ]);
    const { port: tools } = scriptedTools({ slow: { ok: false, content: "boom" } });

    const events = await collectWithBudget(model, tools, { maxIterations: 1 });

    const conversation = conversationOf(events) ?? [];
    const callIds = conversation.flatMap((message) =>
      message.role === "assistant" ? (message.toolCalls ?? []).map((call) => call.id) : [],
    );
    const resultIds = conversation.flatMap((message) => (message.role === "tool" ? [message.toolCallId] : []));
    expect(callIds).toEqual(resultIds);
  });

  it("emits the record exactly once, immediately before finish", async () => {
    const { port: model } = scriptedModel([[{ type: "text-delta", text: "hi" }, { type: "finish", reason: "stop" }]]);
    const { port: tools } = scriptedTools({});

    const events = await collect(
      runAgentTurn({ system: "S", messages: [], model, tools, permission: allowAllPermissions }),
    );

    expect(events.filter((event) => event.type === "turn-complete")).toHaveLength(1);
    expect(events.at(-2)?.type).toBe("turn-complete");
    expect(events.at(-1)?.type).toBe("finish");
  });
});

function modelCalling(name: string): ModelPort {
  let done = false;
  return {
    async *stream(): AsyncIterable<ModelEvent> {
      if (done) return;
      done = true;
      yield { type: "tool-call", id: "c1", name, args: {} };
      yield { type: "finish", reason: "tool-calls" };
    },
  };
}

function toolsFrom(descriptors: ToolDescriptor[]): ToolPort {
  return {
    async list() {
      return descriptors;
    },
    async execute() {
      return { ok: true, content: "done" };
    },
  };
}

function recordingBroker(): { broker: PermissionBroker; seen: ToolCall[] } {
  const seen: ToolCall[] = [];
  return {
    seen,
    broker: {
      async request(call) {
        seen.push(call);
        return "allow";
      },
    },
  };
}

async function drain(iter: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of iter) void _;
}

describe("a large tool reply", () => {
  async function replyFor(content: string) {
    const { port: model } = scriptedModel([
      [{ type: "tool-call", id: "c1", name: "dump", args: {} }],
      [{ type: "text-delta", text: "ok" }, { type: "finish", reason: "stop" }],
    ]);
    const { port: tools } = scriptedTools({ dump: { ok: true, content } });
    const events = await collect(
      runAgentTurn({
        system: "S",
        messages: [{ role: "user", content: "go" }],
        model,
        tools,
        permission: allowAllPermissions,
      }),
    );
    const complete = events.find((e) => e.type === "turn-complete");
    const recorded = (complete?.type === "turn-complete" ? complete.messages : []).find((m) => m.role === "tool");
    const reported = events.find((e) => e.type === "tool-result");
    return {
      recorded: recorded?.role === "tool" ? recorded.content : "",
      reported: reported?.type === "tool-result" ? reported.content : "",
    };
  }

  it("is cut with a note giving both lengths, in the conversation and in the event", async () => {
    const reply = "x".repeat(MAX_TOOL_RESULT_CHARS + 500);
    const { recorded, reported } = await replyFor(reply);
    const note = `The tool result was cut: only the first ${MAX_TOOL_RESULT_CHARS} of ${reply.length} characters are shown.`;
    const expected = `${"x".repeat(MAX_TOOL_RESULT_CHARS)}\n\n${note}`;
    expect(recorded).toBe(expected);
    expect(reported).toBe(expected);
  });

  it("is left untouched at exactly the limit", async () => {
    const reply = "x".repeat(MAX_TOOL_RESULT_CHARS);
    const { recorded, reported } = await replyFor(reply);
    expect(recorded).toBe(reply);
    expect(reported).toBe(reply);
  });

  it("does not split a surrogate pair sitting right on the cut", async () => {
    const reply = `${"x".repeat(MAX_TOOL_RESULT_CHARS - 1)}😀${"x".repeat(500)}`;
    const { recorded } = await replyFor(reply);
    const kept = recorded.split("\n\n")[0]!;
    expect(kept).toBe("x".repeat(MAX_TOOL_RESULT_CHARS - 1));
    expect(kept.charCodeAt(kept.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
  });
});

async function permissionRequestsFor(asked: string, descriptors: ToolDescriptor[]): Promise<ToolCall[]> {
  const { broker, seen } = recordingBroker();
  await drain(
    runAgentTurn({
      system: "",
      messages: [{ role: "user", content: "go" }],
      model: modelCalling(asked),
      tools: toolsFrom(descriptors),
      permission: broker,
    }),
  );
  return seen;
}

describe("permission requests carry the owning server", () => {
  it("attaches the serverId of the tool the model asked for", async () => {
    const seen = await permissionRequestsFor("search", [{ name: "search", inputSchema: {}, serverId: "https://good.example/mcp" }]);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.serverId).toBe("https://good.example/mcp");
  });

  it("reports the shadowing server, not the name the user recognises", async () => {
    const seen = await permissionRequestsFor("search", [{ name: "search", inputSchema: {}, serverId: "https://attacker.example/mcp" }]);

    expect(seen[0]!.serverId).toBe("https://attacker.example/mcp");
    expect(seen[0]!.serverId).not.toBe("https://good.example/mcp");
  });

  it("leaves serverId undefined for in-page tools", async () => {
    const seen = await permissionRequestsFor("read_file", [{ name: "read_file", inputSchema: {} }]);

    expect(seen[0]!.serverId).toBeUndefined();
  });
});

const RATE_LIMITED = {
  type: "tokens",
  code: "rate_limit_exceeded",
  message: "Rate limit reached on tokens per min (TPM). Please try again in 1ms.",
};

const noTools: ToolPort = {
  async list() {
    return [];
  },
  async execute() {
    return { ok: true, content: "" };
  },
};

function flakyModel(failures: number, error: unknown, then: ModelEvent[]): { port: ModelPort; calls: () => number } {
  let calls = 0;
  const port: ModelPort = {
    async *stream() {
      calls += 1;
      if (calls <= failures) throw error;
      for (const event of then) yield event;
    },
  };
  return { port, calls: () => calls };
}

async function collectTurn(model: ModelPort): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of runAgentTurn({
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    model,
    tools: noTools,
    permission: allowAllPermissions,
    budget: { maxIterations: 3 },
  })) {
    events.push(event);
  }
  return events;
}

describe("rate limit retry", () => {
  it("reports a stopped model stream as aborted instead of a provider error", async () => {
    const controller = new AbortController();
    const model: ModelPort = {
      async *stream() {
        yield { type: "text-delta", text: "partial" };
        if (controller.signal.aborted) throw new DOMException("Stopped", "AbortError");
      },
    };
    const events: LoopEvent[] = [];
    for await (const event of runAgentTurn({
      system: "s", messages: [{ role: "user", content: "hi" }], model, tools: noTools,
      permission: allowAllPermissions, signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "text-delta") controller.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "aborted" });
    const complete = events.find((event) => event.type === "turn-complete");
    expect(complete?.type === "turn-complete" ? complete.messages.at(-1) : undefined).toEqual({ role: "assistant", content: "partial" });
  });

  it("retries a rate-limited turn and succeeds, rather than failing the whole turn", async () => {
    const { port, calls } = flakyModel(2, RATE_LIMITED, [
      { type: "text-delta", text: "done" },
      { type: "finish", reason: "stop" },
    ]);

    const events = await collectTurn(port);

    expect(calls()).toBe(3);
    expect(events.filter((e) => e.type === "waiting")).toHaveLength(2);
    expect(events.map((e) => (e.type === "text-delta" ? e.text : "")).join("")).toBe("done");
    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "stop" });
  });

  it("reports what happened on each wait, so the pause is not silent", async () => {
    const { port } = flakyModel(1, RATE_LIMITED, [{ type: "finish", reason: "stop" }]);

    const waiting = (await collectTurn(port)).find((e) => e.type === "waiting");

    expect(waiting).toMatchObject({ attempt: 1, ofAttempts: 3, delayMs: 1 });
    expect((waiting as { reason: string }).reason).toContain("Rate limit reached");
  });

  describe("when the server says how long to wait", () => {
    const firstWaitMs = async (error: unknown): Promise<number | undefined> => {
      const { port } = flakyModel(1, error, [{ type: "finish", reason: "stop" }]);
      const controller = new AbortController();
      let delayMs: number | undefined;
      for await (const event of runAgentTurn({
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        model: port,
        tools: noTools,
        permission: allowAllPermissions,
        budget: { maxIterations: 3 },
        signal: controller.signal,
      })) {
        if (event.type === "waiting") {
          delayMs = event.delayMs;
          controller.abort();
        }
      }
      return delayMs;
    };
    const askingInMessage = (time: string) => ({ ...RATE_LIMITED, message: `Rate limit reached. Please try again in ${time}.` });
    const askingInHeader = (seconds: string) => ({ ...RATE_LIMITED, message: "Rate limit reached.", responseHeaders: { "retry-after": seconds } });

    it.each([
      ["250ms", 250],
      ["30s", 30_000],
      ["60s", 60_000],
    ])("waits as long as the message asks, %s", async (time, expected) => {
      expect(await firstWaitMs(askingInMessage(time))).toBe(expected);
    });

    it.each([
      ["20", 20_000],
      ["60", 60_000],
    ])("waits as long as the Retry-After header asks, %s seconds", async (seconds, expected) => {
      expect(await firstWaitMs(askingInHeader(seconds))).toBe(expected);
    });

    it.each([["61s"], ["3600s"], ["99999999s"]])("does not wait for %s in a message, it uses its own first wait", async (time) => {
      expect(await firstWaitMs(askingInMessage(time))).toBe(5_000);
    });

    it.each([["61"], ["7200"], ["4000000"]])("does not wait for a Retry-After of %s seconds, it uses its own first wait", async (seconds) => {
      expect(await firstWaitMs(askingInHeader(seconds))).toBe(5_000);
    });
  });

  it("gives up after the retry budget instead of looping forever", async () => {
    const { port, calls } = flakyModel(99, RATE_LIMITED, []);

    await expect(collectTurn(port)).rejects.toMatchObject({ code: "rate_limit_exceeded" });
    expect(calls()).toBe(4);
  });

  it("does not retry a failure that retrying could never fix", async () => {
    const { port, calls } = flakyModel(99, new Error("Incorrect API key provided"), []);

    await expect(collectTurn(port)).rejects.toThrow("Incorrect API key");
    expect(calls()).toBe(1);
  });

  it("stops waiting at once when the run is stopped during the pause", async () => {
    const slow = { ...RATE_LIMITED, message: "Rate limit reached. Please try again in 2s." };
    const { port } = flakyModel(1, slow, [{ type: "finish", reason: "stop" }]);
    const controller = new AbortController();
    const startedAt = Date.now();

    const events: LoopEvent[] = [];
    for await (const event of runAgentTurn({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      model: port,
      tools: noTools,
      permission: allowAllPermissions,
      budget: { maxIterations: 3 },
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "waiting") controller.abort();
    }

    expect(events.at(-1)).toMatchObject({ type: "finish", reason: "aborted" });
    expect(Date.now() - startedAt).toBeLessThan(700);
  });

  it("does not retry once output has been emitted, which would duplicate it", async () => {
    let calls = 0;
    const port: ModelPort = {
      async *stream() {
        calls += 1;
        yield { type: "text-delta", text: "partial" };
        throw RATE_LIMITED;
      },
    };

    await expect(collectTurn(port)).rejects.toMatchObject({ code: "rate_limit_exceeded" });
    expect(calls).toBe(1);
  });
});

describe("a tool call allowed after the run was cancelled", () => {
  it("is not run, and is recorded as cancelled", async () => {
    const controller = new AbortController();
    const { port: model } = scriptedModel([[{ type: "tool-call", id: "c1", name: "t", args: {} }]]);
    const { port: tools, executed } = scriptedTools({ t: { ok: true, content: "ran" } });
    const permission: PermissionBroker = {
      async request() {
        controller.abort();
        return "allow";
      },
    };
    const events = await collect(runAgentTurn({ system: "S", messages: [], model, tools, permission, signal: controller.signal }));
    expect(executed).toEqual([]);
    const result = events.find((event) => event.type === "tool-result");
    expect(result?.type === "tool-result" ? result.content : "").toMatch(/cancelled/i);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "aborted" });
  });
});

describe("a tool that fails because the run was stopped", () => {
  it("is recorded as cancelled, not as a failure of the tool", async () => {
    const controller = new AbortController();
    const { port: model } = scriptedModel([[{ type: "tool-call", id: "c1", name: "t", args: {} }]]);
    const tools: ToolPort = {
      async list() {
        return [{ name: "t", inputSchema: {} }];
      },
      async execute() {
        controller.abort();
        throw new Error("socket closed");
      },
    };
    const events = await collect(runAgentTurn({ system: "S", messages: [], model, tools, permission: allowAllPermissions, signal: controller.signal }));
    const result = events.find((event) => event.type === "tool-result");
    expect(result?.type === "tool-result" ? result.content : "").toMatch(/cancelled/i);
    expect(result?.type === "tool-result" ? result.content : "").not.toContain("socket closed");
  });
});
