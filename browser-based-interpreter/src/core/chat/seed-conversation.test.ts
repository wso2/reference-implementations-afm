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
import type { UiMessage } from "./chat-state";
import { toSeededConversation } from "./seed-conversation";

describe("toSeededConversation", () => {
  function tool(id: number, callId: string, name: string, result?: string): UiMessage {
    return { kind: "tool", id, callId, name, args: { q: 1 }, status: result === undefined ? "running" : "ok", result };
  }

  it("pairs plain user and assistant messages", () => {
    expect(
      toSeededConversation([
        { kind: "user", id: 1, text: "hi" },
        { kind: "assistant", id: 2, text: "hello" },
      ]),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("rebuilds a user message with an attached image as text + image parts", () => {
    expect(
      toSeededConversation([
        {
          kind: "user",
          id: 1,
          text: "what is this?",
          images: [{ name: "shot.png", mediaType: "image/png", data: "b64" }],
        },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", image: "b64", mediaType: "image/png" },
        ],
      },
    ]);
  });

  it("drops the empty text part when an image was sent with no caption", () => {
    expect(
      toSeededConversation([
        { kind: "user", id: 1, text: "", images: [{ name: "shot.png", mediaType: "image/png", data: "b64" }] },
      ]),
    ).toEqual([{ role: "user", content: [{ type: "image", image: "b64", mediaType: "image/png" }] }]);
  });

  it("reattaches tool calls to the assistant turn that made them, with their results", () => {
    expect(
      toSeededConversation([
        { kind: "user", id: 1, text: "weather?" },
        { kind: "assistant", id: 2, text: "Let me check. " },
        tool(3, "c1", "weather", "28C"),
        { kind: "assistant", id: 4, text: "It is 28C." },
      ]),
    ).toEqual([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check. " },
          { type: "tool-call", toolCallId: "c1", toolName: "weather", input: { q: 1 } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "weather", output: { type: "text", value: "28C" } }],
      },
      { role: "assistant", content: "It is 28C." },
    ]);
  });

  it("handles a tool called with no preamble text", () => {
    expect(
      toSeededConversation([
        { kind: "user", id: 1, text: "go" },
        tool(2, "c1", "run", "done"),
        { kind: "assistant", id: 3, text: "Finished." },
      ]),
    ).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "run", input: { q: 1 } }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "run", output: { type: "text", value: "done" } }],
      },
      { role: "assistant", content: "Finished." },
    ]);
  });

  it("groups parallel tool calls onto one assistant turn", () => {
    const conversation = toSeededConversation([
      { kind: "user", id: 1, text: "both" },
      tool(2, "c1", "a", "ra"),
      tool(3, "c2", "b", "rb"),
      { kind: "assistant", id: 4, text: "Both done." },
    ]);
    const assistant = conversation.find((m) => m.role === "assistant");
    expect(assistant).toMatchObject({ content: [{ toolCallId: "c1" }, { toolCallId: "c2" }] });
    expect(conversation.filter((m) => m.role === "tool").flatMap((m) => m.content)).toHaveLength(2);
  });

  it("never leaves a tool call without a result, even one still running when stored", () => {
    const conversation = toSeededConversation([{ kind: "user", id: 1, text: "go" }, tool(2, "c1", "slow")]);
    const callIds = conversation.flatMap((m) =>
      m.role === "assistant" && Array.isArray(m.content) ? m.content.flatMap((p) => (p.type === "tool-call" ? [p.toolCallId] : [])) : [],
    );
    const resultIds = conversation.flatMap((m) =>
      m.role === "tool" ? m.content.flatMap((p) => (p.type === "tool-result" ? [p.toolCallId] : [])) : [],
    );
    expect(callIds).toEqual(resultIds);
  });

  it("ignores notice rows, which the model never saw", () => {
    expect(
      toSeededConversation([
        { kind: "user", id: 2, text: "hi" },
        { kind: "notice", id: 3, text: "rate limited" },
        { kind: "assistant", id: 4, text: "hello" },
      ]),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("returns nothing for an empty conversation", () => {
    expect(toSeededConversation([])).toEqual([]);
  });
});
