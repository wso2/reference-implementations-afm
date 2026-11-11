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
import { reportedActivity, legAfter } from "./agent-activity";
import { initialChatState } from "./chat-state";
import type { ChatState, UiMessage } from "./chat-state";
import type { ToolInfo } from "../runtime/protocol";

const TOOLS: ToolInfo[] = [
  { name: "web_search", description: "", serverId: "https://exa.example/mcp" },
  { name: "get_issue", description: "", serverId: "https://gitlab.example/mcp" },
];

function state(over: Partial<ChatState>): ChatState {
  return { ...initialChatState, ...over };
}

const user: UiMessage = { kind: "user", id: 1, text: "hello" };
const tool = (name: string, status: "running" | "ok" | "failed"): UiMessage => ({
  kind: "tool",
  id: 2,
  callId: "c",
  name,
  args: {},
  status,
});

describe("what the diagram is allowed to light up", () => {
  it("stays dark when the agent is not running", () => {
    expect(reportedActivity(state({}), TOOLS).phase).toBe("idle");
    expect(reportedActivity(state({ status: "ready", messages: [user] }), TOOLS).phase).toBe("idle");
  });

  it("shows thinking while a reply has been asked for but nothing has come back", () => {
    expect(reportedActivity(state({ status: "streaming", messages: [user] }), TOOLS).phase).toBe("thinking");
  });

  it("shows answering once words are actually arriving", () => {
    const messages: UiMessage[] = [user, { kind: "assistant", id: 2, text: "Well," }];
    expect(reportedActivity(state({ status: "streaming", messages }), TOOLS).phase).toBe("answering");
  });

  it("does not call an empty assistant message an answer", () => {
    const messages: UiMessage[] = [user, { kind: "assistant", id: 2, text: "" }];
    expect(reportedActivity(state({ status: "streaming", messages }), TOOLS).phase).toBe("thinking");
  });

  it("names the server the running tool belongs to", () => {
    const messages = [user, tool("get_issue", "running")];
    const activity = reportedActivity(state({ status: "streaming", messages, tools: TOOLS }), TOOLS);
    expect(activity.phase).toBe("tool");
    expect(activity.serverId).toBe("https://gitlab.example/mcp");
  });

  it("goes back to thinking once the tool has answered", () => {
    const messages = [user, tool("get_issue", "ok")];
    expect(reportedActivity(state({ status: "streaming", messages }), TOOLS).phase).toBe("thinking");
  });

  it("does not let a tool left running in an earlier turn decide what this turn is doing", () => {
    const messages: UiMessage[] = [user, tool("get_issue", "running"), { kind: "user", id: 9, text: "again" }];
    expect(reportedActivity(state({ status: "streaming", messages, tools: TOOLS }), TOOLS).phase).toBe("thinking");
  });

  it("lights nothing for a tool it cannot place", () => {
    const messages = [user, tool("mystery", "running")];
    const activity = reportedActivity(state({ status: "streaming", messages }), TOOLS);
    expect(activity.phase).toBe("tool");
    expect(activity.serverId).toBeUndefined();
  });

  it("treats starting up as thinking, since that is what it is", () => {
    expect(reportedActivity(state({ status: "connecting" }), TOOLS).phase).toBe("thinking");
  });
});

describe("the round trip", () => {
  it("brings the model's reply back before the tool starts", () => {
    expect(legAfter({ phase: "thinking" }, { phase: "tool", serverId: "a" }, false)).toEqual({ phase: "from-model" });
  });

  it("brings the tool's result back before the model is asked again", () => {
    expect(legAfter({ phase: "tool", serverId: "a" }, { phase: "thinking" }, false)).toEqual({
      phase: "from-tool",
      serverId: "a",
    });
  });

  it("brings the result back from the server being left, not the one being entered", () => {
    expect(legAfter({ phase: "tool", serverId: "a" }, { phase: "tool", serverId: "b" }, false)).toEqual({
      phase: "from-tool",
      serverId: "a",
    });
  });

  it("draws nothing while the same tool is still running", () => {
    expect(legAfter({ phase: "tool", serverId: "a" }, { phase: "tool", serverId: "a" }, false)).toBeNull();
  });

  it("draws nothing once the run has stopped", () => {
    expect(legAfter({ phase: "tool", serverId: "a" }, { phase: "idle" }, false)).toBeNull();
  });

  it("draws nothing for a server it could not place", () => {
    expect(legAfter({ phase: "tool" }, { phase: "thinking" }, false)).toBeNull();
  });

  it("shows a new message arriving whatever was happening before", () => {
    expect(legAfter({ phase: "answering" }, { phase: "thinking" }, true)).toEqual({ phase: "incoming" });
  });
});

