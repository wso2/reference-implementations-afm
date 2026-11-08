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


import { AfmValidationError, VariableResolutionError } from "./errors";
import type { ParsedAfm } from "./parse";

export type Env = Record<string, string | undefined>;

const VARIABLE = /\$\{([^}]+)\}/g;
const HTTP_ALLOWED_INTERFACES = ["webhook", "platformchat"];

export function resolveText(text: string, env: Env): string {
  return text.replace(VARIABLE, (reference, expression: string) => {
    const colon = expression.indexOf(":");
    const prefix = colon === -1 ? "" : expression.slice(0, colon);
    const name = colon === -1 ? expression : expression.slice(colon + 1);
    if (prefix === "http") return reference;
    if (prefix !== "" && prefix !== "env") {
      throw new VariableResolutionError(reference, `Unsupported variable prefix '${prefix}:'. Only 'env:' and 'http:' are supported.`);
    }
    const value = Object.hasOwn(env, name) ? env[name] : undefined;
    if (value === undefined || value === "") throw new VariableResolutionError(reference, `'${name}' is not set`);
    return value;
  });
}

export function resolveValues(value: unknown, env: Env): unknown {
  if (typeof value === "string") return resolveText(value, env);
  if (Array.isArray(value)) return value.map((item) => resolveValues(item, env));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValues(item, env)]));
  }
  return value;
}

function httpPlaces(value: unknown, path: string): string[] {
  if (typeof value === "string") return value.includes("${http:") ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => httpPlaces(item, `${path}[${index}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => httpPlaces(item, path === "" ? key : `${path}.${key}`));
  }
  return [];
}

const allowsHttp = (item: unknown): boolean =>
  typeof item === "object" && item !== null && HTTP_ALLOWED_INTERFACES.includes((item as { type?: string }).type ?? "");

export function checkHttpVariables({ frontmatter, role, instructions }: ParsedAfm): void {
  const interfaces = Array.isArray(frontmatter.interfaces) ? frontmatter.interfaces : [];
  const checked = { ...frontmatter, interfaces: interfaces.map((item) => (allowsHttp(item) ? { ...item, prompt: undefined } : item)) };
  const found = [role.includes("${http:") ? "role" : "", instructions.includes("${http:") ? "instructions" : "", ...httpPlaces(checked, "")];
  const places = found.filter((place) => place !== "");
  if (places.length > 0) {
    throw new AfmValidationError(`http: variables are only supported in webhook and platform chat prompts, found in: ${places.join(", ")}`, "");
  }
}
