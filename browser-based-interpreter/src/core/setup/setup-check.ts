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

import { type AgentMetadata } from "@afm/engine";
import { plural } from "../plural";
import { type ProbeResult } from "../runtime/protocol";
import type { McpServer } from "../agent/browser-agent";
import { findProvider, shortModelLabel } from "../agent/catalogs";
import { type Failure, type FailureKind, logDetails } from "../chat/failure";
import { isInteractiveOAuth } from "../oauth/session";

type RowState = "waiting" | "checking" | "ready" | "needs" | "failed" | "changed";

type Credential = "none" | "token" | "signin" | "key";

export interface RowResult {
  state: RowState;
  note: string;
  failure?: FailureKind;
}

export interface SetupRow extends RowResult {
  id: string;
  kind: "model" | "server" | "values";
  name: string;
  url?: string;
}

export const MODEL_ROW = "model";
const VALUES_ROW = "values";

export interface Issue {
  kind: FailureKind;
  text: string;
}

export const displayName = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

export const rowLabel = (row: Pick<SetupRow, "kind" | "name">): string =>
  row.kind === "server" ? displayName(row.name) : row.name;

export const serverRowId = (name: string): string => `server:${name}`;

export function credentialOf(server: McpServer): Credential {
  const auth = server.transport.type === "http" ? server.transport.authentication : undefined;
  if (auth === undefined) return "none";
  return isInteractiveOAuth(auth) ? "signin" : "token";
}

const WAITING_NOTE: Record<Credential, string> = {
  none: "No key needed",
  token: "Access token",
  signin: "Sign-in",
  key: "",
};

const OTHER_NOTE: Record<Credential, string> = {
  none: "MCP error",
  token: "MCP error",
  signin: "MCP error",
  key: "Model error",
};

const SENTENCE: Record<FailureKind, (who: string, credential: Credential, message: string) => string> = {
  missing: (who, credential) =>
    credential === "signin"
      ? `${who} needs you to sign in.`
      : `${who} needs a ${credential === "key" ? "key" : "token"}.`,
  signin: (who) => `${who}'s sign-in has ended. Sign in to carry on.`,
  rejected: (who, credential) =>
    credential === "signin"
      ? `${who}'s sign-in has ended. Sign in to carry on.`
      : `${who} did not accept this ${credential === "key" ? "key" : "token"}. Paste a new one.`,
  slow: (who) => `${who} did not answer in time. Try again in a moment.`,
  busy: (who) => `${who} is busy right now. Try again in a moment.`,
  unreachable: (who) => `${who} can't be reached from this browser. Check the address, or try again.`,
  redirected: (who) => `${who} answered with a redirect, which AFM does not follow. Use the address it redirects to.`,
  other: (_who, credential) => OTHER_NOTE[credential],
};

export function issueSentence(kind: FailureKind, who: string, credential: Credential, message = ""): string {
  return SENTENCE[kind](who, credential, message);
}

export function plannedRows(metadata: AgentMetadata): SetupRow[] {
  const provider = findProvider(metadata.model?.provider ?? "");
  const named = (metadata.model?.name ?? "").trim() !== "";
  const rows: SetupRow[] = [
    {
      id: MODEL_ROW,
      kind: "model",
      name: named ? shortModelLabel(metadata.model!.name!) : "Choose a model",
      state: named ? "waiting" : "needs",
      note: named ? (provider?.label ?? metadata.model?.provider ?? "") : "No model yet",
    },
  ];
  for (const server of metadata.tools?.mcp ?? []) {
    if (server.transport.type !== "http") continue;
    rows.push({
      id: serverRowId(server.name),
      kind: "server",
      name: server.name,
      url: server.transport.url,
      state: "waiting",
      note: WAITING_NOTE[credentialOf(server)],
    });
  }
  return rows;
}

const SECRET_LOOKING = /key|token|secret|passw|credential|bearer/i;

export const looksLikeSecret = (name: string): boolean => SECRET_LOOKING.test(name);

export function valuesRow(names: string[], values: Record<string, string>): SetupRow[] {
  if (names.length === 0) return [];
  const missing = names.filter((name) => !Object.hasOwn(values, name) || (values[name] ?? "").trim() === "");
  return [
    {
      id: VALUES_ROW,
      kind: "values",
      name: "Values",
      state: missing.length === 0 ? "ready" : "needs",
      note: missing.length === 0 ? `${plural(names.length, "value")} entered` : `Needs ${missing.join(", ")}`,
    },
  ];
}

