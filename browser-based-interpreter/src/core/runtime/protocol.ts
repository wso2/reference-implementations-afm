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
import { type LoopEvent, type ModelMessage } from "@afm/runtime";
import type { Failure } from "../chat/failure";
import { type Plan } from "../agent/browser-plan";
import { type OAuthProviderRef } from "../oauth/session";

export type AgentModelRef = AgentMetadata["model"];

export type TurnEndReason = Extract<LoopEvent, { type: "finish" }>["reason"];

export interface ImageAttachment {
  name: string;
  mediaType: string;
  data: string;
}

export type ClientMessage =
  | {
      type: "load";
      content: string;
      seedHistory?: ModelMessage[];
      allowBrowserPreview?: boolean;
      confirmedTools?: string[];
      values?: Record<string, string>;
    }
  | { type: "send"; text: string; images?: ImageAttachment[]; keep?: number }
  | { type: "cancel" }
  | { type: "regenerate" }
  | { type: "continue" }
  | { type: "reset-chat" }
  | { type: "set-secret"; name: string; value: string; address?: string; provider?: string }
  | { type: "list-secrets" }
  | { type: "remove-secret"; name: string }
  | { type: "permission-response"; id: string; decision: "allow" | "deny"; remember: boolean }
  | { type: "set-trusted"; confirmedTools?: string[] }
  | { type: "oauth-signin-start"; id: string; provider: OAuthProviderRef }
  | { type: "oauth-signin-code"; id: string; code: string; state: string; iss?: string }
  | { type: "oauth-signin-error"; id: string; error: string; state: string; iss?: string }
  | { type: "oauth-sign-out"; provider: OAuthProviderRef }
  | { type: "generate-draft"; id: string; prompt: string; model: AgentModelRef; final?: boolean }
  | { type: "probe-server"; id: string; server: AgentMetadata["tools"] }
  | { type: "probe-model"; id: string; model: AgentModelRef };

export interface ToolInfo {
  name: string;
  description?: string;
  serverId?: string;
}

export interface ProbeResult {
  tools?: ToolInfo[];
  failure?: Failure;
}

export interface LoadStep {
  key: string;
  label: string;
  state: "active" | "done" | "failed";
  note?: string;
}

type StreamedEvent = Extract<LoopEvent, { type: "text-delta" | "tool-call" | "tool-result" | "usage" }>;

export type ServerMessage =
  | { type: "worker-ready" }
  | ({ type: "load-step" } & LoadStep)
  | {
      type: "loaded";
      name: string;
      mcpServers: string[];
      plan: Plan;
    }
  | { type: "tools-listed"; tools: ToolInfo[] }
  | { type: "agent-not-ready"; reason: string }
  | { type: "worker-stopped" }
  | { type: "secrets-list"; names: string[] }
  | StreamedEvent
  | { type: "resume-available" }
  | { type: "turn-finished"; reason: TurnEndReason; canContinue?: boolean }
  | { type: "notice"; text: string }
  | { type: "permission-request"; id: string; name: string; args: unknown; serverId?: string }
  | { type: "oauth-authorize-url"; id: string; url: string }
  | { type: "oauth-signin-done"; id: string; ok: boolean; error?: string }
  | { type: "draft-generated"; id: string; source: string }
  | { type: "draft-clarify"; id: string; questions: string[] }
  | { type: "draft-generation-error"; id: string; message: string }
  | ({ type: "probe-result"; id: string } & ProbeResult)
  | { type: "error"; message: string; kept?: boolean }
  | { type: "rejected"; message: string };

export function serverMessageFromLoopEvent(event: LoopEvent): ServerMessage | null {
  switch (event.type) {
    case "text-delta":
    case "tool-call":
    case "tool-result":
    case "usage":
      return event;
    case "turn-checkpoint":
      return { type: "resume-available" };
    case "finish":
      return { type: "turn-finished", reason: event.reason };
    default:
      return null;
  }
}
