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

export type JsonSchema = Record<string, unknown>;

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  serverId?: string;
  serverName?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  serverId?: string;
}

export interface ToolResultMedia {
  kind: "image" | "audio";
  data: string;
  mediaType: string;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  media?: ToolResultMedia[];
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mediaType: string };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ModelPort {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

export interface ModelRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDescriptor[];
}

export type ModelEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "finish"; reason: "stop" | "tool-calls" | "length" };

export interface ToolPort {
  list(): Promise<ToolDescriptor[]>;
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
  dispose?(): Promise<void>;
}

export interface SecretPort {
  resolve(ref: SecretRef): Promise<SecretResolution>;
}

export interface SecretRef {
  prefix: "env" | "";
  name: string;
  raw: string;
}

export type SecretResolution =
  | { status: "resolved"; value: string }
  | { status: "unresolved"; reason: string };
