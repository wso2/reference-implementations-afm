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

import { jsonSchema } from "ai";
import type { AgentSessionDeps } from "../core/runtime/session";
import { modelOf, type FakeEvent, type FakeModel } from "./test-model";
import { serverToolId } from "../core/tools/tool-names";
import { type ToolGuard } from "../core/tools/tool-guard";
import { type ToolSource } from "../core/tools/toolbox";

interface FakeTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  serverId?: string;
}

interface FakeToolPort {
  list(): Promise<FakeTool[]>;
  execute(call: { id: string; name: string; args: unknown; serverId?: string }, signal: AbortSignal): Promise<{ ok: boolean; content: string }>;
  dispose?(): Promise<void>;
}

interface InPageSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  run(args: unknown, signal: AbortSignal): string | Promise<string>;
}

export function inPageToolPort(specs: InPageSpec[]): FakeToolPort {
  return {
    list: async () => specs.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    execute: async (call, signal) => {
      const spec = specs.find((item) => item.name === call.name);
      if (spec === undefined) return { ok: false, content: `Unknown tool: ${call.name}` };
      try {
        return { ok: true, content: await spec.run(call.args, signal) };
      } catch (error) {
        return { ok: false, content: `Tool '${call.name}' failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  };
}

export function sourceOf(port: FakeToolPort, guard: ToolGuard, label?: string): ToolSource {
  const prefix = label === undefined ? "" : `${serverToolId(label)}__`;
  let serverId: string | undefined;
  return {
    label: label ?? "the tools",
    get serverId() {
      return serverId;
    },
    close: async () => {
      await port.dispose?.();
    },
    tools: async () => {
      const listed = await port.list();
      serverId = listed[0]?.serverId;
      return Object.fromEntries(
        listed.map((item) => [
          `${prefix}${item.name}`,
          guard({
            name: `${prefix}${item.name}`,
            serverId: item.serverId,
            description: item.description,
            inputSchema: jsonSchema(item.inputSchema as never),
            run: (args, options) =>
              port.execute({ id: options.toolCallId, name: `${prefix}${item.name}`, args, serverId: item.serverId }, options.abortSignal ?? new AbortController().signal),
          }),
        ]),
      );
    },
  };
}

type Overridable = Omit<AgentSessionDeps, "createModel" | "createTools">;

export interface FakeDeps extends Partial<Overridable> {
  createModel?: (model: unknown) => Promise<FakeModel>;
  createTools?: (metadata: Parameters<AgentSessionDeps["createTools"]>[0]) => FakeToolPort | ((guard: ToolGuard) => ToolSource[]);
}

const emptyPort = inPageToolPort([]);

export function sessionDeps(base: Overridable, overrides: FakeDeps = {}): AgentSessionDeps {
  const { createModel, createTools, ...rest } = overrides;
  return {
    ...base,
    ...rest,
    createModel: async (model) => modelOf(await (createModel ?? (async () => ({ async *stream() { yield { type: "finish", reason: "stop" } as FakeEvent; } })))(model)),
    createTools: (metadata, guard) => {
      const made = (createTools ?? (() => emptyPort))(metadata);
      return typeof made === "function" ? made(guard) : [sourceOf(made, guard)];
    },
  };
}

