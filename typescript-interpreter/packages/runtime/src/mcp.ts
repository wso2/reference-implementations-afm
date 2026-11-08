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


import type { ClientAuthentication } from "@afm/engine";
import { createMCPClient, type ListToolsResult, type MCPClient } from "@ai-sdk/mcp";
import { jsonSchema, tool, type ToolCallOptions, type ToolSet } from "ai";
import { authHeaders } from "./auth-headers";
import type { ToolOutput } from "./run";

export interface HttpMcpServer {
  transport: { url: string; authentication?: ClientAuthentication };
  tool_filter?: { allow?: string[]; deny?: string[] };
}

export interface McpOptions {
  fetch?: typeof fetch;
}

export interface McpConnection {
  tools: ToolSet;
  close(): Promise<void>;
}

type Definition = ListToolsResult["tools"][number];
type Result = { content?: unknown; structuredContent?: unknown; isError?: unknown };

const TIMEOUT_MS = 30_000;
const MAX_PAGES = 50;
const LOOPBACK = /^(localhost|\[::1\]|127(\.\d{1,3}){3})$/;
const SESSION_ENDED = "The server's session had ended (HTTP 404). The call was not repeated; the next call starts a new session.";
const NEVER_ENDS = "The server kept offering more pages of tools without ever finishing its list.";

function refuseCredentialsOverHttp(address: string, headers: Record<string, string>): void {
  const { protocol, host, hostname } = new URL(address);
  if (Object.keys(headers).length === 0 || protocol !== "http:" || LOOPBACK.test(hostname)) return;
  throw new Error(
    `Credentials were not sent to ${host} because it uses plain http://, where anyone on the network could read them. ` +
      "Use an https:// address (http://localhost is allowed).",
  );
}

async function listDefinitions(client: MCPClient): Promise<Definition[]> {
  const definitions: Definition[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.listTools({ params: cursor === undefined ? undefined : { cursor }, options: { timeout: TIMEOUT_MS } });
    definitions.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor === undefined || cursor === "") return definitions;
    if (seen.has(cursor)) break;
    seen.add(cursor);
  }
  throw new Error(NEVER_ENDS);
}

function blockText(block: { type?: string; text?: string; name?: string; uri?: string; resource?: { text?: string; uri?: string } }): string | undefined {
  if (block.type === "text") return block.text;
  if (block.type === "resource_link") return `[resource: ${block.name ?? block.uri}]`;
  if (block.type === "resource") return block.resource?.text ?? `[resource: ${block.resource?.uri}]`;
  return undefined;
}

export function toolOutput(result: Result): ToolOutput {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const texts = blocks.map(blockText).filter((text) => text !== undefined);
  const skipped = blocks.length - texts.length;
  if (result.structuredContent !== undefined) texts.push(JSON.stringify(result.structuredContent));
  const content =
    texts.length > 0
      ? texts.join("\n")
      : skipped > 0
        ? `(tool returned ${skipped} ${skipped === 1 ? "attachment" : "attachments"}, no text)`
        : "(tool returned no text content)";
  return { ok: result.isError !== true, content };
}

function isAllowed(name: string, filter: HttpMcpServer["tool_filter"]): boolean {
  return (filter?.allow === undefined || filter.allow.includes(name)) && filter?.deny?.includes(name) !== true;
}

export async function toolsFromClient(connect: () => Promise<MCPClient>, filter?: HttpMcpServer["tool_filter"]): Promise<McpConnection> {
  let session: Promise<MCPClient> | undefined = connect();
  const open = () => (session ??= connect());
  const first = await open();
  let definitions: Definition[];
  try {
    definitions = (await listDefinitions(first)).filter(({ name }) => isAllowed(name, filter));
  } catch (error) {
    await first.close().catch(() => undefined);
    throw error;
  }

  async function run(name: string, args: unknown, options: ToolCallOptions): Promise<ToolOutput> {
    const client = await open();
    try {
      const sdkTool = client.toolsFromDefinitions({ tools: definitions })[name];
      if (sdkTool?.execute === undefined) throw new Error(`The server no longer offers the tool '${name}'.`);
      return toolOutput((await sdkTool.execute(args, options)) as Result);
    } catch (error) {
      if ((error as { statusCode?: unknown }).statusCode !== 404) throw error;
      session = undefined;
      await client.close().catch(() => undefined);
      throw new Error(SESSION_ENDED);
    }
  }

  const tools: ToolSet = {};
  for (const definition of definitions) {
    if (Object.hasOwn(tools, definition.name)) throw new Error(`The server lists the tool '${definition.name}' more than once.`);
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: (args, options) => run(definition.name, args, options),
      toModelOutput: ({ output }) => ({ type: "text", value: output.content }),
    });
  }

  const close = async () => {
    const current = session;
    session = undefined;
    await (await current)?.close().catch(() => undefined);
  };
  return { tools, close };
}

export async function mcpTools(server: HttpMcpServer, { fetch }: McpOptions = {}): Promise<McpConnection> {
  const { url, authentication } = server.transport;
  const headers = authentication === undefined ? {} : authHeaders(authentication);
  refuseCredentialsOverHttp(url, headers);
  const connect = () =>
    createMCPClient({
      transport: { type: "http", url, headers, fetch, redirect: "error" },
      initializationOptions: { timeout: TIMEOUT_MS },
      maxRetries: 0,
      clientName: "afm",
    });
  return toolsFromClient(connect, server.tool_filter);
}
