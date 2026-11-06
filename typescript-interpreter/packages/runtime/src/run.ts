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

import { describeError } from "@afm/engine";
import { type FinishReason, type LanguageModel, type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";

export const DEFAULT_MAX_ITERATIONS = 10;

export interface ToolOutput {
  ok: boolean;
  content: string;
}

export interface Budget {
  maxIterations: number;
  maxTokens: number;
  maxWallClockMs: number;
}

export interface AgentTurnInput {
  system: string;
  messages: ModelMessage[];
  model: LanguageModel;
  tools: ToolSet;
  budget?: Partial<Budget>;
  signal?: AbortSignal;
}

export type TurnFinishReason = Exclude<FinishReason, "tool-calls"> | "max-iterations" | "budget" | "aborted";

export type LoopEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; name: string; ok: boolean; content: string }
  | { type: "turn-checkpoint"; messages: ModelMessage[] }
  | {
      type: "budget-update";
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      maxTokens?: number;
      iteration: number;
      maxIterations: number;
      elapsedMs: number;
      maxWallClockMs?: number;
    }
  | { type: "turn-complete"; messages: ModelMessage[] }
  | { type: "finish"; reason: TurnFinishReason };

const MAX_RETRIES = 4;

const hasContent = (message: ModelMessage): boolean =>
  message.role !== "assistant" || (typeof message.content === "string" ? message.content !== "" : message.content.length > 0);

export async function* runAgentTurn(input: AgentTurnInput): AsyncIterable<LoopEvent> {
  if (input.signal?.aborted) {
    yield { type: "turn-complete", messages: input.messages };
    yield { type: "finish", reason: "aborted" };
    return;
  }

  const { maxIterations = DEFAULT_MAX_ITERATIONS, maxTokens, maxWallClockMs } = input.budget ?? {};
  const startedAt = Date.now();
  const timeout = maxWallClockMs === undefined ? undefined : AbortSignal.timeout(maxWallClockMs);
  const stop = new AbortController();
  for (const signal of [input.signal, timeout]) signal?.addEventListener("abort", () => stop.abort(), { once: true });

  let saved = input.messages;
  let partial = "";
  let tokens = { total: 0, input: 0, output: 0 };
  let steps = 0;
  let last = "other";

  const result = streamText({
    model: input.model,
    system: input.system,
    messages: input.messages,
    tools: input.tools,
    abortSignal: stop.signal,
    maxRetries: MAX_RETRIES,
    stopWhen: [
      stepCountIs(maxIterations),
      ({ steps }) => maxTokens !== undefined && steps.reduce((sum, step) => sum + (step.usage.totalTokens ?? 0), 0) >= maxTokens,
    ],
    onStepFinish: (step) => {
      saved = [...input.messages, ...step.response.messages.filter(hasContent)];
    },
    onError: () => {},
  });

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          partial += part.text;
          yield { type: "text-delta", text: part.text };
          break;
        case "tool-call":
          yield { type: "tool-call", id: part.toolCallId, name: part.toolName, args: part.input };
          break;
        case "tool-result": {
          const { ok, content } = part.output as ToolOutput;
          yield { type: "tool-result", id: part.toolCallId, name: part.toolName, ok, content };
          break;
        }
        case "tool-error": {
          const content = `Tool '${part.toolName}' failed: ${describeError(part.error)}`;
          yield { type: "tool-result", id: part.toolCallId, name: part.toolName, ok: false, content };
          break;
        }
        case "finish-step":
          partial = "";
          steps += 1;
          tokens = {
            total: tokens.total + (part.usage.totalTokens ?? 0),
            input: tokens.input + (part.usage.inputTokens ?? 0),
            output: tokens.output + (part.usage.outputTokens ?? 0),
          };
          if (part.finishReason === "tool-calls") yield { type: "turn-checkpoint", messages: saved };
          yield {
            type: "budget-update",
            totalTokens: tokens.total,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            maxTokens,
            iteration: steps,
            maxIterations,
            elapsedMs: Date.now() - startedAt,
            maxWallClockMs,
          };
          break;
        case "error":
          throw part.error;
        case "finish":
          last = part.finishReason;
          break;
      }
    }

    const messages: ModelMessage[] = partial === "" ? saved : [...saved, { role: "assistant", content: partial }];
    yield { type: "turn-complete", messages };
    yield { type: "finish", reason: finishReason() };
  } finally {
    stop.abort();
  }

  function finishReason(): TurnFinishReason {
    if (input.signal?.aborted) return "aborted";
    if (timeout?.aborted) return "budget";
    if (last !== "tool-calls") return last as TurnFinishReason;
    return maxTokens !== undefined && tokens.total >= maxTokens ? "budget" : "max-iterations";
  }
}
