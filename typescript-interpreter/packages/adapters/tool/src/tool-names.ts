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

import type { ToolPort } from "@afm/engine";

export const MAX_TOOL_NAME_LENGTH = 64;

const SEPARATOR = "__";

export class ToolNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolNameError";
  }
}

export function serverToolId(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server";
}

export function namespacedToolName(serverName: string, toolName: string): string {
  return `${serverToolId(serverName)}${SEPARATOR}${toolName}`;
}

export function displayToolName(name: string): string {
  const separator = name.indexOf(SEPARATOR);
  return separator > 0 && /^[A-Za-z0-9-]+$/.test(name.slice(0, separator)) ? name.slice(separator + SEPARATOR.length) : name;
}

export function namespacedToolPort(inner: ToolPort, serverName: string): ToolPort {
  const prefix = `${serverToolId(serverName)}${SEPARATOR}`;
  return {
    async list() {
      return (await inner.list()).map((tool) => {
        const name = `${prefix}${tool.name}`;
        if (name.length > MAX_TOOL_NAME_LENGTH) {
          throw new ToolNameError(
            `The tool '${tool.name}' of the server '${serverName}' would be offered as '${name}', which is longer than the ` +
              `${MAX_TOOL_NAME_LENGTH} characters model providers allow. Give the server a shorter name in the agent file.`,
          );
        }
        return { ...tool, name, serverName };
      });
    },

    async execute(call, signal) {
      if (!call.name.startsWith(prefix)) return { ok: false, content: `Unknown tool: ${call.name}` };
      return inner.execute({ ...call, name: call.name.slice(prefix.length) }, signal);
    },

    async dispose() {
      await inner.dispose?.();
    },
  };
}
