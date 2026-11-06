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

import { isInsecureAddress } from "@afm/engine";
import { createMCPClient, type ListToolsResult, type MCPClient } from "@ai-sdk/mcp";
import { Validator } from "@cfworker/json-schema";
import { jsonSchema, type ToolCallOptions, type ToolSet } from "ai";
import { McpAuthError, type McpAuthHeaderProvider } from "./mcp-auth";
import type { ToolOutput } from "./run";
import type { ToolGuard } from "./tool-guard";
import { MAX_TOOL_NAME_LENGTH, SEPARATOR, serverToolId, ToolNameError, UNUSABLE_NAME_CHARACTERS } from "./tool-names";
import type { ToolSource } from "./toolbox";

interface McpBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri: string; mimeType?: string; text?: string; blob?: string };
}

const MEDIA = Symbol("media");

function pieceOf(block: McpBlock): string | typeof MEDIA | null {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : null;
    case "image":
    case "audio":
      return typeof block.data === "string" && typeof block.mimeType === "string" ? MEDIA : null;
    case "resource_link":
      return `[resource: ${block.name ?? block.uri ?? "unnamed"}]`;
    case "resource": {
      const { resource } = block;
      if (resource === undefined) return null;
      if (typeof resource.text === "string") return resource.text;
      if (typeof resource.blob !== "string") return null;
      if (resource.mimeType?.startsWith("image/") === true) return MEDIA;
      return `[resource: ${resource.uri}${resource.mimeType !== undefined ? ` (${resource.mimeType})` : ""}]`;
    }
    default:
      return null;
  }
}

export function toolOutput(result: { content?: unknown; structuredContent?: unknown; isError?: unknown }): ToolOutput {
  const pieces = (Array.isArray(result.content) ? (result.content as McpBlock[]) : []).map(pieceOf);
  const text = pieces.filter((piece) => typeof piece === "string");
  const attachments = pieces.filter((piece) => piece === MEDIA).length;
  if (result.structuredContent !== undefined) text.push(JSON.stringify(result.structuredContent));
  const content =
    text.length > 0
      ? text.join("\n")
      : attachments > 0
        ? `(tool returned ${attachments} ${attachments === 1 ? "attachment" : "attachments"}, no text)`
        : "(tool returned no text content)";
  return { ok: result.isError !== true, content };
}

function checkStructured(outputSchema: unknown, result: { structuredContent?: unknown; isError?: unknown }): void {
  if (outputSchema === undefined || result.isError === true) return;
  if (result.structuredContent === undefined) throw new Error("The tool has an output schema but returned no structured content.");
  const check = new Validator(outputSchema as ConstructorParameters<typeof Validator>[0], "2020-12", false).validate(result.structuredContent);
  if (!check.valid) {
    throw new Error(`The tool result does not match the tool's output schema: ${check.errors.map((e) => e.error).join("; ")}`);
  }
}

function withoutEmptyText(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== ""));
}

export interface McpServerOptions {
  name: string;
  url: string;
  proxyUrl?: string;
  fetchFn?: typeof fetch;
  headers?: Record<string, string>;
  authHeaderProvider?: McpAuthHeaderProvider;
  onAuthRejected?: () => void;
  filter?: { allow?: string[]; deny?: string[] };
  setupTimeoutMs?: number;
}

type Definition = ListToolsResult["tools"][number];

interface Loaded {
  client: MCPClient;
  definitions: Definition[];
  tools: Awaited<ReturnType<MCPClient["tools"]>>;
}

const DEFAULT_SETUP_TIMEOUT_MS = 30_000;
const MAX_TOOL_PAGES = 50;
const SESSION_ENDED = "The server's session had ended (HTTP 404). The call was not repeated; the next call starts a new session.";
const TOOL_LIST_NEVER_ENDED = "The server kept offering more pages of tools without ever finishing its list.";

export function effectiveUrl({ serverUrl, proxyUrl }: { serverUrl: string; proxyUrl?: string }): URL {
  if (proxyUrl === undefined || proxyUrl === "") return new URL(serverUrl);
  const url = new URL(proxyUrl);
  url.searchParams.set("target", serverUrl);
  return url;
}

function refuseInsecureCredentials(options: McpServerOptions): void {
  const carriesCredentials = options.authHeaderProvider !== undefined || Object.keys(options.headers ?? {}).length > 0;
  if (!carriesCredentials) return;
  const addresses = options.proxyUrl === undefined || options.proxyUrl === "" ? [options.url] : [options.proxyUrl, options.url];
  const insecure = addresses.find((address) => isInsecureAddress(address));
  if (insecure === undefined) return;
  throw new McpAuthError(
    `Credentials were not sent to ${new URL(insecure).host} because it uses plain http://, where anyone on the network could read them. ` +
      "Use an https:// address (http://localhost is allowed).",
  );
}

