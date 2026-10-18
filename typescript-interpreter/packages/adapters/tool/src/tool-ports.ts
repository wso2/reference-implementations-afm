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

import type { ToolPort, ToolCall, ToolDescriptor, ToolResult, JsonSchema } from "@afm/engine";
import { ToolNameError, displayToolName } from "./tool-names";

export function compositeToolPort(ports: ToolPort[]): ToolPort {
  let routing: Promise<Routing> | null = null;

  function resolve(): Promise<Routing> {
    if (routing === null) {
      const pending = buildRouting(ports);
      pending.catch(() => {
        if (routing === pending) routing = null;
      });
      routing = pending;
    }
    return routing;
  }

  return {
    async list(): Promise<ToolDescriptor[]> {
      const { descriptors } = await resolve();
      return descriptors;
    },

    async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      const { owner } = await resolve();
      const port = owner.get(call.name);
      if (port === undefined) {
        return { ok: false, content: `Unknown tool: ${call.name}` };
      }
      return port.execute(call, signal);
    },

    async dispose(): Promise<void> {
      routing = null;
      await Promise.all(ports.map((port) => port.dispose?.()));
    },
  };
}

interface Routing {
  descriptors: ToolDescriptor[];
  owner: Map<string, ToolPort>;
}

function clashBetween(earlier: ToolDescriptor, later: ToolDescriptor): string {
  const source = (tool: ToolDescriptor): string => `'${tool.serverName ?? tool.serverId ?? "a built-in tool"}'`;
  const tool = `'${displayToolName(later.name)}'`;
  return source(earlier) === source(later)
    ? `The server ${source(later)} lists the tool ${tool} more than once.`
    : `The servers ${source(earlier)} and ${source(later)} both offer the tool ${tool} under the same name '${later.name}', ` +
        "so the agent could not tell them apart. Give one of the servers a different name in the agent file.";
}

async function buildRouting(ports: ToolPort[]): Promise<Routing> {
  const descriptors: ToolDescriptor[] = [];
  const owner = new Map<string, ToolPort>();
  const offered = new Map<string, ToolDescriptor>();
  const failures: string[] = [];
  for (const port of ports) {
    let tools: ToolDescriptor[];
    try {
      tools = await port.list();
    } catch (error) {
      if (error instanceof ToolNameError) throw error;
      failures.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const tool of tools) {
      const earlier = offered.get(tool.name);
      if (earlier !== undefined) throw new ToolNameError(clashBetween(earlier, tool));
      offered.set(tool.name, tool);
      owner.set(tool.name, port);
      descriptors.push(tool);
    }
  }
  if (descriptors.length === 0 && failures.length > 0) {
    throw new Error(`No tools could be loaded: ${failures.join("; ")}`);
  }
  return { descriptors, owner };
}

export interface ToolFilter {
  allow?: string[];
  deny?: string[];
}

function isAllowed(name: string, filter: ToolFilter): boolean {
  if (filter.allow !== undefined && !filter.allow.includes(name)) return false;
  if (filter.deny !== undefined && filter.deny.includes(name)) return false;
  return true;
}

export function filteredToolPort(inner: ToolPort, filter: ToolFilter): ToolPort {
  return {
    async list(): Promise<ToolDescriptor[]> {
      const tools = await inner.list();
      return tools.filter((tool) => isAllowed(tool.name, filter));
    },

    async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      if (!isAllowed(call.name, filter)) {
        return { ok: false, content: `Tool '${call.name}' is not allowed by this agent's tool_filter.` };
      }
      return inner.execute(call, signal);
    },

    async dispose(): Promise<void> {
      await inner.dispose?.();
    },
  };
}

export interface InPageTool {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  run(args: unknown, signal: AbortSignal): Promise<string> | string;
}

export function inPageToolPort(tools: InPageTool[]): ToolPort {
  const byName = new Map<string, InPageTool>();
  for (const tool of tools) {
    byName.set(tool.name, tool);
  }
  const unique = [...byName.values()];

  return {
    async list(): Promise<ToolDescriptor[]> {
      return unique.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    },

    async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      const tool = byName.get(call.name);
      if (tool === undefined) {
        return { ok: false, content: `Unknown tool: ${call.name}` };
      }
      try {
        const output = await tool.run(call.args, signal);
        return { ok: true, content: output };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, content: `Tool '${call.name}' failed: ${message}` };
      }
    },
  };
}
