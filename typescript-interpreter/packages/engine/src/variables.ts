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

import { VariableResolutionError } from "./errors";
import type { SecretPort } from "./types";

const VARIABLE = /\$\{([^}]+)\}/g;

function splitReference(expression: string): { prefix: string; name: string } {
  const colon = expression.indexOf(":");
  return colon === -1
    ? { prefix: "", name: expression }
    : { prefix: expression.slice(0, colon), name: expression.slice(colon + 1) };
}

export function resolveVariables(
  frontmatter: Record<string, unknown>,
  secrets: SecretPort,
): Promise<Record<string, unknown>> {
  return resolveValue(frontmatter, secrets) as Promise<Record<string, unknown>>;
}

async function resolveValue(value: unknown, secrets: SecretPort): Promise<unknown> {
  if (typeof value === "string") {
    return resolveText(value, secrets);
  }
  if (Array.isArray(value)) {
    const resolved: unknown[] = [];
    for (const item of value) {
      resolved.push(await resolveValue(item, secrets));
    }
    return resolved;
  }
  if (typeof value === "object" && value !== null) {
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(value)) {
      entries.push([key, await resolveValue(item, secrets)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

async function resolveText(text: string, secrets: SecretPort): Promise<string> {
  let resolved = "";
  let cursor = 0;
  for (const match of text.matchAll(VARIABLE)) {
    const value = await resolveReference(match[0], match[1]!, secrets);
    resolved += text.slice(cursor, match.index) + value;
    cursor = match.index + match[0].length;
  }
  return resolved + text.slice(cursor);
}

async function resolveReference(
  reference: string,
  expression: string,
  secrets: SecretPort,
): Promise<string> {
  const { prefix, name } = splitReference(expression);

  if (prefix === "http") {
    return reference;
  }
  if (prefix === "" || prefix === "env") {
    const resolution = await secrets.resolve({ prefix, name, raw: reference });
    if (resolution.status === "resolved") {
      return resolution.value;
    }
    throw new VariableResolutionError(reference, resolution.reason);
  }
  throw new VariableResolutionError(
    reference,
    `Unsupported variable prefix '${prefix}:'. Only 'env:' and 'http:' are supported.`,
  );
}
