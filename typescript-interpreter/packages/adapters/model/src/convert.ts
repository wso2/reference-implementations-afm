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

import { jsonSchema, tool } from "ai";
import type { AssistantContent, ModelMessage, TextStreamPart, ToolSet, UserContent } from "ai";
import type { ChatMessage, ContentPart, FinishReason, ModelEvent, ToolDescriptor } from "@afm/engine";

type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;
type ToolMessage = Extract<ChatMessage, { role: "tool" }>;

const FINISH_REASONS: readonly string[] = ["stop", "tool-calls", "length", "content-filter", "error"];

function toUserContent(content: string | ContentPart[]): UserContent {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "image" as const, image: part.data, mediaType: part.mediaType },
  );
}

function toAssistantMessage(message: AssistantMessage): ModelMessage {
  const calls = message.toolCalls;
  if (calls === undefined || calls.length === 0) {
    return { role: "assistant", content: message.content };
  }
  const content: AssistantContent = [];
  if (message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of calls) {
    content.push({ type: "tool-call", toolCallId: call.id, toolName: call.name, input: call.args });
  }
  return { role: "assistant", content };
}

function toToolMessage(message: ToolMessage, toolName: string): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: message.toolCallId,
        toolName,
        output: { type: "text", value: message.content },
      },
    ],
  };
}

function toolNamesByCallId(messages: ChatMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
  }
  return names;
}

export function withoutBlankSystem(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => message.role !== "system" || message.content.trim() !== "");
}

export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const anyCallNames = toolNamesByCallId(messages);
  const earlierCallNames = new Map<string, string>();
  return messages.map((message): ModelMessage => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        return { role: "user", content: toUserContent(message.content) };
      case "assistant":
        for (const call of message.toolCalls ?? []) earlierCallNames.set(call.id, call.name);
        return toAssistantMessage(message);
      case "tool":
        return toToolMessage(message, earlierCallNames.get(message.toolCallId) ?? anyCallNames.get(message.toolCallId) ?? "unknown");
    }
  });
}

export function toToolSet(descriptors: ToolDescriptor[]): ToolSet {
  return Object.fromEntries(
    descriptors.map((descriptor) => [
      descriptor.name,
      tool({
        description: descriptor.description,
        inputSchema: jsonSchema(descriptor.inputSchema as unknown as Parameters<typeof jsonSchema>[0]),
      }),
    ]),
  );
}

function mapFinishReason(reason: string): FinishReason {
  return FINISH_REASONS.includes(reason) ? (reason as FinishReason) : "other";
}

export function modelEventsFromPart(part: TextStreamPart<ToolSet>): ModelEvent[] {
  switch (part.type) {
    case "text-delta":
      return [{ type: "text-delta", text: part.text }];
    case "tool-call":
      return [{ type: "tool-call", id: part.toolCallId, name: part.toolName, args: part.input }];
    case "finish":
      return [
        {
          type: "usage",
          inputTokens: part.totalUsage.inputTokens ?? 0,
          outputTokens: part.totalUsage.outputTokens ?? 0,
        },
        { type: "finish", reason: mapFinishReason(part.finishReason) },
      ];
    default:
      return [];
  }
}
