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

import {
  type ImageAttachment,
  type LoadStep,
  type ServerMessage,
  type ToolInfo,
  type TurnEndReason,
} from "../runtime/protocol";
import { type PlanIssue } from "../agent/browser-plan";

type UsageSnapshot = Omit<Extract<ServerMessage, { type: "usage" }>, "type">;

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
      step?: number;
    }
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
  usage: UsageSnapshot | null;
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
  usage: null,
  generatedDraft: null,
  clarifyQuestions: [],
  draftError: null,
};

const NO_AGENT_DETAILS = { agentName: "", mcpServers: [], planIssues: [], tools: [] };

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
  | { type: "permission-dismissed" };

// Editing, retrying or regenerating changes the conversation, so it waits until the agent is ready.
export function canChangeConversation(state: ChatState): boolean {
  return state.status === "ready";
}

export function lastUserIndex(messages: UiMessage[]): number {
  return messages.findLastIndex((message) => message.kind === "user");
}

function turnEndNotice(reason: TurnEndReason, maxIterations?: number): string | null {
  switch (reason) {
    case "stop":
      return null;
    case "aborted":
      return "Stopped. Any tool calls still queued were cancelled.";
    case "max-iterations": {
      const limit = maxIterations === undefined ? "its limit" : `${maxIterations} steps`;
      return `Stopped after ${limit} - the agent hit its iteration limit, so the answer above may be unfinished. Raise 'max_iterations' in the agent file to let it go further.`;
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

const WORKER_STOPPED = "Agent stopped. Enter your keys again.";

function withMessage(state: ChatState, message: UiMessage): ChatState {
  return { ...state, messages: [...state.messages, message], nextId: state.nextId + 1 };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "user-message":
      return withMessage(
        { ...state, status: "streaming", error: null, usage: null, canContinue: false },
        { kind: "user", id: state.nextId, text: action.text, images: action.images },
      );
    case "agent-loading":
      return {
        ...state,
        ...NO_AGENT_DETAILS,
        pendingPermission: null,
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
        ...NO_AGENT_DETAILS,
        pendingPermission: null,
        status: "connecting",
        agentSource: action.agentSource,
        messages: action.messages,
        unsent:
          action.unseen === true
            ? action.messages.filter((message) => message.kind === "user").map((message) => message.id)
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
      return {
        ...state,
        status: "streaming",
        error: null,
        canContinue: false,
        messages: state.messages.slice(0, index + 1),
      };
    }
    case "continue-start": {
      const lastTool = state.messages.findLastIndex((message) => message.kind === "tool" && message.status !== "running");
      if (lastTool === -1) return state;
      return { ...state, status: "streaming", error: null, messages: state.messages.slice(0, lastTool + 1) };
    }
    case "rewind": {
      const index = state.messages.findIndex((message) => message.id === action.id);
      if (index === -1) return state;
      return {
        ...state,
        messages: state.messages.slice(0, index),
        unsent: state.unsent.filter((id) => id < action.id),
      };
    }
    case "permission-dismissed":
      return { ...state, pendingPermission: null };
    case "server":
      return applyServerMessage(state, action.message);
  }
}

function applyServerMessage(state: ChatState, message: ServerMessage): ChatState {
  switch (message.type) {
    case "load-step": {
      const { type: _type, ...step } = message;
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
    case "worker-stopped": {
      const lost = { savedSecrets: [], pendingPermission: null, canContinue: false };
      if (state.status === "no-agent") return { ...state, ...lost, error: WORKER_STOPPED };
      return { ...state, ...lost, status: "not-ready", notReady: WORKER_STOPPED };
    }
    case "secrets-list":
      return { ...state, savedSecrets: message.names };
    case "text-delta":
      return appendToAssistant(state, message.text);
    case "tool-call":
      return withMessage(state, {
        kind: "tool",
        id: state.nextId,
        callId: message.id,
        name: message.name,
        args: message.args,
        status: "running",
        step: state.usage?.iteration ?? 0,
      });
    case "tool-result":
      return updateTool(state, message.id, message.ok, message.content);
    case "resume-available":
      return { ...state, canContinue: true };
    case "notice":
      return withMessage(state, { kind: "notice", id: state.nextId, text: message.text });
    case "usage": {
      const { type: _type, ...usage } = message;
      return { ...state, usage };
    }
    case "turn-finished": {
      const ready = {
        ...state,
        status: "ready" as const,
        pendingPermission: null,
        canContinue: message.canContinue === true,
        unsent: state.unsent.filter((id) => id !== state.messages[lastUserIndex(state.messages)]?.id),
      };
      const text = turnEndNotice(message.reason, state.usage?.maxIterations);
      return text === null ? ready : withMessage(ready, { kind: "notice", id: ready.nextId, text });
    }
    case "permission-request": {
      const { type: _type, ...pendingPermission } = message;
      return { ...state, pendingPermission };
    }
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
        pendingPermission: null,
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
  return withMessage(state, { kind: "assistant", id: state.nextId, text });
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
