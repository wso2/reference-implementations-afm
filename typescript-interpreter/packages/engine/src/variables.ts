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
import { splitFrontmatter } from "./parse";
import { asRecord, type SecretPort, type UnknownRecord } from "./types";

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

export type SecretScope = "model" | "tool" | "other";

export interface SecretUsage {
  name: string;
  scope: SecretScope;
  address?: string;
  serverName?: string;
}

type UsageOrigin = Omit<SecretUsage, "name">;

type Path = readonly (string | number)[];

interface CredentialBlock {
  authentication: unknown;
  origin: UsageOrigin;
  path: Path;
}

export function serverAddress(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const { origin, pathname, search } = new URL(url);
    return origin === "null" ? undefined : `${origin}${pathname}${search}`;
  } catch {
    return undefined;
  }
}

function readFrontmatter(content: string): UnknownRecord | null {
  try {
    return splitFrontmatter(content).frontmatter;
  } catch {
    return null;
  }
}

function secretNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(VARIABLE)) {
    const { prefix, name } = splitReference(match[1] ?? "");
    if ((prefix === "" || prefix === "env") && name !== "") names.push(name);
  }
  return names;
}

function childrenOf(value: unknown): [string | number, unknown][] {
  return Array.isArray(value) ? [...value.entries()] : Object.entries(asRecord(value) ?? {});
}

function* walkSecretNames(
  value: unknown,
  path: Path = [],
  skipped: ReadonlySet<string> = new Set(),
): Generator<string> {
  if (typeof value === "string") {
    yield* secretNamesIn(value);
    return;
  }
  if (skipped.has(JSON.stringify(path))) return;
  for (const [key, child] of childrenOf(value)) yield* walkSecretNames(child, [...path, key], skipped);
}

function credentialBlocks(frontmatter: UnknownRecord): CredentialBlock[] {
  const blocks: CredentialBlock[] = [];

  const model = asRecord(frontmatter.model);
  if (model !== null) {
    const origin: UsageOrigin = { scope: "model" };
    blocks.push({ authentication: model.authentication, origin, path: ["model", "authentication"] });
  }

  const mcp = asRecord(frontmatter.tools)?.mcp;
  for (const [index, server] of Array.isArray(mcp) ? mcp.entries() : []) {
    const entry = asRecord(server);
    if (entry === null) continue;
    const transport = asRecord(entry.transport) ?? {};
    blocks.push({
      authentication: transport.authentication,
      origin: {
        scope: "tool",
        address: serverAddress(transport.url),
        serverName: typeof entry.name === "string" ? entry.name : undefined,
      },
      path: ["tools", "mcp", index, "transport", "authentication"],
    });
  }
  return blocks;
}

function withoutRepeats(usages: SecretUsage[]): SecretUsage[] {
  const seen = new Set<string>();
  return usages.filter((usage) => {
    const key = `${usage.name}\u0000${usage.scope}\u0000${usage.address ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scanSecretUsage(content: string): SecretUsage[] {
  const frontmatter = readFrontmatter(content);
  if (frontmatter === null) return [];

  const blocks = credentialBlocks(frontmatter);
  const usages: SecretUsage[] = [];
  for (const { authentication, origin } of blocks) {
    for (const name of walkSecretNames(authentication)) usages.push({ name, ...origin });
  }
  const credentials = new Set(blocks.map((block) => JSON.stringify(block.path)));
  for (const name of walkSecretNames(frontmatter, [], credentials)) usages.push({ name, scope: "other" });
  return withoutRepeats(usages);
}

export function referencedSecretNames(content: string): string[] {
  return [...new Set(scanSecretUsage(content).map((usage) => usage.name))];
}

const LOOPBACK_HOSTNAMES: readonly string[] = ["localhost", "[::1]"];

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.includes(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function parsedAddress(address: string): URL | null {
  try {
    return new URL(address);
  } catch {
    return null;
  }
}

export function isLoopbackAddress(address: string): boolean {
  const url = parsedAddress(address);
  return url !== null && isLoopbackHost(url.hostname);
}

export function isPlainHttpAddress(address: string): boolean {
  return parsedAddress(address)?.protocol === "http:";
}

export function isInsecureAddress(address: string): boolean {
  const url = parsedAddress(address);
  return url?.protocol === "http:" && !isLoopbackHost(url.hostname);
}
