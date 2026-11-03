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

import {
  isInsecureAddress,
  type JsonSchema,
  type ToolCall,
  type ToolDescriptor,
  type ToolPort,
  type ToolResult,
  type ToolResultMedia,
} from "@afm/engine";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { McpAuthError, type McpAuthHeaderProvider } from "./mcp-auth";
import { lazy } from "./tool-ports";

interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: McpResourceContents;
}

type ContentPiece = { text: string } | { media: ToolResultMedia };

export function toToolDescriptor(
  tool: { name: string; description?: string; inputSchema?: unknown },
  serverId?: string,
): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: (tool.inputSchema ?? {}) as JsonSchema,
    serverId,
  };
}

function pieceOfResource(resource: McpResourceContents): ContentPiece | null {
  if (typeof resource.text === "string") return { text: resource.text };
  if (typeof resource.blob !== "string") return null;
  if (resource.mimeType?.startsWith("image/") === true) {
    return { media: { kind: "image", data: resource.blob, mediaType: resource.mimeType } };
  }
  return { text: `[resource: ${resource.uri}${resource.mimeType !== undefined ? ` (${resource.mimeType})` : ""}]` };
}

function pieceOf(block: McpContentBlock): ContentPiece | null {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? { text: block.text } : null;
    case "image":
    case "audio":
      return typeof block.data === "string" && typeof block.mimeType === "string"
        ? { media: { kind: block.type, data: block.data, mediaType: block.mimeType } }
        : null;
    case "resource_link":
      return { text: `[resource: ${block.name ?? block.uri ?? "unnamed"}]` };
    case "resource":
      return block.resource === undefined ? null : pieceOfResource(block.resource);
    default:
      return null;
  }
}

function summarize(text: string[], media: ToolResultMedia[]): string {
  if (text.length > 0) return text.join("\n");
  if (media.length > 0) return `(tool returned ${media.length} ${media.length === 1 ? "attachment" : "attachments"}, no text)`;
  return "(tool returned no text content)";
}

export function toToolResult(result: { content?: unknown; structuredContent?: unknown; isError?: unknown }): ToolResult {
  const blocks = Array.isArray(result.content) ? (result.content as McpContentBlock[]) : [];
  const pieces = blocks.flatMap((block) => pieceOf(block) ?? []);

  const text = pieces.flatMap((piece) => ("text" in piece ? [piece.text] : []));
  const media = pieces.flatMap((piece) => ("media" in piece ? [piece.media] : []));
  if (result.structuredContent !== undefined) {
    text.push(JSON.stringify(result.structuredContent));
  }

  return { ok: result.isError !== true, content: summarize(text, media), media: media.length > 0 ? media : undefined };
}

export interface McpHttpOptions {
  serverUrl: string;
  proxyUrl?: string;
  fetchFn?: typeof fetch;
  headers?: Record<string, string>;
  authHeaderProvider?: McpAuthHeaderProvider;
  onAuthRejected?: () => void;
  setupTimeoutMs?: number;
}

type ClientWork<T> = (client: Client) => Promise<T>;

const DEFAULT_SETUP_TIMEOUT_MS = 30_000;

const SESSION_ENDED_MESSAGE =
  "The server's session had ended (HTTP 404). The call was not repeated; the next call starts a new session.";

export function effectiveUrl(options: McpHttpOptions): URL {
  if (options.proxyUrl !== undefined && options.proxyUrl !== "") {
    const url = new URL(options.proxyUrl);
    url.searchParams.set("target", options.serverUrl);
    return url;
  }
  return new URL(options.serverUrl);
}

function isSessionEnded(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
}

async function refuseToRepeat(): Promise<never> {
  throw new Error(SESSION_ENDED_MESSAGE);
}

const MAX_TOOL_PAGES = 50;

const TOOL_LIST_NEVER_ENDED = "The server kept offering more pages of tools without ever finishing its list.";

