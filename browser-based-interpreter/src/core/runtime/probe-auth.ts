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

import type { AgentMetadata, Env } from "@afm/engine";
import { secretNameOf } from "../agent/secret-reference";
import { MissingCredentialError } from "../chat/failure";
import { serverAddress } from "../agent/addresses";

export function probeToolUses(tools: AgentMetadata["tools"]): { name: string; address?: string }[] {
  const uses: { name: string; address?: string }[] = [];
  for (const server of tools?.mcp ?? []) {
    if (server.transport.type !== "http" || server.transport.authentication === undefined) continue;
    const address = serverAddress(server.transport.url);
    for (const value of Object.values(server.transport.authentication)) {
      if (typeof value !== "string") continue;
      const name = secretNameOf(value);
      if (name !== "") uses.push({ name, address });
    }
  }
  return uses;
}

function fillSecrets<T extends Record<string, unknown>>(auth: T, env: Env): T {
  const resolved: Record<string, unknown> = { ...auth };
  for (const [key, value] of Object.entries(auth)) {
    if (typeof value !== "string") continue;
    const name = secretNameOf(value);
    if (name === "") continue;
    const secret = env[name];
    if (secret === undefined) throw new MissingCredentialError(name);
    resolved[key] = secret;
  }
  return resolved as T;
}

export function resolveProbeAuth(tools: AgentMetadata["tools"], env: Env): AgentMetadata["tools"] {
  const servers = tools?.mcp;
  if (servers === undefined) return tools;
  return {
    ...tools,
    mcp: servers.map((server) =>
      server.transport.type === "http" && server.transport.authentication !== undefined
        ? { ...server, transport: { ...server.transport, authentication: fillSecrets(server.transport.authentication, env) } }
        : server,
    ),
  };
}
