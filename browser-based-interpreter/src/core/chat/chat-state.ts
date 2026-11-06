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

import { type PlanIssue } from "@afm/engine";
import { type AttachedFile, attachedFileKey } from "../files/file-labels";
import {
  type ImageAttachment,
  type LoadStep,
  type ServerMessage,
  type ToolInfo,
  type TurnEndReason,
} from "../runtime/protocol";

type BudgetSnapshot = Omit<Extract<ServerMessage, { type: "budget-update" }>, "type">;

export type UiMessage =
  | { kind: "user"; id: number; text: string; images?: ImageAttachment[] }
  | { kind: "assistant"; id: number; text: string }
  | {
      kind: "tool";
      id: number;
      callId: string;
      name: string;
      args: unknown;
      status: "running" | "ok" | "failed";
      result?: string;
    }
  | { kind: "attachment"; id: number; files: AttachedFile[] }
  | { kind: "notice"; id: number; text: string };

export interface PendingPermission {
  id: string;
  name: string;
  args: unknown;
  serverId?: string;
}

export type AgentStatus = "no-agent" | "connecting" | "ready" | "not-ready" | "streaming";

export interface ChatState {
  status: AgentStatus;
  agentName: string;
  agentSource: string;
  mcpServers: string[];
  planIssues: PlanIssue[];
  loadSteps: LoadStep[];
  tools: ToolInfo[];
  notReady: string | null;
  messages: UiMessage[];
  savedSecrets: string[];
  pendingPermission: PendingPermission | null;
  error: string | null;
  canContinue: boolean;
  unsent: number[];
  nextId: number;
  budget: BudgetSnapshot | null;
  generatedDraft: string | null;
  clarifyQuestions: string[];
  draftError: string | null;
}

export const initialChatState: ChatState = {
  status: "no-agent",
  agentName: "",
  agentSource: "",
  mcpServers: [],
  planIssues: [],
  loadSteps: [],
  tools: [],
  notReady: null,
  messages: [],
  savedSecrets: [],
  pendingPermission: null,
  error: null,
  canContinue: false,
  unsent: [],
  nextId: 1,
  budget: null,
  generatedDraft: null,
  clarifyQuestions: [],
  draftError: null,
};

type ChatAction =
  | { type: "user-message"; text: string; images?: ImageAttachment[] }
  | { type: "agent-loading"; content: string }
  | { type: "restore-session"; messages: UiMessage[]; agentSource: string; unseen?: boolean }
  | { type: "draft-dismissed" }
  | { type: "agent-cleared" }
  | { type: "regenerate-start" }
  | { type: "continue-start" }
  | { type: "rewind"; id: number }
  | { type: "server"; message: ServerMessage }
  | { type: "permission-dismissed" }
  | { type: "files-attached"; files: AttachedFile[] }
  | { type: "file-detached"; id: number; key: string };

export function lastUserIndex(messages: UiMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.kind === "user") return i;
  }
  return -1;
}

function turnEndNotice(reason: TurnEndReason, maxIterations?: number, budget?: BudgetSnapshot | null): string | null {
  switch (reason) {
    case "stop":
      return null;
    case "aborted":
      return "Stopped. Any tool calls still queued were cancelled.";
    case "max-iterations": {
      const limit = maxIterations === undefined ? "its limit" : `${maxIterations} steps`;
      return `Stopped after ${limit} - the agent hit its iteration limit, so the answer above may be unfinished. Raise 'max_iterations' in the agent file to let it go further.`;
    }
    case "budget": {
      if (budget?.maxTokens !== undefined && budget.totalTokens >= budget.maxTokens) {
        return `Stopped at this turn's token budget (${budget.totalTokens.toLocaleString("en-US")} of ${budget.maxTokens.toLocaleString("en-US")} tokens). Send a follow-up to continue from the completed tool results.`;
      }
      if (budget?.maxWallClockMs !== undefined) {
        const minutes = budget.maxWallClockMs / 60_000;
        return `Stopped at this turn's ${minutes}-minute time budget. Send a follow-up to continue from the completed tool results.`;
      }
      return "Stopped at the token or time budget for this turn. Send a follow-up to continue from the completed tool results.";
    }
    case "length":
      return "The model reached its output limit. This reply may be incomplete. Send a follow-up to continue.";
    case "content-filter":
      return "The model filtered part of this reply. The answer may be incomplete.";
    case "error":
      return "The model stopped with an error. The answer may be incomplete.";
    case "other":
      return "The model stopped without confirming a complete answer. Send a follow-up to continue.";
  }
}

