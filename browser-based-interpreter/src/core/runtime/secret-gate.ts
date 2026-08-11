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

import { type Env, VariableResolutionError } from "@afm/engine";
import { DEFAULT_PROVIDER, findProvider } from "../agent/catalogs";
import { settingsTooLong } from "../agent/frontmatter-lines";
import { scanSecretUsage } from "../agent/secret-usage";

export interface SecretUse {
  name: string;
  address?: string;
}

export interface ModelUse {
  name: string;
  provider: string;
}

interface SecretGateDeps {
  uses: SecretUse[];
  models: ModelUse[];
  settings: string[];
  values: Record<string, string>;
  approvedFor: (name: string, address: string | undefined) => boolean;
  enteredForModel: (name: string, provider: string) => boolean;
  valueOf: (name: string) => string | undefined;
}

export function secretsOf(content: string): { uses: SecretUse[]; models: ModelUse[]; settings: string[] } {
  if (settingsTooLong(content)) return { uses: [], models: [], settings: [] };
  const usages = scanSecretUsage(content);
  return {
    uses: usages.filter((usage) => usage.scope === "tool").map((usage) => ({ name: usage.name, address: usage.address })),
    models: usages
      .filter((usage) => usage.scope === "model")
      .map((usage) => ({ name: usage.name, provider: usage.provider ?? DEFAULT_PROVIDER })),
    settings: [...new Set(usages.filter((usage) => usage.scope === "other").map((usage) => usage.name))],
  };
}

export function describeAddresses(addresses: (string | undefined)[]): string {
  return [...new Set(addresses.map((address) => address ?? "an undeclared address"))].join(", ");
}

function enteredValue(values: Record<string, string>, name: string): string {
  const value = Object.hasOwn(values, name) ? values[name] : undefined;
  return typeof value === "string" ? value.trim() : "";
}

function refusalFor(name: string, deps: SecretGateDeps): string | null {
  const model = deps.models.find((use) => use.name === name);
  const tools = deps.uses.filter((use) => use.name === name);

  if (deps.settings.includes(name)) {
    if (model !== undefined || tools.length > 0) {
      return `'${name}' is used as a key and as a setting. Give the setting its own name.`;
    }
    return enteredValue(deps.values, name) === "" ? `'${name}' needs a value. Enter it in Setup, under Values.` : null;
  }

  if (model !== undefined && !deps.enteredForModel(name, model.provider)) {
    return `'${name}' was not entered as a key for ${findProvider(model.provider)?.label ?? model.provider}.`;
  }
  const unapproved = tools.filter((use) => !deps.approvedFor(use.name, use.address));
  if (unapproved.some((use) => use.address === undefined)) {
    return `'${name}' can only be used with a tool server whose address is written out in the file, with no variable in it.`;
  }
  return unapproved.length === 0 ? null : `'${name}' was not entered for ${describeAddresses(unapproved.map((use) => use.address))}.`;
}

export interface GatedSecrets {
  env: Env;
  refused: Map<string, string>;
}

export function gateSecrets(names: string[], deps: SecretGateDeps): GatedSecrets {
  const env: Env = Object.create(null);
  const refused = new Map<string, string>();
  for (const name of new Set(names)) {
    const reason = refusalFor(name, deps);
    if (reason !== null) {
      refused.set(name, reason);
      continue;
    }
    const value = deps.settings.includes(name) ? enteredValue(deps.values, name) : deps.valueOf(name);
    if (value !== undefined) env[name] = value;
  }
  return { env, refused };
}

export function explainRefusal(error: unknown, refused: Map<string, string>): unknown {
  if (!(error instanceof VariableResolutionError)) return error;
  const reason = refused.get(/^\$\{(?:env:)?(.*)\}$/.exec(error.reference)?.[1] ?? "");
  return reason === undefined ? error : new VariableResolutionError(error.reference, reason);
}
