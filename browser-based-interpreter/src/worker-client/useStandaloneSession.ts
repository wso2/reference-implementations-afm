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

import type { AgentMetadata } from "@afm/engine";
import { useReducer, useRef } from "react";
import type { PendingPermission, UiMessage } from "../core/chat/chat-state";
import { canChangeConversation, chatReducer, initialChatState, lastUserIndex, turnsKeptBefore } from "../core/chat/chat-state";
import type { AgentModelRef, ImageAttachment, ProbeResult } from "../core/runtime/protocol";
import { toSeededConversation } from "../core/chat/seed-conversation";
import { useAgentWorker } from "./useAgentWorker";
import { type OAuthProviderRef } from "../core/oauth/session";

export interface SessionHooks {
  onRememberPermission?: (request: PendingPermission, allow: boolean) => void;
}

interface LoadOptions {
  carryConversation?: boolean;
  allowBrowserPreview?: boolean;
  confirmedTools?: string[];
  values?: Record<string, string>;
}

function freshStartNotice(messages: UiMessage[]): UiMessage {
  const highest = messages.reduce((max, message) => Math.max(max, message.id), 0);
  return {
    kind: "notice",
    id: highest + 1,
    text:
      "You changed what this agent is, so it starts fresh here. It cannot see the replies " +
      "above - those were written by the previous version.",
  };
}

export function useStandaloneSession(hooks: SessionHooks = {}) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  const { post, probe, startOAuthSignIn } = useAgentWorker((message) => dispatch({ type: "server", message }));

  function loadContent(content: string, earlier?: UiMessage[], options: LoadOptions = {}): void {
    const resume = earlier ?? [];
    const carry = options.carryConversation !== false;
    dispatch({ type: "agent-loading", content });
    if (resume.length > 0) {
      dispatch({
        type: "restore-session",
        messages: carry ? resume : [...resume, freshStartNotice(resume)],
        agentSource: content,
        unseen: !carry,
      });
    }
    post({
      type: "load",
      content,
      seedHistory: resume.length > 0 ? (carry ? toSeededConversation(resume) : []) : undefined,
      allowBrowserPreview: options.allowBrowserPreview,
      confirmedTools: options.confirmedTools,
      values: options.values,
    });
  }

  function send(text: string, images?: ImageAttachment[]): void {
    dispatch({ type: "user-message", text, images });
    post({ type: "send", text, images });
  }

  function stop(): void {
    post({ type: "cancel" });
  }

  function regenerate(): void {
    if (!canChangeConversation(state)) return;
    dispatch({ type: "regenerate-start" });
    post({ type: "regenerate" });
  }

  function retryReply(): void {
    if (!canChangeConversation(state)) return;
    const last = state.messages[lastUserIndex(state.messages)];
    if (last?.kind !== "user") return;
    if (state.canContinue) {
      dispatch({ type: "continue-start" });
      post({ type: "continue" });
      return;
    }
    dispatch({ type: "regenerate-start" });
    post({ type: "send", text: last.text, images: last.images });
  }

  function editMessage(id: number, text: string): void {
    if (!canChangeConversation(state)) return;
    const original = state.messages.find((message) => message.id === id);
    const images = original?.kind === "user" ? original.images : undefined;
    const keep = turnsKeptBefore(state, id);
    dispatch({ type: "rewind", id });
    dispatch({ type: "user-message", text, images });
    post({ type: "send", text, images, keep });
  }

  function clearAgent(): void {
    dispatch({ type: "agent-cleared" });
    post({ type: "reset-chat" });
  }

  function removeSecret(name: string): void {
    post({ type: "remove-secret", name });
  }

  function storeSecret(name: string, value: string, address?: string): void {
    post({ type: "set-secret", name, value, address });
  }

  function storeModelKey(name: string, value: string, provider: string): void {
    post({ type: "set-secret", name, value, provider });
  }

  function signOutOAuth(provider: OAuthProviderRef): void {
    post({ type: "oauth-sign-out", provider });
  }

  function submitPermission(id: string, allow: boolean, remember: boolean): void {
    const request = state.pendingPermission;
    dispatch({ type: "permission-dismissed" });
    post({ type: "permission-response", id, decision: allow ? "allow" : "deny", remember });
    if (remember && request !== null && request.id === id) {
      hooksRef.current.onRememberPermission?.(request, allow);
    }
  }

  function syncTrusted(confirmedTools: string[] | undefined): void {
    post({ type: "set-trusted", confirmedTools });
  }

  function generateDraft(prompt: string, model: AgentModelRef, final?: boolean): void {
    dispatch({ type: "draft-dismissed" });
    post({ type: "generate-draft", prompt, model, final });
  }

  function probeServer(server: NonNullable<AgentMetadata["tools"]>): Promise<ProbeResult> {
    return probe((id) => ({ type: "probe-server", id, server }));
  }

  function probeModel(model: AgentModelRef): Promise<ProbeResult> {
    return probe((id) => ({ type: "probe-model", id, model }));
  }

  function dismissDraft(): void {
    dispatch({ type: "draft-dismissed" });
  }

  return {
    state,
    loadContent,
    send,
    stop,
    clearAgent,
    regenerate,
    retryReply,
    editMessage,
    storeSecret,
    storeModelKey,
    removeSecret,
    startOAuthSignIn,
    signOutOAuth,
    submitPermission,
    syncTrusted,
    generateDraft,
    dismissDraft,
    probeServer,
    probeModel,
  };
}