const NO_PENDING = { pendingPermission: null } as const;

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

function withMessage(state: ChatState, { kind, ...rest }: WithoutId<UiMessage>): ChatState {
  return {
    ...state,
    messages: [...state.messages, { kind, id: state.nextId, ...rest } as UiMessage],
    nextId: state.nextId + 1,
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "user-message":
      return withMessage(
        { ...state, status: "streaming", error: null, budget: null, canContinue: false },
        { kind: "user", text: action.text, images: action.images },
      );
    case "agent-loading":
      return {
        ...state,
        ...NO_PENDING,
        status: "connecting",
        agentSource: action.content,
        loadSteps: [],
        error: null,
        canContinue: false,
        notReady: null,
        messages: [],
        unsent: [],
      };
    case "restore-session":
      return {
        ...state,
        ...NO_PENDING,
        status: "connecting",
        agentSource: action.agentSource,
        messages: action.messages,
        unsent:
          action.unseen === true
            ? action.messages.flatMap((message) => (message.kind === "user" ? [message.id] : []))
            : [],
        nextId: Math.max(state.nextId, ...action.messages.map((message) => message.id + 1)),
        error: null,
        canContinue: false,
        notReady: null,
      };
    case "draft-dismissed":
      return { ...state, generatedDraft: null, clarifyQuestions: [], draftError: null };
    case "agent-cleared":
      return {
        ...initialChatState,
        savedSecrets: state.savedSecrets,
        nextId: state.nextId,
      };
    case "regenerate-start": {
      const index = lastUserIndex(state.messages);
      if (index === -1) return state;
      const files = state.messages.slice(index + 1).filter((message) => message.kind === "attachment");
      return {
        ...state,
        status: "streaming",
        error: null,
        canContinue: false,
        messages: [...state.messages.slice(0, index + 1), ...files],
      };
    }
    case "continue-start": {
      const lastTool = state.messages.reduce(
        (last, message, index) => (message.kind === "tool" && message.status !== "running" ? index : last),
        -1,
      );
      if (lastTool === -1) return state;
      return { ...state, status: "streaming", error: null, messages: state.messages.slice(0, lastTool + 1) };
    }
    case "rewind": {
      const index = state.messages.findIndex((message) => message.id === action.id);
      if (index === -1) return state;
      const files = state.messages.slice(index).filter((message) => message.kind === "attachment");
      return {
        ...state,
        messages: [...state.messages.slice(0, index), ...files],
        unsent: state.unsent.filter((id) => id < action.id),
      };
    }
    case "permission-dismissed":
      return { ...state, pendingPermission: null };
    case "files-attached":
      return withMessage(state, { kind: "attachment", files: action.files });
    case "file-detached": {
      const messages = state.messages
        .map((message) =>
          message.kind === "attachment" && message.id === action.id
            ? {
                kind: "attachment" as const,
                id: message.id,
                files: message.files.filter((file) => attachedFileKey(file) !== action.key),
              }
            : message,
        )
        .filter((message) => message.kind !== "attachment" || message.files.length > 0);
      return { ...state, messages };
    }
    case "server":
      return applyServerMessage(state, action.message);
  }
}

