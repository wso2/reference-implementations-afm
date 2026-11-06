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

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type AgentStatus, initialChatState } from "../../core/chat/chat-state";
import { ChatPane, headerStatus } from "./ChatPane";

type Session = Parameters<typeof ChatPane>[0]["session"];

function chat(status: AgentStatus): string {
  const noop = () => {};
  const session = {
    state: { ...initialChatState, status },
    send: noop,
    stop: noop,
    attachFiles: noop,
    detachFile: noop,
    regenerate: noop,
    editMessage: noop,
    submitPermission: noop,
  } as unknown as Session;
  return renderToStaticMarkup(
    createElement(ChatPane, { session, serverNameByUrl: new Map(), onReplaceKey: noop, onRetry: noop }),
  );
}

describe("the message box before an agent is ready", () => {
  it("owns the no-agent presentation instead of the disconnected Test prompt", () => {
    const html = chat("no-agent");
    expect(html).toContain("Not started yet");
    expect(html).toContain("Press <strong>Run</strong>");
    expect(html).not.toContain("Not tested yet");
    expect(html).not.toContain("Test this agent");
  });

  it.each([
    ["no-agent", "Press Run to start…"],
    ["connecting", "Loading the agent…"],
    ["not-ready", "The agent didn&#x27;t start…"],
  ] as const)("says what is going on while the agent is %s", (status, placeholder) => {
    const html = chat(status);
    expect(html).toContain(`placeholder="${placeholder}"`);
    expect(html).toContain("disabled");
  });

  it("never falls back to asking for an agent once one exists", () => {
    for (const status of ["connecting", "not-ready", "ready"] as const) {
      expect(chat(status)).not.toContain("Load an agent first");
    }
  });

  it("invites a message once the agent is ready", () => {
    expect(chat("ready")).toContain('placeholder="Message the agent…"');
  });
});

describe("headerStatus", () => {
  it("says nothing before the agent has started", () => {
    expect(headerStatus("no-agent", "idle")).toBeNull();
  });

  it("describes the agent while it is idle", () => {
    expect(headerStatus("ready", "idle")).toEqual({ tone: "ok", label: "Ready" });
    expect(headerStatus("connecting", "idle")?.label).toBe("Starting");
    expect(headerStatus("not-ready", "idle")?.tone).toBe("bad");
  });

  it("says it is waiting for an answer while a tool asks, even though it is streaming", () => {
    expect(headerStatus("streaming", "tool", "linear", true)).toEqual({ tone: "warn", label: "Waiting for your answer" });
    expect(headerStatus("streaming", "tool", "linear", false)?.label).toBe("Using Linear");
  });

  it("names the server while one of its tools runs", () => {
    expect(headerStatus("streaming", "tool", "huggingface")).toEqual({ tone: "warn", label: "Using Huggingface" });
    expect(headerStatus("streaming", "tool")?.label).toBe("Using a tool");
  });

  it("says what the model is doing around a tool call", () => {
    expect(headerStatus("streaming", "thinking")?.label).toBe("Thinking");
    expect(headerStatus("streaming", "from-tool")?.label).toBe("Thinking");
    expect(headerStatus("streaming", "answering")?.label).toBe("Answering");
  });
});
