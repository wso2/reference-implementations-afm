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


import { splitFrontmatter } from "@afm/engine";
import { credentialBlocks, isObject, type Path } from "./credentials";

interface SecretUsage {
  name: string;
  scope: "model" | "tool" | "other";
  address?: string;
  serverName?: string;
  provider?: string;
}

const VARIABLE = /\$\{([^}]+)\}/g;

function parseReference(reference: string): { prefix: string; name: string } {
  const colon = reference.indexOf(":");
  return colon === -1
    ? { prefix: "", name: reference }
    : { prefix: reference.slice(0, colon), name: reference.slice(colon + 1) };
}

function namesIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(VARIABLE)) {
    const { prefix, name } = parseReference(match[1] ?? "");
    if ((prefix === "" || prefix === "env") && name !== "") names.push(name);
  }
  return names;
}

function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((part, at) => part === b[at]);
}

function namesInside(value: unknown, path: Path = [], skip: Path[] = []): string[] {
  if (typeof value === "string") return namesIn(value);
  if (skip.some((skipped) => samePath(skipped, path))) return [];
  const children = Array.isArray(value) ? [...value.entries()] : isObject(value) ? Object.entries(value) : [];
  return children.flatMap(([key, child]) => namesInside(child, [...path, key], skip));
}

export function fillValues<T>(value: T, values: Record<string, string>): T {
  if (typeof value === "string") {
    return value.replace(VARIABLE, (match, reference: string) => {
      const { prefix, name } = parseReference(reference);
      const entered = Object.hasOwn(values, name) ? values[name]?.trim() : undefined;
      return (prefix === "" || prefix === "env") && entered !== undefined && entered !== "" ? entered : match;
    }) as T;
  }
  if (Array.isArray(value)) return value.map((item) => fillValues(item, values)) as T;
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, key === "authentication" ? child : fillValues(child, values)]),
  ) as T;
}

export function scanSecretUsage(content: string): SecretUsage[] {
  let frontmatter: Record<string, unknown> | null;
  try {
    frontmatter = splitFrontmatter(content).frontmatter;
  } catch {
    return [];
  }
  if (frontmatter === null) return [];

  const blocks = credentialBlocks(frontmatter);
  const usages: SecretUsage[] = [];
  for (const { authentication, scope, address, serverName, provider } of blocks) {
    for (const name of namesInside(authentication)) usages.push({ name, scope, address, serverName, provider });
  }
  for (const name of namesInside(frontmatter, [], blocks.map((block) => block.path))) {
    usages.push({ name, scope: "other" });
  }

  return usages.filter(
    (usage, at) =>
      usages.findIndex((other) => other.name === usage.name && other.scope === usage.scope && other.address === usage.address) === at,
  );
}

export function referencedSecretNames(content: string): string[] {
  return [...new Set(scanSecretUsage(content).map((usage) => usage.name))];
}
