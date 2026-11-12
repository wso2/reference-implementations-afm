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
import { displayToolName, namespacedToolName } from "./tool-names";

export function permissionKey(serverId: string | undefined, toolName: string): string {
  return `${serverId ?? "local"}::${toolName}`;
}

export function listedToolKey(serverUrl: string, tool: string): string {
  return JSON.stringify([serverUrl, tool]);
}

function parseKey(key: string): [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return [parsed[0], parsed[1]];
    }
  } catch {
    return null;
  }
  return null;
}

export function toolsOfServer(keys: readonly string[], serverUrl: string): string[] {
  const tools: string[] = [];
  for (const key of keys) {
    const parsed = parseKey(key);
    if (parsed !== null && parsed[0] === serverUrl) tools.push(parsed[1]);
  }
  return tools;
}

export function keepConfirmed(confirmed: string[], metadata: AgentMetadata | null): string[] {
  if (metadata === null) return confirmed;
  const allowLists = new Map<string, string[]>();
  for (const server of metadata.tools?.mcp ?? []) {
    if (server.transport.type === "http") allowLists.set(server.transport.url, server.tool_filter?.allow ?? []);
  }
  return confirmed.filter((key) => {
    const parsed = parseKey(key);
    if (parsed === null) return false;
    const allow = allowLists.get(parsed[0]);
    return allow !== undefined && (allow.length === 0 || allow.includes(parsed[1]));
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

export function withTrusted(confirmed: string[] | null, key: string): string[] {
  return [...new Set([...(confirmed ?? []), key])];
}

export function allowedKeys(metadata: AgentMetadata, confirmed: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const server of metadata.tools?.mcp ?? []) {
    if (server.transport.type !== "http") continue;
    const url = server.transport.url;
    const allow = server.tool_filter?.allow ?? [];
    for (const tool of toolsOfServer(confirmed, url)) {
      if (allow.length === 0 || allow.includes(tool)) keys.add(permissionKey(url, namespacedToolName(server.name, tool)));
    }
  }
  return keys;
}
