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

import { describeError } from "@afm/engine";
import { type FlexibleSchema, type Tool, type ToolCallOptions, tool } from "ai";
import type { ToolOutput } from "./run";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  serverId?: string;
}

export interface PermissionBroker {
  request(call: ToolCall, signal: AbortSignal): Promise<"allow" | "deny">;
}

export const MAX_TOOL_RESULT_CHARS = 100_000;

const CANCELLED: ToolOutput = { ok: false, content: "Tool call was cancelled - the user stopped the run." };
const DENIED: ToolOutput = { ok: false, content: "Tool call was denied by the user." };
const NEVER_STOPPED = new AbortController().signal;

function clip(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  let cut = MAX_TOOL_RESULT_CHARS;
  const high = content.charCodeAt(cut - 1);
  const low = content.charCodeAt(cut);
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) cut -= 1;
  return `${content.slice(0, cut)}\n\nThe tool result was cut: only the first ${cut} of ${content.length} characters are shown.`;
}

interface ToolSpec<INPUT> {
  name: string;
  serverId?: string;
  description?: string;
  inputSchema: FlexibleSchema<INPUT>;
  run(input: INPUT, options: ToolCallOptions): Promise<string | ToolOutput>;
}

export type ToolGuard = <INPUT>(spec: ToolSpec<INPUT>) => Tool<INPUT, ToolOutput>;

export function createToolGuard(permission: PermissionBroker): ToolGuard {
  let queue: Promise<unknown> = Promise.resolve();

  async function guarded<INPUT>(spec: ToolSpec<INPUT>, input: INPUT, options: ToolCallOptions): Promise<ToolOutput> {
    const signal = options.abortSignal ?? NEVER_STOPPED;
    if (signal.aborted) return CANCELLED;
    try {
      const call = { id: options.toolCallId, name: spec.name, args: input, serverId: spec.serverId };
      if ((await permission.request(call, signal)) === "deny") return signal.aborted ? CANCELLED : DENIED;
      if (signal.aborted) return CANCELLED;
      const result = await spec.run(input, options);
      const { ok, content } = typeof result === "string" ? { ok: true, content: result } : result;
      return { ok, content: clip(content) };
    } catch (error) {
      if (signal.aborted) return CANCELLED;
      return { ok: false, content: `Tool '${spec.name}' failed: ${describeError(error)}` };
    }
  }

  return (spec) =>
    tool({
      description: spec.description,
      inputSchema: spec.inputSchema,
      execute: (input, options) => {
        const result = queue.then(() => guarded(spec, input, options));
        queue = result;
        return result;
      },
      toModelOutput: ({ output }) => ({ type: "text", value: output.content }),
    });
}
