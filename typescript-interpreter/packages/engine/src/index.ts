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

export type {
  ModelPort,
  ModelRequest,
  ModelEvent,
  ToolPort,
  ToolDescriptor,
  ToolCall,
  ToolResult,
  ToolResultMedia,
  SecretPort,
  SecretRef,
  SecretResolution,
  ChatMessage,
  ContentPart,
  JsonSchema,
} from "./types";

export { parseAfm, splitFrontmatter, frontmatterEndOffset, extractRoleAndInstructions } from "./parse";
export type { ParsedAfm, FrontmatterSplit, RoleAndInstructions } from "./parse";

export { validateMetadata, agentMetadataSchema } from "./schema";
export type { AgentMetadata, ClientAuthentication, JsonSchemaData } from "./schema";

export { resolveVariables, scanSecretUsage, referencedSecretNames, secretUseKey, serverAddress, secretDestination } from "./variables";
export type { SecretUsage, SecretScope } from "./variables";

export { planForBrowser } from "./plan";
export type { Plan, PlanIssue, PlanSeverity } from "./plan";

export { loadAfm, buildSystemPrompt } from "./load";
export type { LoadedAfm } from "./load";

export { runAgentTurn, allowAllPermissions, DEFAULT_MAX_ITERATIONS } from "./loop";
export type { LoopEvent, AgentTurnInput, PermissionBroker, Budget } from "./loop";

export { AfmParseError, AfmValidationError, VariableResolutionError, describeError, isRateLimited, retryAfterMs } from "./errors";
