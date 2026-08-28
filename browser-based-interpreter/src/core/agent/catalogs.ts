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

interface ModelOption {
  id: string;
  label: string;
  short?: string;
  note?: string;
}

export interface ProviderOption {
  id: string;
  label: string;
  host: string;
  secretName: string;
  models: ModelOption[];
}

export const DEFAULT_PROVIDER = "openai";

export const MODEL_PROVIDERS: ProviderOption[] = [
  {
    id: "openai",
    label: "OpenAI",
    host: "api.openai.com",
    secretName: "OPENAI_API_KEY",
    models: [
      { id: "gpt-4o", label: "GPT-4o", note: "general purpose" },
      { id: "gpt-4o-mini", label: "GPT-4o mini", note: "faster, lower cost" },
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    host: "api.anthropic.com",
    secretName: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-opus-5", label: "Claude Opus 5", short: "Opus 5", note: "most capable" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", short: "Sonnet 5", note: "balanced" },
      { id: "claude-opus-4-8", label: "Claude Opus 4.8", short: "Opus 4.8" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", short: "Sonnet 4.6" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", short: "Haiku 4.5", note: "fastest" },
    ],
  },
];

export function findProvider(id: string): ProviderOption | undefined {
  return MODEL_PROVIDERS.find((provider) => provider.id === id);
}

export function shortModelLabel(modelId: string): string {
  for (const provider of MODEL_PROVIDERS) {
    const found = provider.models.find((model) => model.id === modelId);
    if (found !== undefined) return found.short ?? found.label;
  }
  return modelId;
}

interface LicenseOption {
  id: string;
  note: string;
}

export const LICENSES: LicenseOption[] = [
  { id: "MIT", note: "Simple and permissive" },
  { id: "Apache-2.0", note: "Permissive, with a patent grant" },
  { id: "BSD-3-Clause", note: "Permissive, no endorsement" },
  { id: "BSD-2-Clause", note: "Permissive and minimal" },
  { id: "ISC", note: "Like MIT, even shorter" },
  { id: "MPL-2.0", note: "Changes to its own files stay open" },
  { id: "LGPL-3.0-or-later", note: "Weak copyleft, made for libraries" },
  { id: "GPL-3.0-or-later", note: "Anything built on it stays open" },
  { id: "AGPL-3.0-or-later", note: "Stays open even over a network" },
  { id: "CC-BY-4.0", note: "Free to reuse, with credit" },
  { id: "CC0-1.0", note: "Public domain dedication" },
  { id: "Unlicense", note: "Public domain, no conditions" },
  { id: "Proprietary", note: "All rights reserved" },
];