const CHECKING_NOTE: Record<Credential, string> = {
  none: "Connecting",
  token: "Connecting with your token",
  signin: "Connecting with your sign-in",
  key: "Testing the key",
};

export function checkingResult(credential: Credential): RowResult {
  return { state: "checking", note: CHECKING_NOTE[credential] };
}

export const changedResult: RowResult = { state: "changed", note: "Changed. Not checked yet." };

interface Context {
  credential: Credential;
  hadSignIn: boolean;
  answered: string;
}

const MISSING_NOTE: Record<Credential, string> = {
  none: "Nothing provided yet",
  token: "No token yet",
  signin: "Not signed in",
  key: "No key yet",
};

const FAILURE_NOTE: Record<Exclude<FailureKind, "missing" | "signin" | "rejected" | "other">, string> = {
  slow: "Did not answer in time",
  busy: "Busy right now",
  unreachable: "Can't be reached",
  redirected: "Redirects elsewhere",
};

const REFUSED_NOTE: Record<Credential, string> = {
  none: "Not accepted",
  token: "Token not accepted",
  signin: "Sign-in ended",
  key: "Key not accepted",
};

function failureResult(failure: Failure, { credential, hadSignIn }: Context): RowResult {
  const { kind, message } = failure;
  if (kind === "missing" || (kind === "signin" && !hadSignIn))
    return { state: "needs", note: MISSING_NOTE[credential], failure: "missing" };
  if (kind === "signin") return { state: "failed", note: REFUSED_NOTE.signin, failure: kind };
  if (kind === "rejected") return { state: "failed", note: REFUSED_NOTE[credential], failure: kind };
  if (kind === "other") {
    logDetails(message);
    return { state: "failed", note: OTHER_NOTE[credential], failure: kind };
  }
  return { state: "failed", note: FAILURE_NOTE[kind], failure: kind };
}

export function resultOf(probe: ProbeResult, context: Context): RowResult {
  if (probe.failure !== undefined) return failureResult(probe.failure, context);
  return {
    state: "ready",
    note: `${context.answered} · ${context.credential === "key" ? "authenticated" : "connected"}`,
  };
}

export function answeredBy(server: McpServer, reported: number): string {
  const allowed = server.tool_filter?.allow?.length ?? reported;
  return server.tool_filter?.allow === undefined ? plural(allowed, "tool") : `${allowed} allowed`;
}

export function everyRowReady(rows: SetupRow[]): boolean {
  return rows.length > 0 && rows.every((row) => row.state === "ready");
}

export function attentionCount(rows: SetupRow[]): number {
  return rows.filter((row) => row.state === "needs" || row.state === "failed").length;
}

interface Summary {
  tone: "neutral" | "warn" | "ok";
  chip: string;
  text: string;
}

export function summaryOf(rows: SetupRow[]): Summary {
  if (rows.some((row) => row.state === "checking")) {
    return { tone: "neutral", chip: "Checking", text: "Everything this agent needs, checked at once." };
  }
  const attention = attentionCount(rows);
  if (attention > 0) {
    return {
      tone: "warn",
      chip: `${attention} ${attention === 1 ? "needs" : "need"} attention`,
      text: rows.some((row) => row.state === "ready")
        ? "The rest is ready. Fix these, then check again."
        : "Fix these, then check again.",
    };
  }
  const changed = rows.filter((row) => row.state === "changed").map((row) => row.name);
  if (changed.length > 0) {
    return { tone: "neutral", chip: "Changed", text: `You updated ${changed.join(", ")}. Check again to confirm it.` };
  }
  if (everyRowReady(rows)) return { tone: "ok", chip: "Ready", text: "Press Run to start." };
  return { tone: "neutral", chip: "Waiting", text: "Everything this agent needs, checked at once." };
}

export function reachOf(
  rows: SetupRow[],
  answered: readonly string[] = [],
): { ok: string[]; failed: Record<string, string> } {
  const ok = new Set<string>();
  const failed: Record<string, string> = {};
  for (const row of rows) {
    if (row.url === undefined) continue;
    if (row.state === "ready") ok.add(row.url);
    if (row.state === "failed") failed[row.url] = row.note;
  }
  for (const url of answered) ok.add(url);
  return { ok: [...ok], failed };
}
