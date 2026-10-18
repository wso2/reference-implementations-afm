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

import { streamText, tool, jsonSchema } from "ai";
import type { LanguageModel, ModelMessage, AssistantContent, UserContent, TextStreamPart, ToolSet } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ModelPort, ModelRequest, ModelEvent, ChatMessage, ContentPart, ToolDescriptor } from "@afm/engine";

export interface ModelOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
}

export function createOpenAIModel(options: ModelOptions): ModelPort {
  const provider = createOpenAI({ apiKey: options.apiKey, fetch: options.fetch });
  return streamingModelPort(provider(options.model ?? "gpt-4o"));
}

export function createAnthropicModel(options: ModelOptions): ModelPort {
  const provider = createAnthropic({
    apiKey: options.apiKey,
    headers: { "anthropic-dangerous-direct-browser-access": "true" },
    fetch: options.fetch,
  });
  return streamingModelPort(provider(options.model ?? "claude-sonnet-4-5"));
}

export type KeyCheck = { ok: true } | { ok: false; status: number | null };

const KEY_CHECKS = {
  openai: (apiKey: string) => ({
    url: "https://api.openai.com/v1/models",
    headers: { authorization: `Bearer ${apiKey}` },
  }),
  anthropic: (apiKey: string) => ({
    url: "https://api.anthropic.com/v1/models?limit=1",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
  }),
};

const KEY_CHECK_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT = 408;

export async function checkModelKey(
  provider: keyof typeof KEY_CHECKS,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<KeyCheck> {
  const { url, headers } = KEY_CHECKS[provider](apiKey);
  try {
    const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS) });
    return response.ok ? { ok: true } : { ok: false, status: response.status };
  } catch (error) {
    return { ok: false, status: error instanceof DOMException && error.name === "TimeoutError" ? REQUEST_TIMEOUT : null };
  }
}

function streamingModelPort(model: LanguageModel): ModelPort {
  return {
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const tools = toToolSet(request.tools);
      const result = streamText({
        model,
        system: request.system.trim() === "" ? undefined : request.system,
        messages: toModelMessages(request.messages),
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        abortSignal: signal,
      });

      for await (const part of result.fullStream) {
        if (part.type === "error") {
          throw part.error;
        }
        yield* modelEventsFromPart(part);
      }
    },
  };
}

function toUserContent(content: string | ContentPart[]): UserContent {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "image" as const, image: part.data, mediaType: part.mediaType },
  );
}

export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const nameByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls) {
      for (const call of message.toolCalls) {
        nameByCallId.set(call.id, call.name);
      }
    }
  }

  const out: ModelMessage[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: message.content });
        break;
      case "user":
        out.push({ role: "user", content: toUserContent(message.content) });
        break;
      case "assistant": {
        if (message.toolCalls && message.toolCalls.length > 0) {
          const content: AssistantContent = [];
          if (message.content) {
            content.push({ type: "text", text: message.content });
          }
          for (const call of message.toolCalls) {
            content.push({
              type: "tool-call",
              toolCallId: call.id,
              toolName: call.name,
              input: call.args,
            });
          }
          out.push({ role: "assistant", content });
        } else {
          out.push({ role: "assistant", content: message.content });
        }
        break;
      }
      case "tool":
        out.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: nameByCallId.get(message.toolCallId) ?? "unknown",
              output: { type: "text", value: message.content },
            },
          ],
        });
        break;
    }
  }
  return out;
}

export function toToolSet(descriptors: ToolDescriptor[]): ToolSet {
  const tools: ToolSet = {};
  for (const descriptor of descriptors) {
    tools[descriptor.name] = tool({
      description: descriptor.description,
      inputSchema: jsonSchema(
        descriptor.inputSchema as unknown as Parameters<typeof jsonSchema>[0],
      ),
    });
  }
  return tools;
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

function mapFinishReason(reason: string): "stop" | "tool-calls" | "length" {
  if (reason === "tool-calls") return "tool-calls";
  if (reason === "length") return "length";
  return "stop";
}
