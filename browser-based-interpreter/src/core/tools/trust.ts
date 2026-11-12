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

// A key names the tool, the address and the entry in the file. Two entries can share an address, and selecting a tool
// of one must not select it for the other. Keys saved without the entry's name (from before) apply to every entry there.
export function listedToolKey(serverUrl: string, tool: string, serverName?: string): string {
  return JSON.stringify(serverName === undefined ? [serverUrl, tool] : [serverUrl, tool, serverName]);
}

interface ParsedKey {
  url: string;
  tool: string;
  server: string | null;
}

function parseKey(key: string): ParsedKey | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      const server = parsed[2];
      if (server !== undefined && typeof server !== "string") return null;
      return { url: parsed[0], tool: parsed[1], server: server ?? null };
    }
  } catch {
    return null;
  }
  return null;
}

const appliesTo = (parsed: ParsedKey, serverName: string | undefined) =>
  parsed.server === null || serverName === undefined || parsed.server === serverName;

export function toolsOfServer(keys: readonly string[], serverUrl: string, serverName?: string): string[] {
  const tools: string[] = [];
  for (const key of keys) {
    const parsed = parseKey(key);
    if (parsed !== null && parsed.url === serverUrl && appliesTo(parsed, serverName)) tools.push(parsed.tool);
  }
  return tools;
}

// Keys saved before the entry's name was part of the key name only the tool and the address. Each becomes one key per
// entry at that address, so the Permissions window can show it as selected and take it back. Other keys stay as they are.
export function withEntryKeys(keys: readonly string[], metadata: AgentMetadata | null): string[] {
  const entries: { url: string; name: string }[] = [];
  for (const server of metadata?.tools?.mcp ?? []) {
    if (server.transport.type === "http") entries.push({ url: server.transport.url, name: server.name });
  }
  const result = new Set<string>();
  for (const key of keys) {
    const parsed = parseKey(key);
    const at = parsed === null || parsed.server !== null ? [] : entries.filter((entry) => entry.url === parsed.url);
    if (parsed === null || at.length === 0) result.add(key);
    else for (const entry of at) result.add(listedToolKey(parsed.url, parsed.tool, entry.name));
  }
  return [...result];
}

export function keepConfirmed(confirmed: string[], metadata: AgentMetadata | null): string[] {
  if (metadata === null) return confirmed;
  const entries: { url: string; name: string; allow: string[] }[] = [];
  for (const server of metadata.tools?.mcp ?? []) {
    if (server.transport.type === "http") {
      entries.push({ url: server.transport.url, name: server.name, allow: server.tool_filter?.allow ?? [] });
    }
  }
  return confirmed.filter((key) => {
    const parsed = parseKey(key);
    if (parsed === null) return false;
    return entries.some(
      (entry) =>
        entry.url === parsed.url &&
        appliesTo(parsed, entry.name) &&
        (entry.allow.length === 0 || entry.allow.includes(parsed.tool)),
    );
  });
}

export function trustKeyFor(metadata: AgentMetadata | null, serverId: string | undefined, name: string): string | null {
  if (serverId === undefined || serverId === "") return null;
  for (const server of metadata?.tools?.mcp ?? []) {
    if (server.transport.type !== "http" || server.transport.url !== serverId) continue;
    const allow = server.tool_filter?.allow ?? [];
    const listed = allow.find((tool) => namespacedToolName(server.name, tool) === name);
    if (listed !== undefined) return listedToolKey(serverId, listed, server.name);
    const shown = displayToolName(name);
    if (allow.length === 0 && namespacedToolName(server.name, shown) === name) return listedToolKey(serverId, shown, server.name);
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
    for (const tool of toolsOfServer(confirmed, url, server.name)) {
      if (allow.length === 0 || allow.includes(tool)) keys.add(permissionKey(url, namespacedToolName(server.name, tool)));
    }
  }
  return keys;
}
