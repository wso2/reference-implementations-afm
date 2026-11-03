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

import type { JsonSchema, ToolCall, ToolDescriptor, ToolPort, ToolResult } from "@afm/engine";

export interface Lazy<T> {
  get(): Promise<T>;
  discard(): Promise<T> | null;
}

export function lazy<T>(load: () => Promise<T>): Lazy<T> {
  let current: Promise<T> | null = null;

  return {
    get(): Promise<T> {
      if (current === null) {
        const pending = load();
        pending.catch(() => {
          if (current === pending) current = null;
        });
        current = pending;
      }
      return current;
    },

    discard(): Promise<T> | null {
      const pending = current;
      current = null;
      return pending;
    },
  };
}

export const MAX_TOOL_NAME_LENGTH = 64;

const SEPARATOR = "__";

const PROVIDER_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

export class ToolNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolNameError";
  }
}

export function serverToolId(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server";
}

const UNUSABLE_NAME_CHARACTERS = /[^A-Za-z0-9_-]/g;

function usableToolName(toolName: string): string {
  return toolName.replace(UNUSABLE_NAME_CHARACTERS, "_");
}

export function namespacedToolName(serverName: string, toolName: string): string {
  return `${serverToolId(serverName)}${SEPARATOR}${usableToolName(toolName)}`;
}

export function displayToolName(name: string): string {
  const separator = name.indexOf(SEPARATOR);
  return separator > 0 && /^[A-Za-z0-9-]+$/.test(name.slice(0, separator)) ? name.slice(separator + SEPARATOR.length) : name;
}

export function namespacedToolPort(inner: ToolPort, serverName: string): ToolPort {
  const prefix = `${serverToolId(serverName)}${SEPARATOR}`;
  const ownNames = new Map<string, string>();
  return {
    async list() {
      const tools = await inner.list();
      const taken = new Set(tools.map((tool) => tool.name).filter((name) => PROVIDER_TOOL_NAME.test(name)));
      ownNames.clear();
      return tools.flatMap((tool) => {
        const usable = usableToolName(tool.name);
        if (usable !== tool.name) {
          if (taken.has(usable)) return [];
          taken.add(usable);
        }
        const name = `${prefix}${usable}`;
        if (name.length > MAX_TOOL_NAME_LENGTH) {
          throw new ToolNameError(
            `The tool '${tool.name}' of the server '${serverName}' would be offered as '${name}', which is longer than the ` +
              `${MAX_TOOL_NAME_LENGTH} characters model providers allow. Give the server a shorter name in the agent file.`,
          );
        }
        ownNames.set(name, tool.name);
        return [{ ...tool, name, serverName }];
      });
    },

    async execute(call, signal) {
      if (!call.name.startsWith(prefix)) return { ok: false, content: `Unknown tool: ${call.name}` };
      return inner.execute({ ...call, name: ownNames.get(call.name) ?? call.name.slice(prefix.length) }, signal);
    },

    async dispose() {
      await inner.dispose?.();
    },
  };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const RETRY_INCOMPLETE_MS = 30_000;

export function compositeToolPort(ports: ToolPort[]): ToolPort {
  let generation = 0;
  let known: { routing: Routing; at: number } | null = null;
  let loading: Promise<Routing> | null = null;

  function load(): Promise<Routing> {
    if (loading === null) {
      const started = generation;
      const attempt = buildRouting(ports, () => generation !== started).then((routing) => {
        if (generation === started) known = { routing, at: Date.now() };
        return routing;
      });
      const settle = () => {
        if (loading === attempt) loading = null;
      };
      attempt.then(settle, settle);
      loading = attempt;
    }
    return loading;
  }

  async function routing(retryIncomplete: boolean): Promise<Routing> {
    if (known === null) return load();
    const earlier = known;
    if (!retryIncomplete || !earlier.routing.incomplete || Date.now() - earlier.at < RETRY_INCOMPLETE_MS) {
      return earlier.routing;
    }
    try {
      return await load();
    } catch {
      earlier.at = Date.now();
      return earlier.routing;
    }
  }

  return {
    async list(): Promise<ToolDescriptor[]> {
      const { descriptors } = await routing(true);
      return descriptors;
    },

    async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      const { owner } = await routing(false);
      const port = owner.get(call.name);
      if (port === undefined) {
        return { ok: false, content: `Unknown tool: ${call.name}` };
      }
      return port.execute(call, signal);
    },

    async dispose(): Promise<void> {
      generation += 1;
      known = null;
      loading = null;
      await Promise.all(ports.map((port) => port.dispose?.()));
    },
  };
}

interface Routing {
  descriptors: ToolDescriptor[];
  owner: Map<string, ToolPort>;
  incomplete: boolean;
}

function clashBetween(earlier: ToolDescriptor, later: ToolDescriptor): string {
  const source = (tool: ToolDescriptor): string => `'${tool.serverName ?? tool.serverId ?? "a built-in tool"}'`;
  const tool = `'${displayToolName(later.name)}'`;
  return source(earlier) === source(later)
    ? `The server ${source(later)} lists the tool ${tool} more than once.`
    : `The servers ${source(earlier)} and ${source(later)} both offer the tool ${tool} under the same name '${later.name}', ` +
        "so the agent could not tell them apart. Give one of the servers a different name in the agent file.";
}

async function buildRouting(ports: ToolPort[], disposed: () => boolean): Promise<Routing> {
  const descriptors: ToolDescriptor[] = [];
  const owner = new Map<string, ToolPort>();
  const offered = new Map<string, ToolDescriptor>();
  const failures: string[] = [];
  for (const port of ports) {
    if (disposed()) break;
    let tools: ToolDescriptor[];
    try {
      tools = await port.list();
    } catch (error) {
      if (error instanceof ToolNameError) throw error;
      failures.push(messageOf(error));
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
  return { descriptors, owner, incomplete: failures.length > 0 };
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
        return { ok: false, content: `Tool '${call.name}' failed: ${messageOf(error)}` };
      }
    },
  };
}
