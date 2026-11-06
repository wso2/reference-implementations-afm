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

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { defaultSettingsMiddleware, type LanguageModel, streamText, wrapLanguageModel } from "ai";

export interface ModelOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
}

export type KeyCheck = { ok: true } | { ok: false; status: number | null };

const PROVIDERS = {
  openai: {
    create: ({ apiKey, model = "gpt-4o", fetch }: ModelOptions): LanguageModel =>
      wrapLanguageModel({
        model: createOpenAI({ apiKey, fetch })(model),
        middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: { store: false } } } }),
      }),
    keyCheck: (apiKey: string) => ({
      url: "https://api.openai.com/v1/models",
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  },
  anthropic: {
    create: ({ apiKey, model = "claude-sonnet-4-5", fetch }: ModelOptions): LanguageModel =>
      createAnthropic({ apiKey, fetch, headers: { "anthropic-dangerous-direct-browser-access": "true" } })(model),
    keyCheck: (apiKey: string) => ({
      url: "https://api.anthropic.com/v1/models?limit=1",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    }),
  },
};

function providerNamed(name: string): (typeof PROVIDERS)[keyof typeof PROVIDERS] {
  if (!Object.hasOwn(PROVIDERS, name)) throw new Error(`Unsupported model provider ${name}. Use openai or anthropic.`);
  return PROVIDERS[name as keyof typeof PROVIDERS];
}

export const createModel = (provider: string, options: ModelOptions): LanguageModel => providerNamed(provider).create(options);

const KEY_CHECK_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT = 408;

export async function checkModelKey(provider: string, apiKey: string, fetchFn: typeof fetch = fetch): Promise<KeyCheck> {
  const { url, headers } = providerNamed(provider).keyCheck(apiKey);
  try {
    const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS) });
    return response.ok ? { ok: true } : { ok: false, status: response.status };
  } catch (error) {
    return { ok: false, status: error instanceof DOMException && error.name === "TimeoutError" ? REQUEST_TIMEOUT : null };
  }
}

export async function completeText(model: LanguageModel, prompt: string): Promise<string> {
  let text = "";
  for await (const part of streamText({ model, prompt, onError: () => {} }).fullStream) {
    if (part.type === "text-delta") text += part.text;
    if (part.type === "error") throw part.error;
  }
  return text;
}
