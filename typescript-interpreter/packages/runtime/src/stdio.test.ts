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


import { fileURLToPath } from "node:url";
import type { Tool } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import type { McpConnection } from "./mcp";
import { type StdioMcpServer, stdioTools } from "./stdio";

const script = fileURLToPath(new URL("./test-fixtures/stdio-server.mjs", import.meta.url));
const { env: processEnv } = (globalThis as unknown as { process: { env: Record<string, string | undefined>; execPath: string } }).process;
const { execPath } = (globalThis as unknown as { process: { execPath: string } }).process;

const server = (extra: Partial<StdioMcpServer> = {}): StdioMcpServer => ({ transport: { command: execPath, args: [script] }, ...extra });

async function text(connection: McpConnection, name: string): Promise<string> {
  const tool = connection.tools[name] as Tool;
  const output = (await tool.execute?.({}, { toolCallId: "c1", messages: [], abortSignal: new AbortController().signal })) as { ok: boolean; content: string };
  return output.content;
}

describe("a stdio MCP server", () => {
  const open: McpConnection[] = [];
  const start = async (config: StdioMcpServer) => {
    const connection = await stdioTools(config);
    open.push(connection);
    return connection;
  };
  afterEach(async () => {
    delete processEnv["AFM_PARENT_SECRET"];
    await Promise.all(open.splice(0).map((connection) => connection.close()));
  });

  it("lists the tools of a real child process and calls one", async () => {
    const connection = await start(server());
    expect(Object.keys(connection.tools)).toEqual(["from_file", "from_parent", "hidden"]);
    expect(await text(connection, "from_file")).toBe("unset");
  });

  it("starts the child with the env of the file", async () => {
    const connection = await start(server({ transport: { command: execPath, args: [script], env: { AFM_TEST_VALUE: "from-the-file" } } }));
    expect(await text(connection, "from_file")).toBe("from-the-file");
  });

  it("does not hand the rest of the parent's environment to the child", async () => {
    processEnv["AFM_PARENT_SECRET"] = "parent-secret";
    const connection = await start(server());
    expect(await text(connection, "from_parent")).toBe("unset");
  });

  it("applies the tool_filter", async () => {
    const connection = await start(server({ tool_filter: { deny: ["hidden"] } }));
    expect(Object.keys(connection.tools)).toEqual(["from_file", "from_parent"]);
  });

  it("refuses a command that does not exist", async () => {
    await expect(stdioTools({ transport: { command: "afm-no-such-command-anywhere" } })).rejects.toThrow();
  });
});
