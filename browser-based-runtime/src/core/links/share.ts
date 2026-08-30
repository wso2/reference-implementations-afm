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

import { splitFrontmatter } from "@afm/engine";
import { settingsTooLong } from "../agent/frontmatter-lines";
import { encodeInlineAfm } from "./load-paths";

export type ShareMethod = "inline" | "url";

export function buildShareLink(
  address: string,
  method: ShareMethod,
  agentSource: string,
  fileUrl: string | null,
): string | null {
  if (method === "inline") {
    return `${address}?view=chat#afm=${encodeInlineAfm(agentSource)}`;
  }
  if (fileUrl === null || fileUrl === "") {
    return null;
  }
  return `${address}?view=chat&file=${encodeURIComponent(fileUrl)}`;
}

const CREDENTIAL_FIELDS = [
  "token",
  "password",
  "api_key",
  "client_secret",
  "refresh_token",
  "assertion",
  "signing_key",
];
const REFERENCE = /^\s*\$\{[^}]+\}\s*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function literalCredentialFields(source: string): string[] {
  if (settingsTooLong(source)) return [];
  let frontmatter: Record<string, unknown> | null;
  try {
    frontmatter = splitFrontmatter(source).frontmatter;
  } catch {
    return [];
  }
  const model = isRecord(frontmatter?.model) ? frontmatter.model : {};
  const tools = isRecord(frontmatter?.tools) ? frontmatter.tools : {};
  const servers = Array.isArray(tools.mcp) ? tools.mcp : [];
  const blocks = [
    model.authentication,
    ...servers.map((server) =>
      isRecord(server) && isRecord(server.transport) ? server.transport.authentication : undefined,
    ),
  ];

  const found = new Set<string>();
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    for (const field of CREDENTIAL_FIELDS) {
      const value = block[field];
      if (typeof value === "string" && value.trim() !== "" && !REFERENCE.test(value)) found.add(field);
    }
  }
  return [...found];
}
