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

import { type UiMessage } from "../chat/chat-state";

export function loadText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function saveText(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function loadJsonArray<T>(key: string, isItem: (value: unknown) => value is T): T[] {
  const raw = loadText(key);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isItem) : [];
  } catch {
    return [];
  }
}

export function saveJson(key: string, value: unknown): boolean {
  try {
    return saveText(key, JSON.stringify(value));
  } catch {
    return false;
  }
}

export type AgentOrigin = "blank" | "import";

export interface SavedAgent {
  id: string;
  name: string;
  description: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  origin: AgentOrigin;
  confirmedTools: string[] | null;
}

const AGENTS_KEY = "afm.agents.v1";

function isSavedAgent(value: unknown): value is SavedAgent {
  if (typeof value !== "object" || value === null) return false;
  const agent = value as Record<string, unknown>;
  return (
    typeof agent.id === "string" &&
    typeof agent.name === "string" &&
    typeof agent.source === "string" &&
    typeof agent.updatedAt === "number"
  );
}

function withCheckedTools(agent: SavedAgent): SavedAgent {
  const tools: unknown = agent.confirmedTools;
  if (tools === null) return agent;
  if (tools === undefined) return { ...agent, origin: "import", confirmedTools: [] };
  const checked = Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === "string") : [];
  return { ...agent, confirmedTools: checked };
}

export function loadAgents(): SavedAgent[] {
  return loadJsonArray(AGENTS_KEY, isSavedAgent).map(withCheckedTools);
}

function persist(agents: SavedAgent[]): boolean {
  return saveJson(AGENTS_KEY, agents);
}

export interface AgentSaveResult {
  agents: SavedAgent[];
  saved: SavedAgent;
  persisted: boolean;
}

export function saveAgent(
  agent: Omit<SavedAgent, "id" | "createdAt" | "updatedAt"> & { id?: string },
): AgentSaveResult {
  const existing = loadAgents();
  const now = Date.now();
  const id = agent.id ?? crypto.randomUUID();
  const previous = existing.find((a) => a.id === id);
  const next: SavedAgent = {
    id,
    name: agent.name,
    description: agent.description,
    source: agent.source,
    origin: agent.origin,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    confirmedTools: agent.confirmedTools,
  };
  const rest = existing.filter((a) => a.id !== id);
  const agents = [next, ...rest];
  return { agents, saved: next, persisted: persist(agents) };
}

export function removeAgent(id: string): SavedAgent[] {
  const agents = loadAgents().filter((a) => a.id !== id);
  persist(agents);
  return agents;
}

export function findAgent(id: string): SavedAgent | null {
  return loadAgents().find((a) => a.id === id) ?? null;
}

export interface HistoryEntry {
  id: string;
  agentId: string | null;
  agentName: string;
  agentSource: string;
  messages: UiMessage[];
  tokenCount: number;
  startedAt: number;
  updatedAt: number;
}

const HISTORY_MAX = 200;

function byRecency(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => b.updatedAt - a.updatedAt);
}

function newest(entries: HistoryEntry[]): HistoryEntry[] {
  return byRecency(entries).slice(0, HISTORY_MAX);
}

export function mergeHistory(existing: HistoryEntry[], imported: HistoryEntry[]): HistoryEntry[] {
  const byId = new Map<string, HistoryEntry>();
  for (const item of existing) byId.set(item.id, item);
  for (const item of imported) {
    const current = byId.get(item.id);
    if (current === undefined || item.updatedAt >= current.updatedAt) {
      byId.set(item.id, item);
    }
  }
  return byRecency([...byId.values()]);
}

export function withHistoryEntry(entries: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return newest([...entries.filter((item) => item.id !== entry.id), entry]);
}

export function withoutAgentHistory(entries: HistoryEntry[], agentId: string): HistoryEntry[] {
  return entries.filter((entry) => entry.agentId !== agentId);
}

export function withImportedHistory(entries: HistoryEntry[], imported: HistoryEntry[]): HistoryEntry[] {
  return newest(mergeHistory(entries, imported));
}
