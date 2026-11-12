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

import type { AgentMetadata } from "@afm/engine";
import type { AfmIssue } from "../agent/agent-validation";
import type { McpServer } from "../agent/browser-agent";
import { displayName } from "./setup-check";

export type ReadyFix = "model" | "tools" | "settings" | "raw" | "chat";

export interface Readiness {
  tone: "ok" | "warn" | "bad";
  lead: string;
  subject?: string;
  fix?: ReadyFix;
  chip?: boolean;
}

export function quietInRaw(state: Readiness, inRaw: boolean): Readiness {
  return inRaw && state.fix === "raw" ? { ...state, chip: true } : state;
}

export function readinessSentence(state: Readiness): string {
  return `${state.lead}${state.subject ?? ""}`;
}

interface Need {
  id: "role" | "instructions" | "model";
  label: string;
  done: boolean;
}

export interface Needs {
  items: Need[];
  done: number;
  allDone: boolean;
}

export function needsToRun(input: {
  role: string;
  instructions: string;
  metadata: AgentMetadata | null;
}): Needs | null {
  if (input.metadata === null) return null;
  const items: Need[] = [
    { id: "role", label: "Role", done: input.role.trim() !== "" },
    { id: "instructions", label: "Instructions", done: input.instructions.trim() !== "" },
    { id: "model", label: "Model", done: (input.metadata.model?.name ?? "").trim() !== "" },
  ];
  const done = items.filter((item) => item.done).length;
  return { items, done, allDone: done === items.length };
}

export type ChipStatus = "missing" | "ready" | "none";

export function chipStatus(needs: Needs | null, state: Readiness): ChipStatus {
  if (needs === null) return "none";
  if (!needs.allDone) return "missing";
  return state.tone === "bad" ? "none" : "ready";
}

const PHRASE: Record<Need["id"], string> = { role: "a role", instructions: "instructions", model: "a model" };

export function runReason(needs: Needs): string | null {
  const missing = needs.items.filter((item) => !item.done);
  if (missing.length === 0) return null;
  const words = missing.map((item) => PHRASE[item.id]);
  const list = words.length === 1 ? words[0]! : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  const head = `Add ${list} to run`;
  const roleDone = needs.items.find((item) => item.id === "role")?.done === true;
  return missing.length === 1 && missing[0]!.id === "instructions" && roleDone ? `${head}. Role is done.` : head;
}

export interface ReadinessInput {
  role: string;
  instructions: string;
  metadata: AgentMetadata | null;
  issues: AfmIssue[];
  status: string;
  current: boolean;
  failed: boolean;
  brokenServerIds: string[];
  serverNameByUrl: Map<string, string>;
}

export function readiness(input: ReadinessInput): Readiness {
  const { role, instructions, metadata, issues, status, current, failed, brokenServerIds, serverNameByUrl } = input;

  if (status === "streaming" || status === "connecting") {
    const broken = brokenServerIds[0];
    if (broken !== undefined) {
      return {
        tone: "bad",
        lead: "Running - ",
        subject: `${nameOf(serverNameByUrl, broken)} did not answer`,
        fix: "tools",
      };
    }
    return { tone: "ok", lead: "Running - waiting on the model" };
  }

  if (metadata === null) {
    return { tone: "bad", lead: "Invalid AFM file", fix: "raw", chip: true };
  }

  if ((metadata.model?.name ?? "").trim() === "") {
    return { tone: "bad", lead: "Needs a model before it can run - ", subject: "choose one", fix: "model", chip: true };
  }

  if (role.trim() === "") {
    return { tone: "bad", lead: "Needs a role before it can run", chip: true };
  }

  if (instructions.trim() === "") {
    return { tone: "bad", lead: "Needs instructions before it can run", chip: true };
  }

  const firstError = issues.find((issue) => issue.severity === "error");
  if (firstError !== undefined) {
    return { tone: "bad", lead: "Has a problem - ", subject: firstError.message, fix: "raw" };
  }

  if (failed) {
    return { tone: "bad", lead: "Did not start - ", subject: "see why", fix: "chat" };
  }

  return current && status === "ready" ? { tone: "ok", lead: "Running" } : { tone: "ok", lead: "Ready", chip: true };
}

function nameOf(names: Map<string, string>, url: string): string {
  const name = names.get(url);
  return name === undefined ? url : displayName(name);
}

export function serverNameByUrl(servers: McpServer[]): Map<string, string> {
  const byUrl = new Map<string, string>();
  for (const server of servers) {
    if (server.transport.type !== "http") continue;
    byUrl.set(server.transport.url, server.name);
  }
  return byUrl;
}