export function mcpToolPort(options: McpHttpOptions): ToolPort {
  const setupTimeout = options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
  const session = lazy(() => connect(options, setupTimeout));

  async function dispose(): Promise<void> {
    const pending = session.discard();
    if (pending === null) return;
    await pending.then((client) => client.close()).catch(() => undefined);
  }

  const onSession = async <T>(work: ClientWork<T>): Promise<T> => work(await session.get());

  async function withClient<T>(work: ClientWork<T>, whenSessionEnded: () => Promise<T>): Promise<T> {
    try {
      return await onSession(work);
    } catch (error) {
      if (!isSessionEnded(error)) throw error;
      await dispose();
      return whenSessionEnded();
    }
  }

  return {
    async list(): Promise<ToolDescriptor[]> {
      const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const after = cursor;
        const listPage = (client: Client) =>
          client.listTools(after === undefined ? undefined : { cursor: after }, { timeout: setupTimeout });
        const result = await withClient(listPage, () => onSession(listPage));
        tools.push(...result.tools);
        cursor = result.nextCursor;
        if (cursor === undefined || cursor === "") {
          return tools.map((tool) => toToolDescriptor(tool, options.serverUrl));
        }
        if (seen.has(cursor)) break;
        seen.add(cursor);
      }
      throw new Error(TOOL_LIST_NEVER_ENDED);
    },

    async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      const callTool = (client: Client) =>
        client.callTool({ name: call.name, arguments: (call.args ?? {}) as Record<string, unknown> }, undefined, { signal });
      const result = await withClient(callTool, refuseToRepeat);
      return toToolResult({ content: result.content, structuredContent: result.structuredContent, isError: result.isError });
    },

    dispose,
  };
}

function dynamicAuthFetch(
  fetchFn: typeof fetch,
  staticHeaders: Record<string, string>,
  authHeaderProvider: McpAuthHeaderProvider,
  onAuthRejected?: () => void,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const dynamicHeaders = await authHeaderProvider();
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(staticHeaders)) headers.set(name, value);
    for (const [name, value] of Object.entries(dynamicHeaders)) headers.set(name, value);
    const response = await fetchFn(url, { ...init, headers });
    if (response.status === 401) {
      authHeaderProvider.invalidate?.();
      onAuthRejected?.();
    }
    return response;
  };
}

function carriesCredentials(options: McpHttpOptions): boolean {
  return options.authHeaderProvider !== undefined || Object.keys(options.headers ?? {}).length > 0;
}

function refuseInsecureCredentials(options: McpHttpOptions): void {
  if (!carriesCredentials(options)) return;
  const addresses = options.proxyUrl === undefined || options.proxyUrl === "" ? [options.serverUrl] : [options.proxyUrl, options.serverUrl];
  const insecure = addresses.find((address) => isInsecureAddress(address));
  if (insecure === undefined) return;
  throw new McpAuthError(
    `Credentials were not sent to ${new URL(insecure).host} because it uses plain http://, where anyone on the network could read them. ` +
      "Use an https:// address (http://localhost is allowed).",
  );
}

async function connect(options: McpHttpOptions, setupTimeout: number): Promise<Client> {
  refuseInsecureCredentials(options);
  const staticHeaders: Record<string, string> = { ...options.headers };
  const url = effectiveUrl(options);
  const fetchFn = options.fetchFn ?? fetch;
  const transport =
    options.authHeaderProvider === undefined
      ? new StreamableHTTPClientTransport(url, { requestInit: { headers: staticHeaders }, fetch: fetchFn })
      : new StreamableHTTPClientTransport(url, {
          fetch: dynamicAuthFetch(fetchFn, staticHeaders, options.authHeaderProvider, options.onAuthRejected),
        });

  const client = new Client({ name: "afm-runtime", version: "0.0.0" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  await client.connect(transport, { timeout: setupTimeout });
  return client;
}
