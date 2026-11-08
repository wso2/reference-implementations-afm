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


import { parseAfm } from "./parse";
import { type AgentMetadata, validateMetadata } from "./schema";
import { checkHttpVariables, type Env, processEnv, resolveText, resolveValues } from "./variables";

export interface LoadedAfm {
  metadata: AgentMetadata;
  role: string;
  instructions: string;
  systemPrompt: string;
  warnings: string[];
}

const SPEC_VERSION = "0.4.0";

export function buildSystemPrompt(role: string, instructions: string): string {
  return `# Role\n\n${role}\n\n# Instructions\n\n${instructions}`;
}

export function loadAfm(content: string, { env = processEnv() }: { env?: Env } = {}): LoadedAfm {
  const parsed = parseAfm(content);
  checkHttpVariables(parsed);
  const metadata = validateMetadata(resolveValues(parsed.frontmatter, env) as Record<string, unknown>);
  const role = resolveText(parsed.role, env);
  const instructions = resolveText(parsed.instructions, env);
  const warnings = metadata.spec_version === undefined || metadata.spec_version === SPEC_VERSION ? [] : [`The file's spec_version is not ${SPEC_VERSION}, which this interpreter was written for.`];
  return { metadata, role, instructions, systemPrompt: buildSystemPrompt(role, instructions), warnings };
}
