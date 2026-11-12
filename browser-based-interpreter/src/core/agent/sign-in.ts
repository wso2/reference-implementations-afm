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

import { AfmValidationError } from "@afm/engine";
import { parseUrl } from "./addresses";
import { isObject } from "./credentials";
import { isInteractiveOAuth } from "../oauth/session";

type Mapping = Record<string, unknown>;

const SIGN_IN_FIELDS = ["authorize_url", "token_url", "client_id"];
const OPTIONAL_FIELDS = ["scopes"];

const fieldList = (fields: string[]): string =>
  `${fields.map((field) => `'${field}'`).join(", ")} ${fields.length === 1 ? "field" : "fields"}`;

function addressProblem(field: string, value: unknown): string | null {
  if (typeof value !== "string") return `authentication.${field} must be text`;
  if (value.includes("${")) return null;
  const url = parseUrl(value);
  if (url === null) return `authentication.${field} must be an absolute http:// or https:// URL`;
  if (url.protocol === "http:" || url.protocol === "https:") return null;
  return `authentication.${field} must be an http:// or https:// URL - got '${url.protocol}//'`;
}

function signInProblem(auth: Mapping): string | null {
  const label = "oauth2 grant_type 'authorization_code'";
  const provided = Object.keys(auth).filter((key) => key !== "type" && key !== "grant_type");
  const missing = SIGN_IN_FIELDS.filter((field) => !provided.includes(field));
  if (missing.length > 0) return `${label} requires ${fieldList(missing)}`;
  const unknown = provided.filter((field) => !SIGN_IN_FIELDS.includes(field) && !OPTIONAL_FIELDS.includes(field));
  if (unknown.length > 0) return `${label} does not support ${fieldList(unknown)}`;
  const { scopes } = auth;
  const scopesAreText = Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string");
  if (scopes !== undefined && !scopesAreText) return "authentication.scopes must be a list of text";
  if (typeof auth.client_id !== "string") return "authentication.client_id must be text";
  return addressProblem("authorize_url", auth.authorize_url) ?? addressProblem("token_url", auth.token_url);
}

export interface SignIn {
  index: number;
  name: unknown;
  auth: Mapping;
}

export function withoutSignIns(frontmatter: Mapping): { frontmatter: Mapping; signIns: SignIn[] } {
  const signIns: SignIn[] = [];
  const { tools } = frontmatter;
  if (!isObject(tools) || !Array.isArray(tools.mcp)) return { frontmatter, signIns };

  const mcp = tools.mcp.map((server: unknown, index: number) => {
    if (!isObject(server) || !isObject(server.transport)) return server;
    const { transport } = server;
    if (transport.type !== "http" || !isObject(transport.authentication)) return server;
    if (!isInteractiveOAuth(transport.authentication)) return server;
    signIns.push({ index, name: server.name, auth: transport.authentication });
    const { authentication: _removed, ...rest } = transport;
    return { ...server, transport: rest };
  });
  return { frontmatter: { ...frontmatter, tools: { ...tools, mcp } }, signIns };
}

export function signInProblems(signIns: SignIn[]): { path: (string | number)[]; message: string }[] {
  const problems = [];
  for (const { index, auth } of signIns) {
    const message = signInProblem(auth);
    if (message !== null) problems.push({ path: ["tools", "mcp", index, "transport", "authentication"], message });
  }
  return problems;
}

export function checkSignIns(signIns: SignIn[]): void {
  const [first] = signInProblems(signIns);
  if (first !== undefined) throw new AfmValidationError(first.message, first.path.join("."));
}
