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

import type { ToolSet } from "ai";
import { displayToolName, ToolNameError } from "./tool-names";

export interface ToolInfo {
  name: string;
  description?: string;
  serverId?: string;
}

export interface ToolSource {
  label: string;
  serverId?: string;
  tools(): Promise<ToolSet>;
  close(): Promise<void>;
}

export interface ToolBox {
  tools: ToolSet;
  info: ToolInfo[];
}

const RETRY_INCOMPLETE_MS = 30_000;

export function createToolbox(sources: ToolSource[]) {
  let box: ToolBox | null = null;
  let incomplete = false;
  let loadedAt = 0;
  let loading: Promise<ToolBox> | null = null;

  async function load(): Promise<ToolBox> {
    const results = await Promise.allSettled(sources.map((source) => source.tools()));
    const tools: ToolSet = {};
    const owner = new Map<string, string>();
    const servers = new Map<string, string | undefined>();
    incomplete = false;
    results.forEach((result, index) => {
      const label = sources[index]?.label ?? "a built-in tool";
      if (result.status === "rejected") {
        if (result.reason instanceof ToolNameError) throw result.reason;
        incomplete = true;
        return;
      }
      for (const [name, item] of Object.entries(result.value)) {
        const earlier = owner.get(name);
        if (earlier !== undefined) {
          throw new ToolNameError(
            earlier === label
              ? `The server '${label}' lists the tool '${displayToolName(name)}' more than once.`
              : `The servers '${earlier}' and '${label}' both offer the tool '${displayToolName(name)}' under the same name '${name}', ` +
                "so the agent could not tell them apart. Give one of the servers a different name in the agent file.",
          );
        }
        owner.set(name, label);
        servers.set(name, sources[index]?.serverId);
        tools[name] = item;
      }
    });
    loadedAt = Date.now();
    const info = Object.entries(tools).map(([name, item]) => ({ name, description: item.description, serverId: servers.get(name) }));
    return { tools, info };
  }

  return {
    async tools(): Promise<ToolBox> {
      if (box === null || (incomplete && Date.now() - loadedAt >= RETRY_INCOMPLETE_MS)) {
        loading ??= load().finally(() => {
          loading = null;
        });
        box = await loading;
      }
      return box;
    },
    close: async (): Promise<void> => {
      await Promise.all(sources.map((source) => source.close()));
    },
  };
}
