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

import { referencedSecretNames } from "@afm/engine";
import { addMcpServer, type NewMcpServer, removeMcpServer, setServerToolFilter } from "../agent/agent-source-edit";
import { secretNameOf, secretReference } from "../agent/secret-reference";
import { type ToolInfo } from "../runtime/protocol";
import { DIRECTORY_ENTRIES, type DirectoryCategory, type DirectoryEntry } from "./mcp-directory";

function searchText(entry: DirectoryEntry): string {
  return `${entry.title} ${entry.description} ${entry.publisher}`.toLowerCase();
}

export function searchDirectory(
  query: string,
  entries: readonly DirectoryEntry[] = DIRECTORY_ENTRIES,
): DirectoryEntry[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "");
  const inTitle = (entry: DirectoryEntry) => terms.every((term) => entry.title.toLowerCase().includes(term));
  return entries
    .filter((entry) => terms.every((term) => searchText(entry).includes(term)))
    .sort(
      (a, b) =>
        Number(inTitle(b)) - Number(inTitle(a)) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    );
}

export function inCategory(entries: readonly DirectoryEntry[], category: DirectoryCategory | null): DirectoryEntry[] {
  return category === null ? [...entries] : entries.filter((entry) => entry.category === category);
}

export function listedServer(url: string): DirectoryEntry | undefined {
  return DIRECTORY_ENTRIES.find((entry) => entry.url === url);
}

export function isListedServer(url: string): boolean {
  return listedServer(url) !== undefined;
}

export interface AuthField {
  key: string;
  name: string;
  required: boolean;
  placeholder: string;
}

interface Method {
  id: string;
  label: string;
  fields: AuthField[];
}

export const AUTH_METHODS: Method[] = [
  { id: "none", label: "None", fields: [] },
  {
    id: "bearer",
    label: "Access token",
    fields: [{ key: "token", name: "token", required: true, placeholder: "${env:MY_TOKEN}" }],
  },
  {
    id: "basic",
    label: "Username",
    fields: [
      { key: "username", name: "username", required: true, placeholder: "Your username" },
      { key: "password", name: "password", required: true, placeholder: "${env:MY_PASSWORD}" },
    ],
  },
  {
    id: "api-key",
    label: "Key in a header",
    fields: [
      { key: "api_key", name: "api key", required: true, placeholder: "${env:MY_API_KEY}" },
      { key: "header_name", name: "header name", required: false, placeholder: "X-API-Key" },
    ],
  },
  {
    id: "oauth2",
    label: "Provider sign-in",
    fields: [
      { key: "authorize_url", name: "authorize url", required: true, placeholder: "https://…/oauth/authorize" },
      { key: "token_url", name: "token url", required: true, placeholder: "https://…/oauth/token" },
      { key: "client_id", name: "client id", required: true, placeholder: "${env:MY_CLIENT_ID}" },
      { key: "scopes", name: "scopes", required: false, placeholder: "mcp" },
    ],
  },
];

const GENERIC_HOST_WORDS = ["mcp", "api", "www", "ai", "app"];

function uniqueName(base: string, taken: string[], separator: string): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!taken.includes(`${base}${separator}${n}`)) return `${base}${separator}${n}`;
  }
}

export function addressNote(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed === "" || trimmed.includes("${")) return null;
  const invalid = `Invalid address \`${trimmed}\`. Start it with \`https://\`.`;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:" ? null : invalid;
  } catch {
    return invalid;
  }
}

export function nameFromUrl(url: string, taken: string[], listedId?: string): string {
  if (listedId !== undefined) return uniqueName(listedId, taken, "-");
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  const parts = host.split(".").filter((part) => !GENERIC_HOST_WORDS.includes(part));
  const base = (parts[0] ?? host).replace(/[^a-z0-9-]/gi, "").toLowerCase() || "server";
  return uniqueName(base, taken, "-");
}

interface ServerSave {
  content: string;
  editing: string | null;
  server: NewMcpServer;
  knownSecrets: string[];
  tools: ToolInfo[] | null;
  allowed: string[];
}

export function prepareServerSave({ content, editing, server, knownSecrets, tools, allowed }: ServerSave) {
  let next = editing === null ? content : removeMcpServer(content, editing);
  const taken = [...referencedSecretNames(next), ...knownSecrets];
  const captured = server.auth === undefined ? undefined : captureAuthSecrets(server.name, server.auth.fields, taken);
  next = addMcpServer(next, {
    ...server,
    auth: server.auth === undefined || captured === undefined ? undefined : { ...server.auth, fields: captured.fields },
  });
  if (tools !== null) {
    const names = tools.map((tool) => tool.name);
    next = setServerToolFilter(
      next,
      server.name,
      names.filter((tool) => allowed.includes(tool)),
      names.filter((tool) => !allowed.includes(tool)),
    );
  }
  return { content: next, secrets: captured?.secrets ?? [] };
}

const SECRET_SUFFIX: Record<string, string> = {
  token: "_TOKEN",
  password: "_PASSWORD",
  api_key: "_API_KEY",
};

export function isSecretAuthField(fieldKey: string): boolean {
  return SECRET_SUFFIX[fieldKey] !== undefined;
}

export function mcpSecretEnvName(serverName: string, fieldKey: string, taken: string[]): string {
  const base =
    serverName
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "MCP";
  return uniqueName(`${base}${SECRET_SUFFIX[fieldKey] ?? ""}`, taken, "_");
}

interface AuthCapture {
  fields: Record<string, string>;
  secrets: { name: string; value: string }[];
}

export function captureAuthSecrets(serverName: string, fields: Record<string, string>, taken: string[]): AuthCapture {
  const out: Record<string, string> = {};
  const secrets: { name: string; value: string }[] = [];
  const spokenFor = [...taken];

  for (const [key, value] of Object.entries(fields)) {
    if (!isSecretAuthField(key) || secretNameOf(value) !== "") {
      out[key] = value;
      continue;
    }
    const name = mcpSecretEnvName(serverName, key, spokenFor);
    spokenFor.push(name);
    secrets.push({ name, value });
    out[key] = secretReference(name);
  }

  return { fields: out, secrets };
}

type SecretFieldState = "editing" | "missing" | "saved" | "empty";

export function secretFieldState(
  fileValue: string,
  typed: string | undefined,
  knownSecrets: string[],
): SecretFieldState {
  if (typed !== undefined) return "editing";
  const name = secretNameOf(fileValue);
  if (name === "") return "empty";
  return knownSecrets.includes(name) ? "saved" : "missing";
}

export function lacksRequiredField(
  fields: readonly { key: string; required: boolean }[],
  auth: NewMcpServer["auth"],
): boolean {
  return fields.some((field) => field.required && auth?.fields[field.key] === undefined);
}
