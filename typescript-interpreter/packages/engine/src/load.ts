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

import type { SecretPort } from "./types";
import type { AgentMetadata } from "./schema";
import type { Plan } from "./plan";
import { resolveVariables } from "./variables";
import { parseAfm } from "./parse";
import { validateMetadata } from "./schema";
import { planForBrowser } from "./plan";

export interface LoadedAfm {
  metadata: AgentMetadata;
  role: string;
  instructions: string;
  systemPrompt: string;
  plan: Plan;
}

export async function loadAfm(content: string, secrets: SecretPort): Promise<LoadedAfm> {
  const parsed = parseAfm(content);
  const frontmatter = await resolveVariables(parsed.frontmatter, secrets);
  const metadata = validateMetadata(frontmatter);
  const plan = planForBrowser(metadata);

  return {
    metadata,
    role: parsed.role,
    instructions: parsed.instructions,
    systemPrompt: buildSystemPrompt(parsed.role, parsed.instructions),
    plan,
  };
}

export function buildSystemPrompt(role: string, instructions: string): string {
  return `# Role\n\n${role}\n\n# Instructions\n\n${instructions}`;
}
