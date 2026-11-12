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


import { serverAddress } from "./addresses";
import { DEFAULT_PROVIDER } from "./catalogs";

export type Path = (string | number)[];

interface CredentialBlock {
  authentication: unknown;
  path: Path;
  scope: "model" | "tool";
  address?: string;
  serverName?: string;
  provider?: string;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function credentialBlocks(frontmatter: Record<string, unknown>): CredentialBlock[] {
  const blocks: CredentialBlock[] = [];

  if (isObject(frontmatter.model)) {
    const named = frontmatter.model.provider;
    blocks.push({
      authentication: frontmatter.model.authentication,
      path: ["model", "authentication"],
      scope: "model",
      provider: (typeof named === "string" && named.trim() !== "" ? named : DEFAULT_PROVIDER).trim().toLowerCase(),
    });
  }

  const servers = isObject(frontmatter.tools) ? frontmatter.tools.mcp : undefined;
  if (!Array.isArray(servers)) return blocks;
  for (const [index, server] of servers.entries()) {
    if (!isObject(server)) continue;
    const transport = isObject(server.transport) ? server.transport : {};
    blocks.push({
      authentication: transport.authentication,
      path: ["tools", "mcp", index, "transport", "authentication"],
      scope: "tool",
      address: serverAddress(transport.url),
      serverName: typeof server.name === "string" ? server.name : undefined,
    });
  }
  return blocks;
}