describe("which line broke", () => {
  it("breaks the line of the server whose tool failed, and only that one", () => {
    const messages = [user, tool("get_issue", "failed")];
    const activity = reportedActivity(state({ status: "ready", messages }), TOOLS);
    expect(activity.brokenServerIds).toEqual(["https://gitlab.example/mcp"]);
    expect(activity.modelBroken).toBe(false);
  });

  it("keeps the line whole when only some of a server's calls failed", () => {
    const messages = [user, tool("get_issue", "ok"), tool("get_issue", "failed"), tool("get_issue", "ok")];
    const activity = reportedActivity(state({ status: "ready", messages }), TOOLS);
    expect(activity.brokenServerIds).toEqual([]);
  });

  it("breaks the line once every call to the server failed", () => {
    const messages = [user, tool("get_issue", "failed"), tool("get_issue", "failed")];
    const activity = reportedActivity(state({ status: "ready", messages }), TOOLS);
    expect(activity.brokenServerIds).toEqual(["https://gitlab.example/mcp"]);
  });

  it("does not break the line while another call to the server is still running", () => {
    const messages = [user, tool("get_issue", "failed"), tool("get_issue", "running")];
    expect(reportedActivity(state({ status: "streaming", messages }), TOOLS).brokenServerIds).toEqual([]);
  });

  it("judges each server on its own calls", () => {
    const messages = [user, tool("get_issue", "ok"), tool("get_issue", "failed"), tool("web_search", "failed")];
    const activity = reportedActivity(state({ status: "ready", messages }), TOOLS);
    expect(activity.brokenServerIds).toEqual(["https://exa.example/mcp"]);
  });

  it("does not blame the model for a turn that ended after a failed tool call", () => {
    const messages = [user, tool("get_issue", "ok"), tool("get_issue", "failed")];
    const activity = reportedActivity(state({ messages, error: "tool call failed" }), TOOLS);
    expect(activity.modelBroken).toBe(false);
  });

  it("blames the model when the turn died and no tool did", () => {
    const activity = reportedActivity(state({ messages: [user], error: "rate limited" }), TOOLS);
    expect(activity.modelBroken).toBe(true);
    expect(activity.brokenServerIds).toEqual([]);
  });

  it("does not blame the model for a command that was turned down while it is still answering", () => {
    const activity = reportedActivity(state({ status: "streaming", messages: [user], error: "still answering" }), TOOLS);
    expect(activity.modelBroken).toBe(false);
  });

  it("blames the tool that failed rather than the model that reported it", () => {
    const messages = [user, tool("get_issue", "failed")];
    const activity = reportedActivity(state({ messages, error: "tool call failed" }), TOOLS);
    expect(activity.modelBroken).toBe(false);
    expect(activity.brokenServerIds).toEqual(["https://gitlab.example/mcp"]);
  });

  it("forgets a break from an earlier turn", () => {
    const messages: UiMessage[] = [user, tool("get_issue", "failed"), { kind: "user", id: 9, text: "again" }];
    expect(reportedActivity(state({ messages }), TOOLS).brokenServerIds).toEqual([]);
  });

  it("shows no break before anything has been asked", () => {
    const activity = reportedActivity(state({ error: "could not start" }), TOOLS);
    expect(activity.modelBroken).toBe(false);
  });
});
