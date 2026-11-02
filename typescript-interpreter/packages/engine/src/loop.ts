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

import { describeError, isRateLimited, MAX_SERVER_RETRY_DELAY_MS, RATE_LIMIT_BACKOFF_MS, retryAfterMs, sleep } from "./errors";
import type { ChatMessage, FinishReason, ModelPort, ToolCall, ToolDescriptor, ToolPort, ToolResult, ToolResultMedia } from "./types";

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

export type TurnFinishReason = Exclude<FinishReason, "tool-calls"> | "max-iterations" | "budget" | "aborted";

export type LoopEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "tool-result"; id: string; name: string; ok: boolean; content: string; media?: ToolResultMedia[] }
  | { type: "waiting"; attempt: number; ofAttempts: number; delayMs: number; reason: string }
  | { type: "turn-checkpoint"; messages: ChatMessage[] }
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
  | { type: "finish"; reason: TurnFinishReason };

function clipToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  let cut = MAX_TOOL_RESULT_CHARS;
  const high = content.charCodeAt(cut - 1);
  const low = content.charCodeAt(cut);
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) cut -= 1;
  return `${content.slice(0, cut)}\n\nThe tool result was cut: only the first ${cut} of ${content.length} characters are shown.`;
}

const CANCELLED: ToolResult = { ok: false, content: "Tool call was cancelled - the user stopped the run." };
const DENIED: ToolResult = { ok: false, content: "Tool call was denied by the user." };
const MODEL_STOPPED = "The model stopped before this tool call could run.";
const INCOMPLETE_FINISHES: readonly FinishReason[] = ["length", "content-filter", "error", "other"];

export interface AgentTurnInput {
  system: string;
  messages: ChatMessage[];
  model: ModelPort;
  tools: ToolPort;
  permission: PermissionBroker;
  budget?: Partial<Budget>;
  signal?: AbortSignal;
}

interface TurnBudget {
  maxIterations: number;
  recordUsage(inputTokens: number, outputTokens: number, iteration: number): LoopEvent;
  deadlinePassed(): boolean;
  canWait(ms: number): boolean;
  tokensExhausted(): boolean;
}

interface Turn {
  system: string;
  model: ModelPort;
  tools: ToolPort;
  permission: PermissionBroker;
  signal: AbortSignal;
  descriptors: ToolDescriptor[];
  conversation: ChatMessage[];
  budget: TurnBudget;
}

interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  finish: FinishReason | null;
}

function createTurnBudget(budget: Partial<Budget> | undefined, deadline: number): TurnBudget {
  const maxIterations = budget?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTokens = budget?.maxTokens;
  const startedAt = Date.now();
  let totalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  return {
    maxIterations,
    recordUsage(inputTokens, outputTokens, iteration) {
      totalTokens += inputTokens + outputTokens;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
      return {
        type: "budget-update",
        totalTokens,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        maxTokens,
        iteration: iteration + 1,
        maxIterations,
        elapsedMs: Date.now() - startedAt,
        maxWallClockMs: budget?.maxWallClockMs,
      };
    },
    deadlinePassed: () => Date.now() > deadline,
    canWait: (ms) => Date.now() + ms <= deadline,
    tokensExhausted: () => maxTokens != null && totalTokens >= maxTokens,
  };
}

async function startTurn(input: AgentTurnInput): Promise<Turn> {
  const deadline = input.budget?.maxWallClockMs != null ? Date.now() + input.budget.maxWallClockMs : Infinity;
  const signal = input.signal ?? new AbortController().signal;
  const descriptors = await input.tools.list();
  return {
    system: input.system,
    model: input.model,
    tools: input.tools,
    permission: input.permission,
    signal,
    descriptors,
    conversation: [...input.messages],
    budget: createTurnBudget(input.budget, deadline),
  };
}

async function* readModelStream(turn: Turn, iteration: number, response: ModelResponse): AsyncGenerator<LoopEvent, void> {
  const request = { system: turn.system, messages: [...turn.conversation], tools: turn.descriptors };
  for await (const event of turn.model.stream(request, turn.signal)) {
    switch (event.type) {
      case "text-delta":
        response.text += event.text;
        yield { type: "text-delta", text: event.text };
        break;
      case "tool-call": {
        const descriptor = turn.descriptors.find((tool) => tool.name === event.name);
        response.toolCalls.push({ id: event.id, name: event.name, args: event.args, serverId: descriptor?.serverId });
        yield { type: "tool-call", id: event.id, name: event.name, args: event.args };
        break;
      }
      case "usage":
        yield turn.budget.recordUsage(event.inputTokens, event.outputTokens, iteration);
        break;
      case "finish":
        response.finish = event.reason;
        break;
    }
  }
}

