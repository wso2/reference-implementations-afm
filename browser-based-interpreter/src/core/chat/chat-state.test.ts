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
import { chatReducer, initialChatState, turnsKeptBefore } from "./chat-state";
import type { ServerMessage } from "../runtime/protocol";
import type { ChatState } from "./chat-state";

const loaded = (name: string, mcpServers: string[] = []): ServerMessage => ({
  type: "loaded",
  name,
  mcpServers,
  plan: { runnable: true, issues: [] },
});

describe("chatReducer", () => {
  it("goes connecting -> ready when the agent is loaded, with no check of its own in between", () => {
    let state = chatReducer(initialChatState, { type: "agent-loading", content: "x" });
    expect(state.status).toBe("connecting");
    expect(state.agentSource).toBe("x");
    state = chatReducer(state, { type: "server", message: loaded("Agent A", ["context7"]) });
    expect(state.status).toBe("ready");
    expect(state.agentName).toBe("Agent A");
    expect(state.mcpServers).toEqual(["context7"]);
  });

  it("learns which tools there are after the agent is ready, without changing its state", () => {
    const tools = [{ name: "search", description: "Search", serverId: "https://docs.example.com/mcp" }];
    let state = chatReducer(initialChatState, { type: "server", message: loaded("Agent A") });
    expect(state.tools).toEqual([]);
    state = chatReducer(state, { type: "server", message: { type: "tools-listed", tools } });
    expect(state.status).toBe("ready");
    expect(state.tools).toEqual(tools);
  });

  it("keeps an agent that is answering answering when the tool list arrives", () => {
    let state = chatReducer(initialChatState, { type: "server", message: loaded("A") });
    state = chatReducer(state, { type: "user-message", text: "hi" });
    state = chatReducer(state, { type: "server", message: { type: "tools-listed", tools: [] } });
    expect(state.status).toBe("streaming");
  });

  it("drops a permission question that is still open when the turn finishes", () => {
    let state = chatReducer(initialChatState, { type: "server", message: loaded("A") });
    state = chatReducer(state, { type: "user-message", text: "hi" });
    state = chatReducer(state, {
      type: "server",
      message: { type: "permission-request", id: "c1", name: "lookup", args: {} },
    });
    state = chatReducer(state, { type: "server", message: { type: "turn-finished", reason: "aborted" } });
    expect(state.pendingPermission).toBeNull();
  });

  it("becomes not-ready with a reason", () => {
    const state = chatReducer(initialChatState, {
      type: "server",
      message: { type: "agent-not-ready", reason: "bad file" },
    });
    expect(state.status).toBe("not-ready");
    expect(state.notReady).toBe("bad file");
  });

  it("adds the user message and streams deltas into an assistant message", () => {
    let state = chatReducer(initialChatState, { type: "server", message: loaded("A") });
    state = chatReducer(state, { type: "user-message", text: "hi" });
    expect(state.status).toBe("streaming");
    state = chatReducer(state, { type: "server", message: { type: "text-delta", text: "He" } });
    state = chatReducer(state, { type: "server", message: { type: "text-delta", text: "llo" } });
    state = chatReducer(state, { type: "server", message: { type: "turn-finished", reason: "stop" } });
    expect(state.status).toBe("ready");
    expect(state.messages.map((m) => `${m.kind}:${"text" in m ? m.text : ""}`)).toEqual(["user:hi", "assistant:Hello"]);
  });

  it("rewinds to an earlier message, dropping everything after it", () => {
    let state = chatReducer(initialChatState, { type: "user-message", text: "one" });
    state = chatReducer(state, { type: "server", message: { type: "text-delta", text: "answer" } });
    state = chatReducer(state, { type: "user-message", text: "two" });
    const second = state.messages.find((message) => message.kind === "user" && message.text === "two");
    state = chatReducer(state, { type: "rewind", id: second?.id ?? -1 });
    expect(state.messages.map((message) => message.kind)).toEqual(["user", "assistant"]);
  });

  it("tracks a permission request and clears it on dismiss", () => {
    let state = chatReducer(initialChatState, {
      type: "server",
      message: { type: "permission-request", id: "c1", name: "multiply", args: { a: 2, b: 3 } },
    });
    expect(state.pendingPermission).toEqual({ id: "c1", name: "multiply", args: { a: 2, b: 3 } });
    state = chatReducer(state, { type: "permission-dismissed" });
    expect(state.pendingPermission).toBeNull();
  });

  it("clears a stale permission prompt when the user views a different agent, before it's even loaded", () => {
    let state = chatReducer(initialChatState, {
      type: "server",
      message: { type: "permission-request", id: "c1", name: "multiply", args: {} },
    });
    expect(state.pendingPermission).not.toBeNull();

    state = chatReducer(state, { type: "agent-cleared" });
    expect(state.pendingPermission).toBeNull();
  });

  it("also clears a stale prompt once a different agent actually starts loading", () => {
    let state = chatReducer(initialChatState, {
      type: "server",
      message: { type: "permission-request", id: "c1", name: "multiply", args: {} },
    });
    state = chatReducer(state, { type: "agent-loading", content: "new agent source" });
    expect(state.pendingPermission).toBeNull();
  });

  it("drops a permission question that is still open when an error ends the turn", () => {
    let state = chatReducer(initialChatState, { type: "server", message: loaded("A") });
    state = chatReducer(state, { type: "user-message", text: "hi" });
    state = chatReducer(state, {
      type: "server",
      message: { type: "permission-request", id: "c1", name: "multiply", args: {} },
    });
    state = chatReducer(state, { type: "server", message: { type: "error", message: "boom" } });
    expect(state.status).toBe("ready");
    expect(state.pendingPermission).toBeNull();
  });

  it.each<[string, Parameters<typeof chatReducer>[1]]>([
    ["starts loading", { type: "agent-loading", content: "new" }],
    ["is restored from a saved conversation", { type: "restore-session", messages: [], agentSource: "new" }],
  ])("forgets the name, servers, tools and notes of the agent before, when another agent %s", (_label, action) => {
    const plan = { runnable: true, issues: [{ severity: "warning" as const, code: "x", message: "m" }] };
    let state = chatReducer(initialChatState, { type: "server", message: { type: "loaded", name: "Old", mcpServers: ["docs"], plan } });
    state = chatReducer(state, {
      type: "server",
      message: { type: "tools-listed", tools: [{ name: "search", description: "Search", serverId: "https://docs.example.com/mcp" }] },
    });
    expect(state).toMatchObject({ agentName: "Old", mcpServers: ["docs"], tools: [expect.anything()], planIssues: [expect.anything()] });
    state = chatReducer(state, action);
    expect(state).toMatchObject({ agentName: "", mcpServers: [], planIssues: [], tools: [] });
  });

  it("records an error", () => {
    const state = chatReducer(initialChatState, {
      type: "server",
      message: { type: "error", message: "boom" },
    });
    expect(state.error).toBe("boom");
  });

  it("ends the turn when an error stops it, and lets a rejected command leave the state alone", () => {
    const streaming: ChatState = { ...initialChatState, status: "streaming" };
    expect(chatReducer(streaming, { type: "server", message: { type: "error", message: "boom" } }).status).toBe(
      "ready",
    );
    const rejected = chatReducer(streaming, {
      type: "server",
      message: { type: "rejected", message: "still answering" },
    });
    expect(rejected).toMatchObject({ status: "streaming", error: "still answering" });
    const notReady: ChatState = { ...initialChatState, status: "not-ready", notReady: "no key" };
    expect(
      chatReducer(notReady, { type: "server", message: { type: "rejected", message: "No agent loaded yet." } }),
    ).toMatchObject({
      status: "not-ready",
      notReady: "no key",
    });
  });

  it("remembers which model step each tool call came from, so calls of one step stay together", () => {
    const call = (id: string): ServerMessage => ({ type: "tool-call", id, name: "search", args: {} });
    const usage: ServerMessage = { type: "usage", totalTokens: 1, inputTokens: 1, outputTokens: 0, iteration: 1, maxIterations: 10 };
    let state = chatReducer(initialChatState, { type: "user-message", text: "hi" });
    for (const message of [call("a"), call("b"), usage, call("c")]) state = chatReducer(state, { type: "server", message });
    expect(state.messages.flatMap((message) => (message.kind === "tool" ? [message.step] : []))).toEqual([0, 0, 1]);
  });

  it("adds a tool card on call and fills its result (by call id) when it completes", () => {
    let state = chatReducer(initialChatState, {
      type: "server",
      message: { type: "tool-call", id: "c1", name: "multiply", args: { a: 8, b: 17 } },
    });
    const running = state.messages[0];
    expect(running?.kind).toBe("tool");
    expect(running).toMatchObject({ kind: "tool", callId: "c1", name: "multiply", status: "running" });

    state = chatReducer(state, {
      type: "server",
      message: { type: "tool-result", id: "c1", name: "multiply", ok: true, content: "136" },
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ kind: "tool", status: "ok", result: "136" });
  });

  it("marks a failed tool result", () => {
    let state = chatReducer(initialChatState, {
      type: "server",
      message: { type: "tool-call", id: "c1", name: "boom", args: {} },
    });
    state = chatReducer(state, {
      type: "server",
      message: { type: "tool-result", id: "c1", name: "boom", ok: false, content: "nope" },
    });
    expect(state.messages[0]).toMatchObject({ kind: "tool", status: "failed", result: "nope" });
  });

  it("starts a new assistant message for text that follows a tool card", () => {
    let state = chatReducer(initialChatState, { type: "server", message: loaded("A") });
    state = chatReducer(state, { type: "user-message", text: "q" });
    state = chatReducer(state, { type: "server", message: { type: "tool-call", id: "c1", name: "t", args: {} } });
    state = chatReducer(state, { type: "server", message: { type: "text-delta", text: "answer" } });
    expect(state.messages.map((m) => m.kind)).toEqual(["user", "tool", "assistant"]);
  });

  it("keeps message ids unique (stable React keys)", () => {
    let state = chatReducer(initialChatState, { type: "user-message", text: "a" });
    state = chatReducer(state, { type: "server", message: { type: "text-delta", text: "x" } });
    state = chatReducer(state, { type: "server", message: { type: "turn-finished", reason: "stop" } });
    state = chatReducer(state, { type: "user-message", text: "b" });
    const ids = state.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("load steps", () => {
  const step = (key: string, label: string, state: "active" | "done" | "failed", note?: string) =>
    ({ type: "load-step", key, label, state, note }) as const;

  it("appends each new stage in the order it was reported", () => {
    let s = chatReducer(initialChatState, { type: "server", message: step("file", "Reading", "active") });
    s = chatReducer(s, { type: "server", message: step("model", "Connecting", "active") });
    expect(s.loadSteps.map((x) => x.key)).toEqual(["file", "model"]);
  });

  it("settles a stage in place rather than adding a second entry", () => {
    let s = chatReducer(initialChatState, { type: "server", message: step("file", "Reading", "active") });
    s = chatReducer(s, { type: "server", message: step("model", "Connecting", "active") });
    s = chatReducer(s, { type: "server", message: step("file", "Reading", "done") });
    expect(s.loadSteps.map((x) => x.key)).toEqual(["file", "model"]);
    expect(s.loadSteps[0]?.state).toBe("done");
  });

  it("keeps the failure reason on the stage that failed", () => {
    let s = chatReducer(initialChatState, {
      type: "server",
      message: step("mcp:gitlab", "Connecting to gitlab", "active"),
    });
    s = chatReducer(s, { type: "server", message: step("mcp:gitlab", "Connecting to gitlab", "failed", "401") });
    expect(s.loadSteps[0]).toMatchObject({ state: "failed", note: "401" });
  });

  it("clears the previous run's stages when a new load starts", () => {
    let s = chatReducer(initialChatState, { type: "server", message: step("file", "Reading", "done") });
    s = chatReducer(s, { type: "agent-loading", content: "x" });
    expect(s.loadSteps).toEqual([]);
  });

  it("keeps the stages after a failure so the user can see how far it got", () => {
    let s = chatReducer(initialChatState, { type: "server", message: step("file", "Reading", "done") });
    s = chatReducer(s, { type: "server", message: { type: "agent-not-ready", reason: "boom" } });
    expect(s.status).toBe("not-ready");
    expect(s.loadSteps).toHaveLength(1);
  });
});

describe("how a turn ended", () => {
  const finish = (reason: "stop" | "max-iterations" | "aborted") =>
    ({ type: "server", message: { type: "turn-finished", reason } }) as const;

  const notices = (state: { messages: { kind: string }[] }) => state.messages.filter((m) => m.kind === "notice");

  it("says nothing extra when the agent simply finished", () => {
    const s = chatReducer(initialChatState, finish("stop"));
    expect(s.status).toBe("ready");
    expect(notices(s)).toHaveLength(0);
  });

  it("keeps a completed tool checkpoint available after an iteration limit", () => {
    let state = chatReducer(initialChatState, { type: "user-message", text: "Save this" });
    state = chatReducer(state, { type: "server", message: { type: "tool-call", id: "c1", name: "save", args: {} } });
    state = chatReducer(state, {
      type: "server",
      message: { type: "tool-result", id: "c1", name: "save", ok: true, content: "saved" },
    });
    state = chatReducer(state, { type: "server", message: { type: "resume-available" } });
    state = chatReducer(state, {
      type: "server",
      message: { type: "turn-finished", reason: "max-iterations", canContinue: true },
    });
    expect(state.canContinue).toBe(true);
    state = chatReducer(state, { type: "continue-start" });
    expect(state.messages.map((message) => message.kind)).toEqual(["user", "tool"]);
    state = chatReducer(state, { type: "server", message: { type: "turn-finished", reason: "stop" } });
    expect(state.canContinue).toBe(false);
  });

  it("warns that the answer may be unfinished when the iteration limit was hit", () => {
    const s = chatReducer(initialChatState, finish("max-iterations"));
    expect(s.status).toBe("ready");
    expect(notices(s)).toHaveLength(1);
    expect(notices(s)[0]).toMatchObject({ text: expect.stringContaining("max_iterations") });
  });

  it("names the limit it hit once the usage is known", () => {
    let s = chatReducer(initialChatState, {
      type: "server",
      message: {
        type: "usage",
        totalTokens: 1,
        inputTokens: 1,
        outputTokens: 0,
        iteration: 10,
        maxIterations: 10,
      },
    });
    s = chatReducer(s, finish("max-iterations"));
    expect(notices(s)[0]).toMatchObject({ text: expect.stringContaining("10 steps") });
  });

  it("confirms a Stop", () => {
    expect(notices(chatReducer(initialChatState, finish("aborted")))[0]).toMatchObject({
      text: expect.stringContaining("Stopped"),
    });
  });
});

describe("a start that fails", () => {
  it("keeps the steps that passed and marks the one that broke", () => {
    let s = chatReducer(initialChatState, { type: "agent-loading", content: "x" });
    s = chatReducer(s, {
      type: "server",
      message: { type: "load-step", key: "file", label: "Reading the agent file", state: "done" },
    });
    s = chatReducer(s, {
      type: "server",
      message: {
        type: "load-step",
        key: "model",
        label: "Connecting to anthropic",
        state: "failed",
        note: "401 Unauthorized",
      },
    });
    s = chatReducer(s, { type: "server", message: { type: "agent-not-ready", reason: "401 Unauthorized" } });

    expect(s.status).toBe("not-ready");
    expect(s.notReady).toBe("401 Unauthorized");
    expect(s.loadSteps.map((x) => `${x.key}:${x.state}`)).toEqual(["file:done", "model:failed"]);
    expect(s.loadSteps[1]?.note).toBe("401 Unauthorized");
  });

  it("clears the previous failure when the agent is started again", () => {
    let s = chatReducer(initialChatState, { type: "server", message: { type: "agent-not-ready", reason: "boom" } });
    s = chatReducer(s, { type: "agent-loading", content: "x" });
    expect(s.notReady).toBeNull();
    expect(s.loadSteps).toEqual([]);
    expect(s.status).toBe("connecting");
  });
});

describe("the saved keys", () => {
  it("keep their names across an agent switch, so switching files does not lose a key", () => {
    let state = chatReducer(initialChatState, {
      type: "server",
      message: { type: "secrets-list", names: ["OPENAI_API_KEY"] },
    });
    state = chatReducer(state, { type: "agent-cleared" });
    expect(state.savedSecrets).toEqual(["OPENAI_API_KEY"]);
  });
});

describe("usage", () => {
  it("keeps the latest tokens and steps used, and forgets them when a new turn starts", () => {
    let state = chatReducer(initialChatState, {
      type: "server",
      message: { type: "usage", totalTokens: 260_000, inputTokens: 250_000, outputTokens: 10_000, iteration: 2, maxIterations: 10 },
    });
    expect(state.usage).toEqual({ totalTokens: 260_000, inputTokens: 250_000, outputTokens: 10_000, iteration: 2, maxIterations: 10 });
    state = chatReducer(state, { type: "user-message", text: "next" });
    expect(state.usage).toBeNull();
  });
});

describe("a reply that fails", () => {
  const start = (): ChatState => {
    let state = chatReducer(initialChatState, { type: "server", message: loaded("Agent A") });
    state = chatReducer(state, { type: "user-message", text: "first question" });
    state = chatReducer(state, { type: "server", message: { type: "text-delta", text: "first answer" } });
    state = chatReducer(state, { type: "server", message: { type: "turn-finished", reason: "stop" } });
    state = chatReducer(state, { type: "user-message", text: "second question" });
    state = chatReducer(state, { type: "server", message: { type: "text-delta", text: "half an ans" } });
    return chatReducer(state, { type: "server", message: { type: "error", message: "401 Unauthorized" } });
  };

  it("keeps the conversation, remembers why, and lets the person type again", () => {
    const state = start();
    expect(state.error).toBe("401 Unauthorized");
    expect(state.status).toBe("ready");
    expect(state.messages.map((message) => message.kind)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("is retried by dropping what the failed turn wrote and keeping the question", () => {
    const state = chatReducer(start(), { type: "regenerate-start" });
    expect(state.error).toBeNull();
    expect(state.status).toBe("streaming");
    expect(state.messages.map((message) => (message.kind === "user" ? message.text : message.kind))).toEqual([
      "first question",
      "assistant",
      "second question",
    ]);
  });

  it("is forgotten when the person asks something new", () => {
    const state = chatReducer(start(), { type: "user-message", text: "third question" });
    expect(state.error).toBeNull();
  });
});

describe("the questions the worker never kept", () => {
  const asked = (): ChatState => {
    let state = chatReducer(initialChatState, { type: "user-message", text: "one" });
    state = chatReducer(state, { type: "server", message: { type: "text-delta", text: "a" } });
    state = chatReducer(state, { type: "server", message: { type: "turn-finished", reason: "stop" } });
    return chatReducer(state, { type: "user-message", text: "two" });
  };
  const failed = (kept: boolean) =>
    chatReducer(asked(), { type: "server", message: { type: "error", message: "boom", kept } });
  const secondId = () => asked().messages.filter((message) => message.kind === "user")[1]!.id;

  it("marks the question of a turn that failed before anything was kept", () => {
    expect(failed(false).unsent).toEqual([secondId()]);
  });

  it("does not mark it when the worker kept the turn, or says nothing", () => {
    expect(failed(true).unsent).toEqual([]);
    expect(chatReducer(asked(), { type: "server", message: { type: "error", message: "boom" } }).unsent).toEqual([]);
  });

  it("forgets the mark once the same question is answered", () => {
    const answered = chatReducer(failed(false), { type: "server", message: { type: "turn-finished", reason: "stop" } });
    expect(answered.unsent).toEqual([]);
  });

  it("counts only the questions the worker holds before the one being edited", () => {
    let state = failed(false);
    state = chatReducer(state, { type: "user-message", text: "three" });
    const ids = state.messages.filter((message) => message.kind === "user").map((message) => message.id);
    expect(turnsKeptBefore(state, ids[2]!)).toBe(1);
    expect(turnsKeptBefore(state, ids[1]!)).toBe(1);
    expect(turnsKeptBefore(state, ids[0]!)).toBe(0);
  });

  it("drops the marks from an edited question onward", () => {
    expect(chatReducer(failed(false), { type: "rewind", id: secondId() }).unsent).toEqual([]);
  });

  it("marks every earlier question when the conversation is resumed under a changed agent", () => {
    const messages = asked().messages;
    const resumed = chatReducer(initialChatState, {
      type: "restore-session",
      messages,
      agentSource: "x",
      unseen: true,
    });
    expect(resumed.unsent).toHaveLength(2);
    expect(chatReducer(initialChatState, { type: "restore-session", messages, agentSource: "x" }).unsent).toEqual([]);
  });
});
