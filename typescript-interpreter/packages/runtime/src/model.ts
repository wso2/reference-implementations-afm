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


import { type AgentMetadata, type Env, processEnv } from "@afm/engine";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, type LanguageModel, wrapLanguageModel } from "ai";

export interface ModelOptions {
  env?: Env;
  fetch?: typeof fetch;
}

type Model = NonNullable<AgentMetadata["model"]>;

const PROVIDERS: Record<string, { name: string; keyVariable: string }> = {
  openai: { name: "gpt-4o", keyVariable: "OPENAI_API_KEY" },
  anthropic: { name: "claude-sonnet-4-5", keyVariable: "ANTHROPIC_API_KEY" },
};

function apiKeyOf({ authentication }: Model, keyVariable: string, env: Env): string {
  if (authentication === undefined) {
    const key = env[keyVariable];
    if (key === undefined || key === "") throw new Error(`The model has no key: add an 'authentication' block to the model, or set ${keyVariable}.`);
    return key;
  }
  const type = authentication.type.toLowerCase();
  if (type === "bearer" || type === "api-key") {
    const field = type === "bearer" ? "token" : "api_key";
    const key = authentication[field];
    if (key === undefined || key === "") throw new Error(`${type} authentication of the model requires a '${field}' field`);
    return key;
  }
  if (type === "basic") throw new Error("basic authentication is not supported for model providers");
  throw new Error(`'${authentication.type}' authentication is not yet supported by this interpreter`);
}

export function createModel(model: Model = {}, { env = processEnv(), fetch }: ModelOptions = {}): LanguageModel {
  const provider = (model.provider ?? "openai").toLowerCase();
  const defaults = Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider] : undefined;
  if (defaults === undefined) throw new Error(`The model provider '${provider}' is not yet supported by this interpreter. Use openai or anthropic.`);
  const apiKey = apiKeyOf(model, defaults.keyVariable, env);
  const name = model.name ?? defaults.name;
  if (provider === "openai") {
    const openai = createOpenAI({ apiKey, baseURL: model.url, fetch });
    if (model.url !== undefined) return openai.chat(name);
    const middleware = defaultSettingsMiddleware({ settings: { providerOptions: { openai: { store: false } } } });
    return wrapLanguageModel({ model: openai(name), middleware });
  }
  return createAnthropic({ apiKey, baseURL: model.url, fetch })(name);
}