function applyServerMessage(state: ChatState, message: ServerMessage): ChatState {
  switch (message.type) {
    case "load-step": {
      const step: LoadStep = {
        key: message.key,
        label: message.label,
        state: message.state,
        note: message.note,
      };
      const at = state.loadSteps.findIndex((existing) => existing.key === step.key);
      const loadSteps =
        at === -1
          ? [...state.loadSteps, step]
          : state.loadSteps.map((existing, index) => (index === at ? step : existing));
      return { ...state, loadSteps };
    }
    case "loaded":
      return {
        ...state,
        status: "ready",
        agentName: message.name,
        mcpServers: message.mcpServers,
        planIssues: message.plan.issues,
        notReady: null,
        error: null,
      };
    case "tools-listed":
      return { ...state, tools: message.tools };
    case "agent-not-ready":
      return { ...state, status: "not-ready", notReady: message.reason };
    case "secrets-list":
      return { ...state, savedSecrets: message.names };
    case "text-delta":
      return appendToAssistant(state, message.text);
    case "tool-call":
      return withMessage(state, {
        kind: "tool",
        callId: message.id,
        name: message.name,
        args: message.args,
        status: "running",
      });
    case "tool-result":
      return updateTool(state, message.id, message.ok, message.content);
    case "resume-available":
      return { ...state, canContinue: true };
    case "notice":
      return withMessage(state, { kind: "notice", text: message.text });
    case "budget-update":
      return {
        ...state,
        budget: {
          totalTokens: message.totalTokens,
          inputTokens: message.inputTokens,
          outputTokens: message.outputTokens,
          maxTokens: message.maxTokens,
          iteration: message.iteration,
          maxIterations: message.maxIterations,
          elapsedMs: message.elapsedMs,
          maxWallClockMs: message.maxWallClockMs,
        },
      };
    case "turn-finished": {
      const ready = {
        ...state,
        status: "ready" as const,
        pendingPermission: null,
        canContinue: message.canContinue === true,
        unsent: state.unsent.filter((id) => id !== state.messages[lastUserIndex(state.messages)]?.id),
      };
      const text = turnEndNotice(message.reason, state.budget?.maxIterations, state.budget);
      return text === null ? ready : withMessage(ready, { kind: "notice", text });
    }
    case "permission-request":
      return {
        ...state,
        pendingPermission: {
          id: message.id,
          name: message.name,
          args: message.args,
          serverId: message.serverId,
        },
      };
    case "worker-ready":
    case "oauth-authorize-url":
    case "oauth-signin-done":
    case "probe-result":
      return state;
    case "draft-generated":
      return { ...state, generatedDraft: message.source, clarifyQuestions: [], draftError: null };
    case "draft-clarify":
      return { ...state, clarifyQuestions: message.questions, draftError: null };
    case "draft-generation-error":
      return { ...state, clarifyQuestions: [], draftError: message.message };
    case "error": {
      const last = state.messages[lastUserIndex(state.messages)];
      return {
        ...state,
        error: message.message,
        status: state.status === "no-agent" ? "no-agent" : "ready",
        unsent: message.kept === false && last !== undefined ? [...new Set([...state.unsent, last.id])] : state.unsent,
      };
    }
    case "rejected":
      return { ...state, error: message.message };
  }
}

function appendToAssistant(state: ChatState, text: string): ChatState {
  const last = state.messages[state.messages.length - 1];
  if (last !== undefined && last.kind === "assistant") {
    const updated: UiMessage = { ...last, text: last.text + text };
    return { ...state, messages: [...state.messages.slice(0, -1), updated] };
  }
  return withMessage(state, { kind: "assistant", text });
}

function updateTool(state: ChatState, callId: string, ok: boolean, content: string): ChatState {
  return {
    ...state,
    messages: state.messages.map((message) =>
      message.kind === "tool" && message.callId === callId
        ? { ...message, status: ok ? "ok" : "failed", result: content }
        : message,
    ),
  };
}

export function turnsKeptBefore(state: ChatState, id: number): number {
  return state.messages.filter(
    (message) => message.kind === "user" && message.id < id && !state.unsent.includes(message.id),
  ).length;
}
