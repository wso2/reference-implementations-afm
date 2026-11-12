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

import type { LanguageModel } from "@afm/runtime";
import { MockLanguageModelV3 } from "ai/test";

export type FakeEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "finish"; reason: string };

export interface FakeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  toolCalls?: { id: string; name: string; args: unknown }[];
  toolCallId?: string;
}

export interface FakeRequest {
  system: string;
  messages: FakeMessage[];
  tools: { name: string; description?: string; inputSchema: unknown }[];
}

export interface FakeModel {
  stream(request: FakeRequest, signal: AbortSignal): AsyncIterable<FakeEvent>;
}

type Part = { type: string; [key: string]: unknown };

function fakeMessages(prompt: { role: string; content: unknown }[]): FakeMessage[] {
  return prompt
    .filter((message) => message.role !== "system")
    .flatMap((message): FakeMessage[] => {
      const parts = (typeof message.content === "string" ? [] : message.content) as Part[];
      if (message.role === "user") {
        const only = parts.length === 1 && parts[0]?.type === "text";
        return [
          {
            role: "user",
            content: only
              ? parts[0]?.text
              : parts.map((part) =>
                  part.type === "text" ? { type: "text", text: part.text } : { type: "image", data: part.data, mediaType: part.mediaType },
                ),
          },
        ];
      }
      if (message.role === "assistant") {
        const calls = parts.filter((part) => part.type === "tool-call").map((part) => ({ id: part.toolCallId as string, name: part.toolName as string, args: part.input }));
        const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("");
        return [{ role: "assistant", content: text, ...(calls.length > 0 ? { toolCalls: calls } : {}) }];
      }
      return parts.map((part) => ({
        role: "tool" as const,
        toolCallId: part.toolCallId as string,
        content: (part.output as { value?: unknown } | undefined)?.value,
      }));
    });
}

export function modelOf(port: FakeModel): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async (options) => {
      const prompt = options.prompt as unknown as { role: string; content: unknown }[];
      const system = prompt.find((message) => message.role === "system")?.content;
      const request: FakeRequest = {
        system: typeof system === "string" ? system : "",
        messages: fakeMessages(prompt),
        tools: (options.tools ?? []).map((tool) => ({ name: tool.name, description: (tool as { description?: string }).description, inputSchema: (tool as { inputSchema?: unknown }).inputSchema })),
      };
      const iterator = port.stream(request, options.abortSignal ?? new AbortController().signal)[Symbol.asyncIterator]();
      let first = await iterator.next();
      let usage = { inputTokens: { total: 0 }, outputTokens: { total: 0 } };
      let finished = false;
      let id = 0;
      const chunksOf = (event: FakeEvent): Record<string, unknown>[] => {
        switch (event.type) {
          case "text-delta": {
            id += 1;
            return [{ type: "text-start", id: `t${id}` }, { type: "text-delta", id: `t${id}`, delta: event.text }, { type: "text-end", id: `t${id}` }];
          }
          case "tool-call":
            return [{ type: "tool-call", toolCallId: event.id, toolName: event.name, input: JSON.stringify(event.args) }];
          case "usage":
            usage = { inputTokens: { total: event.inputTokens }, outputTokens: { total: event.outputTokens } };
            return [];
          case "finish":
            finished = true;
            return [{ type: "finish", finishReason: { unified: event.reason, raw: event.reason }, usage }];
        }
      };
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            if (first.done) {
              if (!finished) controller.enqueue({ type: "finish", finishReason: { unified: "other", raw: "other" }, usage });
              controller.close();
              return;
            }
            for (const chunk of chunksOf(first.value)) controller.enqueue(chunk);
            first = await iterator.next();
          } catch (error) {
            controller.error(error);
          }
        },
      });
      return { stream } as never;
    },
  });
}
