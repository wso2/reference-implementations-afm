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

import { loadAgents, type SavedAgent } from "../storage/stores";
import { identityFor, openingOf } from "./workspace-content";

interface Where {
  pathname: string;
  search: string;
  hash: string;
}

export function lastEditedAgent(agents: SavedAgent[]): SavedAgent | null {
  let latest: SavedAgent | null = null;
  for (const agent of agents) {
    if (latest === null || agent.updatedAt > latest.updatedAt) latest = agent;
  }
  return latest;
}

export function landingUrl(base: string, where: Where, agents: SavedAgent[]): string | null {
  const root = base.endsWith("/") ? base : `${base}/`;
  if (where.pathname !== root && `${where.pathname}/` !== root) return null;
  const params = new URLSearchParams(where.search);
  if (identityFor(openingOf(params, where.hash, undefined)) !== "blank" || params.get("view") === "chat") return null;
  const last = lastEditedAgent(agents);
  if (last === null) return null;
  params.set("agentId", last.id);
  return `${where.pathname}?${params.toString()}${where.hash}`;
}

export function openLastAgent(
  env: { base: string; where: Where; agents: SavedAgent[]; replace: (url: string) => void } = {
    base: import.meta.env.BASE_URL,
    where: window.location,
    agents: loadAgents(),
    replace: (url) => window.history.replaceState(window.history.state, "", url),
  },
): void {
  const url = landingUrl(env.base, env.where, env.agents);
  if (url !== null) env.replace(url);
}

export function isFramed(): boolean {
  try {
    return window.top !== window;
  } catch {
    return true;
  }
}
