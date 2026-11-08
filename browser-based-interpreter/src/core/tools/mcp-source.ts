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

import { mcpTools, type McpConnection, type ToolOutput } from "@afm/runtime";
import type { ClientAuthentication } from "@afm/engine";
import type { ToolCallOptions, ToolSet } from "ai";
import { RequestTimeoutError } from "../chat/failure";
import type { ToolGuard } from "./tool-guard";
import { MAX_TOOL_NAME_LENGTH, namespacedToolName, ToolNameError, UNUSABLE_NAME_CHARACTERS } from "./tool-names";
import type { ToolSource } from "./toolbox";

export interface McpServerSettings {
  name: string;
  url: string;
  authentication?: ClientAuthentication;
  filter?: { allow?: string[]; deny?: string[] };
  fetch: typeof fetch;
}

const connect = ({ url, authentication, filter, fetch }: McpServerSettings): Promise<McpConnection> =>
  mcpTools({ transport: { url, authentication }, tool_filter: filter }, { fetch });

function withoutEmptyText(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== ""));
}

function eachRequestWithin(send: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, stop.signal]) : stop.signal;
    try {
      return await send(input, { ...init, signal });
    } catch (error) {
      throw stop.signal.aborted && init?.signal?.aborted !== true ? new RequestTimeoutError() : error;
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function probeMcpServer(
  settings: McpServerSettings,
  timeoutMs: number,
): Promise<{ name: string; description?: string }[]> {
  const connection = await connect({ ...settings, fetch: eachRequestWithin(settings.fetch, timeoutMs) });
  await connection.close();
  return Object.entries(connection.tools).map(([name, tool]) => ({ name, description: tool.description }));
}

export function mcpToolSource(settings: McpServerSettings, guard: ToolGuard): ToolSource {
  let session: Promise<McpConnection> | null = null;

  function open(): Promise<McpConnection> {
    session ??= connect(settings).catch((error: unknown) => {
      session = null;
      throw error;
    });
    return session;
  }

  return {
    label: settings.name,
    serverId: settings.url,
    async close() {
      const pending = session;
      session = null;
      await pending?.then((connection) => connection.close()).catch(() => undefined);
    },
    async tools() {
      const { tools } = await open();
      const taken = new Set(Object.keys(tools).filter((name) => /^[A-Za-z0-9_-]+$/.test(name)));
      const set: ToolSet = {};
      for (const [original, tool] of Object.entries(tools)) {
        const usable = original.replace(UNUSABLE_NAME_CHARACTERS, "_");
        if (usable !== original) {
          if (taken.has(usable)) continue;
          taken.add(usable);
        }
        const name = namespacedToolName(settings.name, original);
        if (name.length > MAX_TOOL_NAME_LENGTH) {
          throw new ToolNameError(
            `The tool '${original}' of the server '${settings.name}' would be offered as '${name}', which is longer than the ` +
              `${MAX_TOOL_NAME_LENGTH} characters model providers allow. Give the server a shorter name in the agent file.`,
          );
        }
        set[name] = guard({
          name,
          serverId: settings.url,
          description: tool.description,
          inputSchema: tool.inputSchema,
          run: async (input: unknown, options: ToolCallOptions) =>
            (await tool.execute!(withoutEmptyText(input), options)) as ToolOutput,
        });
      }
      return set;
    },
  };
}