function withAuthHeaders({ fetchFn = fetch, authHeaderProvider, onAuthRejected }: McpServerOptions): typeof fetch {
  if (authHeaderProvider === undefined) return fetchFn;
  return async (url, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(await authHeaderProvider())) headers.set(name, value);
    const response = await fetchFn(url, { ...init, headers });
    if (response.status === 401) {
      authHeaderProvider.invalidate?.();
      onAuthRejected?.();
    }
    return response;
  };
}

async function listDefinitions(client: MCPClient, timeout: number): Promise<Definition[]> {
  const definitions: Definition[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const result = await client.listTools({ params: cursor === undefined ? undefined : { cursor }, options: { timeout } });
    definitions.push(...result.tools);
    cursor = result.nextCursor;
    if (cursor === undefined || cursor === "") return definitions;
    if (seen.has(cursor)) break;
    seen.add(cursor);
  }
  throw new Error(TOOL_LIST_NEVER_ENDED);
}

const isSessionEnded = (error: unknown): boolean => (error as { statusCode?: unknown } | null)?.statusCode === 404;

async function connect(options: McpServerOptions): Promise<Loaded> {
  refuseInsecureCredentials(options);
  const timeout = options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
  const client = await createMCPClient({
    transport: {
      type: "http",
      url: effectiveUrl({ serverUrl: options.url, proxyUrl: options.proxyUrl }).href,
      headers: options.headers,
      fetch: withAuthHeaders(options),
      redirect: "error",
    },
    initializationOptions: { timeout },
    maxRetries: 0,
    clientName: "afm-runtime",
    version: "0.0.0",
  });
  try {
    const definitions = await listDefinitions(client, timeout);
    return { client, definitions, tools: client.toolsFromDefinitions({ tools: definitions }) };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

const offeredBy = (filter: McpServerOptions["filter"]) => (definition: Definition) =>
  filter?.allow?.includes(definition.name) !== false && filter?.deny?.includes(definition.name) !== true;

export async function probeMcpServer(options: McpServerOptions): Promise<{ name: string; description?: string }[]> {
  const { client, definitions } = await connect(options);
  await client.close().catch(() => undefined);
  return definitions.filter(offeredBy(options.filter)).map(({ name, description }) => ({ name, description }));
}

export function mcpServerTools(options: McpServerOptions, guard: ToolGuard): ToolSource {
  const prefix = `${serverToolId(options.name)}${SEPARATOR}`;
  let session: Promise<Loaded> | null = null;

  function open(): Promise<Loaded> {
    session ??= connect(options).catch((error: unknown) => {
      session = null;
      throw error;
    });
    return session;
  }

  async function close(): Promise<void> {
    const pending = session;
    session = null;
    await pending?.then(({ client }) => client.close()).catch(() => undefined);
  }

  async function call(definition: Definition, args: unknown, callOptions: ToolCallOptions): Promise<ToolOutput> {
    const { tools } = await open();
    const sdkTool = tools[definition.name];
    if (sdkTool?.execute === undefined) throw new Error(`The server no longer offers the tool '${definition.name}'.`);
    let result: Parameters<typeof toolOutput>[0];
    try {
      result = (await sdkTool.execute(withoutEmptyText(args), callOptions)) as typeof result;
    } catch (error) {
      if (!isSessionEnded(error)) throw error;
      await close();
      throw new Error(SESSION_ENDED);
    }
    checkStructured((definition as { outputSchema?: unknown }).outputSchema, result);
    return toolOutput(result);
  }

  return {
    label: options.name,
    serverId: options.url,
    close,
    async tools() {
      const { definitions } = await open();
      const offered = definitions.filter(offeredBy(options.filter));
      const taken = new Set(offered.map(({ name }) => name).filter((name) => /^[A-Za-z0-9_-]+$/.test(name)));
      const set: ToolSet = {};
      for (const definition of offered) {
        const usable = definition.name.replace(UNUSABLE_NAME_CHARACTERS, "_");
        if (usable !== definition.name) {
          if (taken.has(usable)) continue;
          taken.add(usable);
        }
        const name = `${prefix}${usable}`;
        if (name.length > MAX_TOOL_NAME_LENGTH) {
          throw new ToolNameError(
            `The tool '${definition.name}' of the server '${options.name}' would be offered as '${name}', which is longer than the ` +
              `${MAX_TOOL_NAME_LENGTH} characters model providers allow. Give the server a shorter name in the agent file.`,
          );
        }
        if (Object.hasOwn(set, name)) {
          throw new ToolNameError(`The server '${options.name}' lists the tool '${definition.name}' more than once.`);
        }
        set[name] = guard({
          name,
          serverId: options.url,
          description: definition.description,
          inputSchema: jsonSchema(definition.inputSchema as Parameters<typeof jsonSchema>[0]),
          run: (input, callOptions) => call(definition, input, callOptions),
        });
      }
      return set;
    },
  };
}
