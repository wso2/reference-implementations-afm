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
import type { TextStreamPart, ToolSet } from "ai";
import type { ChatMessage, ToolDescriptor } from "@afm/engine";
import { modelEventsFromPart, toModelMessages, toToolSet, withoutBlankSystem } from "./convert";

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

  it("preserves the content-filter finish reason", () => {
    const part = {
      type: "finish",
      finishReason: "content-filter",
      rawFinishReason: "x",
      totalUsage: { inputTokens: 10, outputTokens: 5 },
    } as unknown as TextStreamPart<ToolSet>;
    expect(modelEventsFromPart(part)).toEqual([
      { type: "usage", inputTokens: 10, outputTokens: 5 },
      { type: "finish", reason: "content-filter" },
    ]);
  });

  it("treats unknown finish reasons as incomplete", () => {
    const part = { type: "finish", finishReason: "surprise", totalUsage: { inputTokens: 0, outputTokens: 0 } } as unknown as TextStreamPart<ToolSet>;
    expect(modelEventsFromPart(part).at(-1)).toEqual({ type: "finish", reason: "other" });
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

describe("a tool result whose call id was used more than once", () => {
  const call = (id: string, name: string): ChatMessage => ({ role: "assistant", content: "", toolCalls: [{ id, name, args: {} }] });
  const result = (id: string, content: string): ChatMessage => ({ role: "tool", toolCallId: id, content });
  const toolNameOf = (message: unknown) => {
    const part = (message as { content: Array<{ toolName: string }> }).content[0];
    return part?.toolName;
  };

  it("is named after the nearest earlier call with that id", () => {
    const converted = toModelMessages([call("x", "search"), result("x", "found"), call("x", "write"), result("x", "saved")]);
    expect(converted.filter((message) => message.role === "tool").map(toolNameOf)).toEqual(["search", "write"]);
  });

  it("still takes the name from a later call when no earlier one exists, and says unknown when there is none", () => {
    const converted = toModelMessages([result("x", "early"), call("x", "search"), result("y", "orphan")]);
    expect(converted.filter((message) => message.role === "tool").map(toolNameOf)).toEqual(["search", "unknown"]);
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

describe("withoutBlankSystem", () => {
  it("drops system messages with no text, however much white space they hold", () => {
    const kept = withoutBlankSystem([
      { role: "system", content: "" },
      { role: "system", content: " \n " },
      { role: "system", content: "Be brief." },
      { role: "user", content: "" },
    ]);
    expect(kept).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "" },
    ]);
  });
});

describe("a tool named __proto__", () => {
  it("is offered like any other tool", () => {
    const tools = toToolSet([{ name: "__proto__", inputSchema: { type: "object" } }]);
    expect(Object.keys(tools)).toEqual(["__proto__"]);
  });
});
