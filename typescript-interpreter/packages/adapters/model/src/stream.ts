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

import type { ChatMessage, FinishReason, ModelEvent, ModelPort, ModelRequest } from "@afm/engine";
import { type LanguageModel, type ModelMessage, streamText } from "ai";
import { modelEventsFromPart, toModelMessages, toToolSet, withoutBlankSystem } from "./convert";

type AssistantMessage = Extract<ChatMessage, { role: "assistant" }>;

export interface Continuation {
  system: string;
  visible: ChatMessage[];
  native: ModelMessage[];
}

export interface ContinuationStore {
  find(system: string, messages: ChatMessage[]): Continuation | undefined;
  remember(continuation: Continuation): void;
}

const MAX_CONTINUATIONS = 64;

const callsOf = (message: AssistantMessage) => (message.toolCalls ?? []).map(({ id, name, args }) => ({ id, name, args }));

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function withSortedKeys(_key: string, value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function snapshot<T>(value: T): T {
  if (Array.isArray(value)) return value.map(snapshot) as T;
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item)])) as T;
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return JSON.stringify(left, withSortedKeys) === JSON.stringify(right, withSortedKeys);
}

function sameMessage(left: ChatMessage, right: ChatMessage): boolean {
  if (left === right) return true;
  if (left.role !== right.role || !sameValue(left.content, right.content)) return false;
  if (left.role === "tool" && right.role === "tool") return left.toolCallId === right.toolCallId;
  if (left.role === "assistant" && right.role === "assistant") return sameValue(callsOf(left), callsOf(right));
  return true;
}

function continues(continuation: Continuation, system: string, messages: ChatMessage[]): boolean {
  return (
    continuation.system === system &&
    continuation.visible.length <= messages.length &&
    continuation.visible.every((message, at) => sameMessage(message, messages[at]!))
  );
}

export function createContinuationStore(): ContinuationStore {
  const kept: Continuation[] = [];

  return {
    find(system: string, messages: ChatMessage[]): Continuation | undefined {
      let longest: Continuation | undefined;
      for (const candidate of kept) {
        if (!continues(candidate, system, messages)) continue;
        if (longest === undefined || candidate.visible.length >= longest.visible.length) longest = candidate;
      }
      return longest;
    },

    remember(continuation: Continuation): void {
      kept.push({ ...continuation, visible: continuation.visible.map(snapshot) });
      if (kept.length > MAX_CONTINUATIONS) kept.shift();
    },
  };
}

type ProviderOptions = Parameters<typeof streamText>[0]["providerOptions"];

const completesTurn = (reason: FinishReason): boolean => reason === "stop" || reason === "tool-calls";

function addToTranscript(assistant: AssistantMessage, event: ModelEvent): void {
  if (event.type === "text-delta") assistant.content += event.text;
  if (event.type === "tool-call") {
    (assistant.toolCalls ??= []).push({ id: event.id, name: event.name, args: event.args });
  }
}

const hasContent = (assistant: AssistantMessage): boolean => assistant.content !== "" || (assistant.toolCalls?.length ?? 0) > 0;

export function streamingModelPort(model: LanguageModel, providerOptions?: ProviderOptions): ModelPort {
  const continuations = createContinuationStore();

  return {
    async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
      const tools = toToolSet(request.tools);
      const converted = toModelMessages(request.messages);
      const previous = continuations.find(request.system, request.messages);
      const messages = withoutBlankSystem(
        previous === undefined ? converted : [...previous.native, ...converted.slice(previous.visible.length)],
      );
      const result = streamText({
        model,
        system: request.system.trim() === "" ? undefined : request.system,
        messages,
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        providerOptions,
        abortSignal: signal,
      });

      const assistant: AssistantMessage = { role: "assistant", content: "" };
      let finished = false;
      for await (const part of result.fullStream) {
        if (part.type === "error") {
          throw part.error;
        }
        for (const event of modelEventsFromPart(part)) {
          addToTranscript(assistant, event);
          if (event.type === "finish") finished = completesTurn(event.reason);
          yield event;
        }
      }
      if (finished && !signal.aborted && hasContent(assistant)) {
        const response = await result.response;
        continuations.remember({
          system: request.system,
          visible: [...request.messages, assistant],
          native: [...messages, ...response.messages],
        });
      }
    },
  };
}
