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
import type { ToolInfo } from "../runtime/protocol";
import { displayToolName, ToolNameError } from "./tool-names";

export interface ToolSource {
  label: string;
  serverId?: string;
  tools(): Promise<ToolSet>;
  close(): Promise<void>;
}

interface ToolBox {
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
    loadedAt = Date.now();
    const results = await Promise.allSettled(sources.map((source) => source.tools()));
    const tools: ToolSet = {};
    const owner = new Map<string, ToolSource>();
    let down = false;
    for (const [index, source] of sources.entries()) {
      const result = results[index]!;
      if (result.status === "rejected") {
        if (result.reason instanceof ToolNameError) throw result.reason;
        down = true;
        continue;
      }
      for (const [name, item] of Object.entries(result.value)) {
        const earlier = owner.get(name);
        if (earlier !== undefined) {
          throw new ToolNameError(
            earlier.label === source.label
              ? `The server '${source.label}' lists the tool '${displayToolName(name)}' more than once.`
              : `The servers '${earlier.label}' and '${source.label}' both offer the tool '${displayToolName(name)}' under the same name '${name}', ` +
                "so the agent could not tell them apart. Give one of the servers a different name in the agent file.",
          );
        }
        owner.set(name, source);
        tools[name] = item;
      }
    }
    incomplete = down;
    const info = Object.entries(tools).map(([name, item]) => ({ name, description: item.description, serverId: owner.get(name)?.serverId }));
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
