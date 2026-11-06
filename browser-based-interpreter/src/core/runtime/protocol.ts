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

import type { AgentMetadata, Plan } from "@afm/engine";
import { displayToolName, type LoopEvent, type ModelMessage, namespacedToolName, type OAuthProviderRef } from "@afm/runtime";
import type { Failure } from "../chat/failure";

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
    }
  | { type: "send"; text: string; images?: ImageAttachment[]; keep?: number }
  | { type: "attach-files"; files: { name: string; path: string; text: string; pages?: number; note?: string }[] }
  | { type: "detach-file"; path: string }
  | { type: "cancel" }
  | { type: "regenerate" }
  | { type: "continue" }
  | { type: "reset-chat" }
  | { type: "set-secret"; name: string; value: string; address?: string }
  | { type: "list-secrets" }
  | { type: "remove-secret"; name: string }
  | { type: "permission-response"; id: string; decision: "allow" | "deny"; remember: boolean }
  | { type: "set-trusted"; confirmedTools?: string[] }
  | { type: "oauth-signin-start"; id: string; provider: OAuthProviderRef }
  | { type: "oauth-signin-code"; id: string; code: string; state: string; iss?: string }
  | { type: "oauth-signin-error"; id: string; error: string; state: string; iss?: string }
  | { type: "oauth-sign-out"; provider: OAuthProviderRef }
  | { type: "generate-draft"; prompt: string; model: AgentModelRef; final?: boolean }
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

type StreamedEvent = Extract<LoopEvent, { type: "text-delta" | "tool-call" | "tool-result" | "budget-update" }>;

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
  | { type: "secrets-list"; names: string[] }
  | StreamedEvent
  | { type: "resume-available" }
  | { type: "turn-finished"; reason: TurnEndReason; canContinue?: boolean }
  | { type: "notice"; text: string }
  | { type: "permission-request"; id: string; name: string; args: unknown; serverId?: string }
  | { type: "oauth-authorize-url"; id: string; url: string }
  | { type: "oauth-signin-done"; id: string; ok: boolean; error?: string }
  | { type: "draft-generated"; source: string }
  | { type: "draft-clarify"; questions: string[] }
  | { type: "draft-generation-error"; message: string }
  | ({ type: "probe-result"; id: string } & ProbeResult)
  | { type: "error"; message: string; kept?: boolean }
  | { type: "rejected"; message: string };

export function serverMessageFromLoopEvent(event: LoopEvent): ServerMessage | null {
  switch (event.type) {
    case "text-delta":
    case "tool-call":
    case "tool-result":
    case "budget-update":
      return event;
    case "turn-checkpoint":
      return { type: "resume-available" };
    case "finish":
      return { type: "turn-finished", reason: event.reason };
    default:
      return null;
  }
}

export function permissionKey(serverId: string | undefined, toolName: string): string {
  return `${serverId ?? "local"}::${toolName}`;
}

export function listedToolKey(serverUrl: string, tool: string): string {
  return JSON.stringify([serverUrl, tool]);
}

function parseKey(key: string): [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string"
      ? [parsed[0], parsed[1]]
      : null;
  } catch {
    return null;
  }
}

export function toolsOfServer(keys: readonly string[], serverUrl: string): string[] {
  return keys.flatMap((key) => {
    const parsed = parseKey(key);
    return parsed !== null && parsed[0] === serverUrl ? [parsed[1]] : [];
  });
}

export function listedTools(metadata: AgentMetadata | null): string[] {
  const keys: string[] = [];
  for (const server of metadata?.tools?.mcp ?? []) {
    if (server.transport.type !== "http") continue;
    for (const tool of server.tool_filter?.allow ?? []) keys.push(listedToolKey(server.transport.url, tool));
  }
  return [...new Set(keys)];
}

export function holdInsertedTools(
  confirmed: string[] | null,
  metadata: AgentMetadata | null,
  inserted: string,
): string[] | null {
  if (confirmed !== null || !inserted.includes("tool_filter")) return confirmed;
  return listedTools(metadata);
}

export function keepConfirmed(confirmed: string[], metadata: AgentMetadata | null): string[] {
  if (metadata === null) return confirmed;
  const allowLists = new Map<string, string[]>();
  for (const server of metadata.tools?.mcp ?? []) {
    if (server.transport.type === "http") allowLists.set(server.transport.url, server.tool_filter?.allow ?? []);
  }
  return confirmed.filter((key) => {
    const parsed = parseKey(key);
    const allow = parsed === null ? undefined : allowLists.get(parsed[0]);
    return parsed !== null && allow !== undefined && (allow.length === 0 || allow.includes(parsed[1]));
  });
}

export function trustKeyFor(metadata: AgentMetadata | null, serverId: string | undefined, name: string): string | null {
  if (serverId === undefined || serverId === "") return null;
  for (const server of metadata?.tools?.mcp ?? []) {
    if (server.transport.type !== "http" || server.transport.url !== serverId) continue;
    const allow = server.tool_filter?.allow ?? [];
    const listed = allow.find((tool) => namespacedToolName(server.name, tool) === name);
    if (listed !== undefined) return listedToolKey(serverId, listed);
    const shown = displayToolName(name);
    if (allow.length === 0 && namespacedToolName(server.name, shown) === name) return listedToolKey(serverId, shown);
  }
  return null;
}

export function withTrusted(confirmed: string[] | null, metadata: AgentMetadata | null, key: string): string[] {
  return [...new Set([...(confirmed ?? listedTools(metadata)), key])];
}
