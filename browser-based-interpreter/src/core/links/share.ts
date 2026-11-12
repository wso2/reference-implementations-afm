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
import { credentialBlocks, isObject, type Path } from "../agent/credentials";
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
const VARIABLES = /\$\{[^}]*\}?/g;

export function literalCredentialPaths(source: string): Path[] {
  if (settingsTooLong(source)) return [];
  let frontmatter: Record<string, unknown> | null;
  try {
    frontmatter = splitFrontmatter(source).frontmatter;
  } catch {
    return [];
  }
  if (frontmatter === null) return [];

  const found: Path[] = [];
  for (const { authentication, path } of credentialBlocks(frontmatter)) {
    if (!isObject(authentication)) continue;
    for (const field of CREDENTIAL_FIELDS) {
      const value = authentication[field];
      if (typeof value === "string" && value.replace(VARIABLES, "").trim() !== "") found.push([...path, field]);
    }
  }
  return found;
}

// False when the file cannot be searched for written-in keys: its settings do not parse, or are too long to scan.
// Such a file has not been checked, so it must not be called clean.
export function canScanForCredentials(source: string): boolean {
  if (settingsTooLong(source)) return false;
  try {
    splitFrontmatter(source);
    return true;
  } catch {
    return false;
  }
}

export function literalCredentialFields(source: string): string[] {
  return [...new Set(literalCredentialPaths(source).map((path) => String(path.at(-1))))];
}
