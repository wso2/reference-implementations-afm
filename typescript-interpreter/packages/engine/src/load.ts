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


import { parseAfm, type ParsedAfm } from "./parse";
import { type AgentMetadata, validateMetadata } from "./schema";
import { checkHttpVariables, type Env, processEnv, resolveText, resolveValues } from "./variables";

export interface LoadedAfm {
  metadata: AgentMetadata;
  role: string;
  instructions: string;
  systemPrompt: string;
  warnings: string[];
}

const SUPPORTED_SPEC_VERSIONS = ["0.3.0", "0.4.0"];

function specVersionWarnings(specVersion: string | undefined): string[] {
  const supported = SUPPORTED_SPEC_VERSIONS.join(", ");
  if (specVersion === undefined) return [`AFM file has no 'spec_version'; expected one of: ${supported}. Proceeding anyway.`];
  if (SUPPORTED_SPEC_VERSIONS.includes(specVersion)) return [];
  return [`AFM file 'spec_version' '${specVersion}' is not in the supported set (${supported}). Proceeding anyway; some fields may not be recognized.`];
}

export function buildSystemPrompt(role: string, instructions: string): string {
  return `# Role\n\n${role}\n\n# Instructions\n\n${instructions}`;
}

export function loadParsed(parsed: ParsedAfm, { env = processEnv() }: { env?: Env } = {}): LoadedAfm {
  checkHttpVariables(parsed);
  const metadata = validateMetadata(resolveValues(parsed.frontmatter, env) as Record<string, unknown>);
  const role = resolveText(parsed.role, env);
  const instructions = resolveText(parsed.instructions, env);
  const warnings = specVersionWarnings(metadata.spec_version);
  return { metadata, role, instructions, systemPrompt: buildSystemPrompt(role, instructions), warnings };
}

export function loadAfm(content: string, options: { env?: Env } = {}): LoadedAfm {
  return loadParsed(parseAfm(content), options);
}

export interface AgentDetails {
  name: string;
  description: string;
  version: string;
  iconUrl?: string;
}

export function agentDetails({ metadata, role }: LoadedAfm, file = ""): AgentDetails {
  const fromFile = file.replace(/^.*[\\/]/, "").replace(/\.afm(\.md)?$/i, "");
  return {
    name: metadata.name ?? (fromFile === "" ? "AFM Agent" : fromFile),
    description: metadata.description ?? role.split(/\n\s*\n/)[0]!.replace(/\s+/g, " "),
    version: metadata.version ?? "0.0.0",
    iconUrl: metadata.icon_url,
  };
}
