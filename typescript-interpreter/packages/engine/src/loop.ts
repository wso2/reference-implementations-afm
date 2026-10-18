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

import type { ModelPort, ToolPort, ChatMessage, ToolCall, ToolResult, ToolResultMedia } from "./types";
import { describeError, isRateLimited, retryAfterMs } from "./errors";

export interface Budget {
  maxIterations: number;
  maxTokens?: number;
  maxWallClockMs?: number;
}

export const DEFAULT_MAX_ITERATIONS = 10;

export const MAX_TOOL_RESULT_CHARS = 100_000;

export interface PermissionBroker {
  request(call: ToolCall, signal?: AbortSignal): Promise<"allow" | "deny">;
}

export const allowAllPermissions: PermissionBroker = {
  async request() {
    return "allow";
  },
};

export type LoopEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; name: string; ok: boolean; content: string; media?: ToolResultMedia[] }
  | { type: "waiting"; attempt: number; ofAttempts: number; delayMs: number; reason: string }
  | { type: "turn-complete"; messages: ChatMessage[] }
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
  | { type: "finish"; reason: "stop" | "max-iterations" | "budget" | "aborted" };

const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000, 30_000];

function clipToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  let cut = MAX_TOOL_RESULT_CHARS;
  const high = content.charCodeAt(cut - 1);
  const low = content.charCodeAt(cut);
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) cut -= 1;
  return `${content.slice(0, cut)}\n\nThe tool result was cut: only the first ${cut} of ${content.length} characters are shown.`;
}

const CANCELLED: ToolResult = { ok: false, content: "Tool call was cancelled - the user stopped the run." };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export interface AgentTurnInput {
  system: string;
  messages: ChatMessage[];
  model: ModelPort;
  tools: ToolPort;
  permission: PermissionBroker;
  budget?: Partial<Budget>;
  signal?: AbortSignal;
}

export async function* runAgentTurn(input: AgentTurnInput): AsyncIterable<LoopEvent> {
  const { system, model, tools, permission } = input;
  const maxIterations = input.budget?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTokens = input.budget?.maxTokens;
  const deadline =
    input.budget?.maxWallClockMs != null ? Date.now() + input.budget.maxWallClockMs : Infinity;
  const signal = input.signal ?? new AbortController().signal;

  const toolDescriptors = await tools.list();
  const conversation: ChatMessage[] = [...input.messages];
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  const startedAt = Date.now();

  let reason: "stop" | "max-iterations" | "budget" | "aborted" = "max-iterations";

  turn: for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal.aborted) {
      reason = "aborted";
      break turn;
    }
    if (Date.now() > deadline) {
      reason = "budget";
      break turn;
    }

    let assistantText = "";
    const toolCalls: ToolCall[] = [];
    let attempt = 0;

    for (;;) {
      try {
        for await (const event of model.stream(
          { system, messages: [...conversation], tools: toolDescriptors },
          signal,
        )) {
          if (event.type === "text-delta") {
            assistantText += event.text;
            yield { type: "text-delta", text: event.text };
          } else if (event.type === "tool-call") {
            const descriptor = toolDescriptors.find((tool) => tool.name === event.name);
            toolCalls.push({
              id: event.id,
              name: event.name,
              args: event.args,
              serverId: descriptor?.serverId,
            });
            yield { type: "tool-call", id: event.id, name: event.name, args: event.args };
          } else if (event.type === "usage") {
            totalTokens += event.inputTokens + event.outputTokens;
            totalInputTokens += event.inputTokens;
            totalOutputTokens += event.outputTokens;
            yield {
              type: "budget-update",
              totalTokens,
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              maxTokens,
              iteration: iteration + 1,
              maxIterations,
              elapsedMs: Date.now() - startedAt,
              maxWallClockMs: input.budget?.maxWallClockMs,
            };
          }
        }
        break;
      } catch (error) {
        const started = assistantText !== "" || toolCalls.length > 0;
        const waitMs = retryAfterMs(error) ?? RATE_LIMIT_BACKOFF_MS[attempt];
        if (
          started ||
          waitMs === undefined ||
          signal.aborted ||
          !isRateLimited(error) ||
          attempt >= RATE_LIMIT_BACKOFF_MS.length ||
          Date.now() + waitMs > deadline
        ) {
          throw error;
        }
        attempt += 1;
        yield {
          type: "waiting",
          attempt,
          ofAttempts: RATE_LIMIT_BACKOFF_MS.length,
          delayMs: waitMs,
          reason: describeError(error),
        };
        await sleep(waitMs, signal);
        if (signal.aborted) {
          reason = "aborted";
          break turn;
        }
      }
    }

    if (assistantText !== "" || toolCalls.length > 0) {
      conversation.push(
        toolCalls.length > 0
          ? { role: "assistant", content: assistantText, toolCalls }
          : { role: "assistant", content: assistantText },
      );
    }

    if (toolCalls.length === 0) {
      reason = "stop";
      break turn;
    }

    for (const call of toolCalls) {
      let result: ToolResult;
      if (signal.aborted) {
        result = CANCELLED;
      } else {
        const decision = await permission.request(call, signal);
        if (decision === "deny") {
          result = signal.aborted ? CANCELLED : { ok: false, content: "Tool call was denied by the user." };
        } else {
          try {
            result = await tools.execute(call, signal);
          } catch (error) {
            result = { ok: false, content: `Tool '${call.name}' failed: ${describeError(error)}` };
          }
        }
      }
      const content = clipToolResult(result.content);
      conversation.push({ role: "tool", toolCallId: call.id, content });
      yield {
        type: "tool-result",
        id: call.id,
        name: call.name,
        ok: result.ok,
        content,
        media: result.media,
      };
    }

    if (signal.aborted) {
      reason = "aborted";
      break turn;
    }

    if (maxTokens != null && totalTokens >= maxTokens) {
      reason = "budget";
      break turn;
    }
  }

  yield { type: "turn-complete", messages: conversation };
  yield { type: "finish", reason };
}
