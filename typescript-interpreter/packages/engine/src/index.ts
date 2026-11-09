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


export { parseAfm, splitFrontmatter, frontmatterEndOffset } from "./parse";
export type { ParsedAfm, FrontmatterSplit } from "./parse";
export { validateMetadata, agentMetadataSchema } from "./schema";
export type { AgentMetadata, ClientAuthentication, JsonSchemaData } from "./schema";
export { checkHttpVariables, processEnv, resolveText, resolveValues } from "./variables";
export type { Env } from "./variables";
export { compileTemplate, evaluateTemplate, TemplateError } from "./template";
export type { PromptTemplate, RequestHeaders } from "./template";
export { loadAfm, loadParsed, buildSystemPrompt } from "./load";
export type { LoadedAfm } from "./load";
export { AfmParseError, AfmValidationError, VariableResolutionError, describeError } from "./errors";
