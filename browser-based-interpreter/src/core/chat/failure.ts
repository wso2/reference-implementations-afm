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

import { describeError } from "@afm/engine";

export type FailureKind = "missing" | "signin" | "rejected" | "slow" | "busy" | "unreachable" | "redirected" | "other";

export interface Failure {
  kind: FailureKind;
  message: string;
}

export class MissingCredentialError extends Error {
  constructor(name: string) {
    super(`Nothing has been entered for '${name}'.`);
    this.name = "MissingCredentialError";
  }
}

export class SignInRequiredError extends Error {
  constructor() {
    super("Interactive sign-in is required for this server.");
    this.name = "SignInRequiredError";
  }
}

const NO_ANSWER = -32001;

export class RequestTimeoutError extends Error {
  readonly code = NO_ANSWER;
  constructor(message = "The server did not answer in time.") {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

const BY_STATUS: Record<number, FailureKind> = {
  401: "rejected",
  403: "rejected",
  408: "slow",
  504: "slow",
  [NO_ANSWER]: "slow",
  429: "busy",
  500: "busy",
  503: "busy",
  529: "busy",
  502: "unreachable",
};

const NETWORK_FAILURE = /failed to fetch|networkerror|load failed/i;
const PROXY_REDIRECT_REFUSAL = /target answered with a redirect/i;

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, statusCode, cause, lastError } = error as { code?: unknown; statusCode?: unknown; cause?: unknown; lastError?: unknown };
  if (typeof statusCode === "number") return statusCode;
  return typeof code === "number" ? code : statusOf(cause ?? lastError);
}

export function failureFromStatus(status: number | null): FailureKind {
  return status === null ? "unreachable" : (BY_STATUS[status] ?? "other");
}

export function failureOf(error: unknown): Failure {
  const message = describeError(error);
  if (error instanceof MissingCredentialError) return { kind: "missing", message };
  if (error instanceof SignInRequiredError) return { kind: "signin", message };
  if (error instanceof TypeError && NETWORK_FAILURE.test(message)) return { kind: "unreachable", message };
  const status = statusOf(error);
  if (status === 502 && PROXY_REDIRECT_REFUSAL.test(message)) return { kind: "redirected", message };
  return { kind: status === undefined ? "other" : failureFromStatus(status), message };
}

const RULES: [RegExp, string][] = [
  [/mcp proxy|McpProxyRequired/i, "MCP error"],
  [/api[ _-]?key|invalid[ _-]?key|unauthori[sz]ed|\b40[13]\b/i, "Key not accepted"],
  [/failed to fetch|networkerror|load failed|network request failed/i, "Can't be reached"],
  [/timed out|timeout|did not answer|\b408\b|\b504\b/i, "Took too long"],
  [/rate limit|too many requests|overloaded|\b429\b|\b50[03]\b|\b529\b/i, "Busy right now"],
];

const SHORT_ENOUGH = 40;

export function briefMessage(message: string): string {
  const text = message.trim();
  for (const [pattern, short] of RULES) {
    if (pattern.test(text)) return short;
  }
  if (text.length <= SHORT_ENOUGH) return maskKeys(text);
  return /sign-?in/i.test(text) ? "Sign-in failed" : "Something went wrong";
}

const HIDDEN = "[hidden]";

const KEY_LIKE: readonly [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${HIDDEN}`],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}/g, HIDDEN],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, HIDDEN],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, HIDDEN],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, HIDDEN],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, HIDDEN],
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, HIDDEN],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, HIDDEN],
  [
    /("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token)"?\s*[:=]\s*"?)[^\s",;&}]{12,}/gi,
    `$1${HIDDEN}`,
  ],
];

export function maskKeys(text: string): string {
  return KEY_LIKE.reduce((masked, [pattern, replacement]) => masked.replace(pattern, replacement), text);
}

const logged = new Set<string>();

export function brief(message: string): string {
  const short = briefMessage(message);
  if (short !== message.trim()) logDetails(message);
  return short;
}

export function logDetails(message: string): void {
  if (message === "" || logged.has(message)) return;
  logged.add(message);
  console.error(maskKeys(message));
}
