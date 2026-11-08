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
import type { SecretPort } from "./types";
import { resolveVariables } from "./variables";

export interface LoadedAfm {
  metadata: AgentMetadata;
  role: string;
  instructions: string;
  systemPrompt: string;
}

export function buildSystemPrompt(role: string, instructions: string): string {
  return `# Role\n\n${role}\n\n# Instructions\n\n${instructions}`;
}

export async function loadAfm(content: string, secrets: SecretPort): Promise<LoadedAfm> {
  const parsed = parseAfm(content);
  const metadata = validateMetadata(await resolveVariables(parsed.frontmatter, secrets));
  return {
    metadata,
    role: parsed.role,
    instructions: parsed.instructions,
    systemPrompt: buildSystemPrompt(parsed.role, parsed.instructions),
  };
}
