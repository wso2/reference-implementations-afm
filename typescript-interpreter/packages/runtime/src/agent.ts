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


import { type Env, type LoadedAfm } from "@afm/engine";
import type { LanguageModel, ToolSet } from "ai";
import { authHeaders } from "./auth-headers";
import { type McpConnection, mcpTools } from "./mcp";
import { createModel } from "./model";
import { loadSkills } from "./skills";
import { stdioTools } from "./stdio";

export interface Agent {
  system: string;
  model: LanguageModel;
  tools: ToolSet;
  maxIterations?: number;
  close(): Promise<void>;
}

export async function createAgent(loaded: LoadedAfm, baseDir: string, env?: Env): Promise<Agent> {
  const { metadata } = loaded;
  const model = createModel(metadata.model, { env });
  const servers = metadata.tools?.mcp ?? [];
  for (const { transport } of servers) {
    if (transport.type === "http" && transport.authentication !== undefined) authHeaders(transport.authentication);
  }

  const connections: McpConnection[] = [];
  const tools: ToolSet = {};
  const owners = new Map<string, string>();
  const add = (owner: string, more: ToolSet) => {
    for (const [name, found] of Object.entries(more)) {
      if (owners.has(name)) throw new Error(`The tool '${name}' is offered by both '${owners.get(name)}' and '${owner}'. Hide one with a tool_filter.`);
      owners.set(name, owner);
      tools[name] = found;
    }
  };

  const errors: string[] = [];
  try {
    for (const server of servers) {
      try {
        const connection = await (server.transport.type === "stdio" ? stdioTools({ ...server, transport: server.transport }) : mcpTools({ ...server, transport: server.transport }));
        connections.push(connection);
        add(`tool server ${server.name}`, connection.tools);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("The tool '")) throw error;
        errors.push(`${server.name}: ${(error as Error).message}`);
        console.warn(`Skipping the tool server '${server.name}': ${(error as Error).message}`);
      }
    }
    if (servers.length > 0 && connections.length === 0) throw new Error(`Failed to connect to any tool server: ${errors.join("; ")}`);

    const skills = await loadSkills(metadata.skills ?? [], baseDir);
    if (skills !== undefined) add("the skills", skills.tools);
    return {
      system: skills === undefined ? loaded.systemPrompt : `${loaded.systemPrompt}\n\n${skills.catalog}`,
      model,
      tools,
      maxIterations: metadata.max_iterations,
      close: async () => void (await Promise.all(connections.map((connection) => connection.close()))),
    };
  } catch (error) {
    await Promise.all(connections.map((connection) => connection.close()));
    throw error;
  }
}