function retryDelay(error: unknown, attempt: number, started: boolean, budget: TurnBudget): number | undefined {
  const asked = retryAfterMs(error);
  const waitMs = asked !== undefined && asked <= MAX_SERVER_RETRY_DELAY_MS ? asked : RATE_LIMIT_BACKOFF_MS[attempt];
  const retryable =
    !started &&
    waitMs !== undefined &&
    isRateLimited(error) &&
    attempt < RATE_LIMIT_BACKOFF_MS.length &&
    budget.canWait(waitMs);
  return retryable ? waitMs : undefined;
}

async function* streamModel(turn: Turn, iteration: number): AsyncGenerator<LoopEvent, ModelResponse> {
  const response: ModelResponse = { text: "", toolCalls: [], finish: null };
  for (let attempt = 0; ; ) {
    try {
      yield* readModelStream(turn, iteration, response);
      return response;
    } catch (error) {
      if (turn.signal.aborted) return response;
      const started = response.text !== "" || response.toolCalls.length > 0;
      const delayMs = retryDelay(error, attempt, started, turn.budget);
      if (delayMs === undefined) throw error;
      attempt += 1;
      yield { type: "waiting", attempt, ofAttempts: RATE_LIMIT_BACKOFF_MS.length, delayMs, reason: describeError(error) };
      await sleep(delayMs, turn.signal);
      if (turn.signal.aborted) return response;
    }
  }
}

function recordAssistantMessage(conversation: ChatMessage[], response: ModelResponse): void {
  if (response.text === "" && response.toolCalls.length === 0) return;
  conversation.push(
    response.toolCalls.length > 0
      ? { role: "assistant", content: response.text, toolCalls: response.toolCalls }
      : { role: "assistant", content: response.text },
  );
}

function unrunnableReason(signal: AbortSignal, finish: FinishReason | null): TurnFinishReason | null {
  if (signal.aborted) return "aborted";
  if (finish === null) return "other";
  return INCOMPLETE_FINISHES.includes(finish) ? (finish as TurnFinishReason) : null;
}

function* settleUnrunCalls(turn: Turn, calls: ToolCall[], content: string): Generator<LoopEvent> {
  for (const call of calls) {
    turn.conversation.push({ role: "tool", toolCallId: call.id, content });
    yield { type: "tool-result", id: call.id, name: call.name, ok: false, content };
  }
}

async function runToolCall(turn: Turn, call: ToolCall): Promise<ToolResult> {
  if (turn.signal.aborted) return CANCELLED;
  try {
    const decision = await turn.permission.request(call, turn.signal);
    if (decision === "deny") return turn.signal.aborted ? CANCELLED : DENIED;
    if (turn.signal.aborted) return CANCELLED;
    return await turn.tools.execute(call, turn.signal);
  } catch (error) {
    if (turn.signal.aborted) return CANCELLED;
    return { ok: false, content: `Tool '${call.name}' failed: ${describeError(error)}` };
  }
}

async function* runToolCalls(turn: Turn, calls: ToolCall[]): AsyncGenerator<LoopEvent> {
  for (const call of calls) {
    const result = await runToolCall(turn, call);
    const content = clipToolResult(result.content);
    turn.conversation.push({ role: "tool", toolCallId: call.id, content });
    yield { type: "tool-result", id: call.id, name: call.name, ok: result.ok, content, media: result.media };
  }
}

export async function* runAgentTurn(input: AgentTurnInput): AsyncIterable<LoopEvent> {
  const turn = await startTurn(input);
  let reason: TurnFinishReason = "max-iterations";

  for (let iteration = 0; iteration < turn.budget.maxIterations; iteration++) {
    if (turn.signal.aborted || turn.budget.deadlinePassed()) {
      reason = turn.signal.aborted ? "aborted" : "budget";
      break;
    }

    const response = yield* streamModel(turn, iteration);
    recordAssistantMessage(turn.conversation, response);

    const unrunnable = unrunnableReason(turn.signal, response.finish);
    if (unrunnable !== null) {
      yield* settleUnrunCalls(turn, response.toolCalls, unrunnable === "aborted" ? CANCELLED.content : MODEL_STOPPED);
      reason = unrunnable;
      break;
    }

    if (response.toolCalls.length === 0) {
      reason = response.finish === "tool-calls" ? "other" : "stop";
      break;
    }

    yield* runToolCalls(turn, response.toolCalls);
    yield { type: "turn-checkpoint", messages: [...turn.conversation] };

    if (turn.signal.aborted || turn.budget.tokensExhausted()) {
      reason = turn.signal.aborted ? "aborted" : "budget";
      break;
    }
  }

  yield { type: "turn-complete", messages: turn.conversation };
  yield { type: "finish", reason };
}
