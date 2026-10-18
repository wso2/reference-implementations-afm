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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import type { ClientAuthentication, ToolPort, ToolCall, ToolDescriptor, ToolResult, ToolResultMedia, JsonSchema } from "@afm/engine";
import { createOAuth2MachineClient, isOAuth2MachineGrant, oauth2MachineConfig, oauthProviderFrom, base64 } from "@afm/adapter-auth";
import type { OAuthProviderRef } from "@afm/adapter-auth";

export class McpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAuthError";
  }
}

export function isDynamicAuthType(auth: ClientAuthentication): boolean {
  return auth.type.toLowerCase() === "oauth2";
}

export function mcpAuthHeaders(auth: ClientAuthentication): Record<string, string> {
  switch (auth.type.toLowerCase()) {
    case "bearer":
      if (!auth.token) {
        throw new McpAuthError("bearer authentication requires a 'token' field");
      }
      return { Authorization: `Bearer ${auth.token}` };

    case "basic":
      if (!auth.username || !auth.password) {
        throw new McpAuthError("basic authentication requires 'username' and 'password' fields");
      }
      return { Authorization: `Basic ${base64(`${auth.username}:${auth.password}`)}` };

    case "api-key":
      if (!auth.api_key) {
        throw new McpAuthError("api-key authentication requires an 'api_key' field");
      }
      return { [auth.header_name ?? "Authorization"]: auth.api_key };

    case "oauth2":
      throw new McpAuthError("'oauth2' authentication needs createDynamicMcpAuthHeaderProvider, not mcpAuthHeaders");

    default:
      throw new McpAuthError(`Unsupported authentication type: '${auth.type}'`);
  }
}

export type McpAuthHeaderProvider = () => Promise<Record<string, string>>;

export interface McpDynamicAuthDeps {
  getInteractiveToken?: (provider: OAuthProviderRef) => Promise<string>;
  fetchFn?: typeof fetch;
  onInteractiveAuthRejected?: (provider: OAuthProviderRef) => void;
}

export function createDynamicMcpAuthHeaderProvider(
  auth: ClientAuthentication,
  deps: McpDynamicAuthDeps = {},
  resource?: string,
): McpAuthHeaderProvider {
  if (!isDynamicAuthType(auth)) {
    throw new McpAuthError(`'${auth.type}' authentication is not a dynamic auth type`);
  }

  const grant = auth.grant_type?.toLowerCase();
  if (grant === undefined) {
    throw new McpAuthError("oauth2 authentication requires a 'grant_type' field");
  }

  if (grant === "authorization_code") {
    if (deps.getInteractiveToken === undefined) {
      throw new McpAuthError(
        "oauth2 grant_type 'authorization_code' requires an interactive sign-in, which isn't available in this context",
      );
    }
    const { getInteractiveToken } = deps;
    const provider = oauthProviderFrom(auth, resource);
    return async () => ({ Authorization: `Bearer ${await getInteractiveToken(provider)}` });
  }

  if (!isOAuth2MachineGrant(grant)) {
    throw new McpAuthError(`Unsupported oauth2 grant_type: '${auth.grant_type}'`);
  }
  const client = createOAuth2MachineClient(oauth2MachineConfig(grant, auth));
  return async () => ({ Authorization: `Bearer ${await client.getAccessToken(deps.fetchFn)}` });
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

export function effectiveUrl(options: McpHttpOptions): URL {
  if (options.proxyUrl !== undefined && options.proxyUrl !== "") {
    const url = new URL(options.proxyUrl);
    url.searchParams.set("target", options.serverUrl);
    return url;
  }
  return new URL(options.serverUrl);
}

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

export function toToolResult(result: {
  content?: unknown;
  structuredContent?: unknown;
  isError?: unknown;
}): ToolResult {
  const blocks: McpContentBlock[] = Array.isArray(result.content)
    ? (result.content as McpContentBlock[])
    : [];

  const textParts: string[] = [];
  const media: ToolResultMedia[] = [];

  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (
      (block.type === "image" || block.type === "audio") &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      media.push({ kind: block.type, data: block.data, mediaType: block.mimeType });
    } else if (block.type === "resource_link") {
      textParts.push(`[resource: ${block.name ?? block.uri ?? "unnamed"}]`);
    } else if (block.type === "resource" && block.resource !== undefined) {
      const resource = block.resource;
      if (typeof resource.text === "string") {
        textParts.push(resource.text);
      } else if (typeof resource.blob === "string" && resource.mimeType?.startsWith("image/") === true) {
        media.push({ kind: "image", data: resource.blob, mediaType: resource.mimeType });
      } else if (typeof resource.blob === "string") {
        textParts.push(`[resource: ${resource.uri}${resource.mimeType !== undefined ? ` (${resource.mimeType})` : ""}]`);
      }
    }
  }

  if (result.structuredContent !== undefined) {
    textParts.push(JSON.stringify(result.structuredContent));
  }

  const content =
    textParts.length > 0
      ? textParts.join("\n")
      : media.length > 0
        ? `(tool returned ${media.length} ${media.length === 1 ? "attachment" : "attachments"}, no text)`
        : "(tool returned no text content)";

  return { ok: result.isError !== true, content, media: media.length > 0 ? media : undefined };
}

const DEFAULT_SETUP_TIMEOUT_MS = 30_000;

export function mcpToolPort(options: McpHttpOptions): ToolPort {
  const setupTimeout = options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
  let clientPromise: Promise<Client> | null = null;

  function getClient(): Promise<Client> {
    if (clientPromise === null) {
      const pending = connect(options, setupTimeout);
      pending.catch(() => {
        if (clientPromise === pending) clientPromise = null;
      });
      clientPromise = pending;
    }
    return clientPromise;
  }

  async function dispose(): Promise<void> {
    if (clientPromise === null) return;
    const pending = clientPromise;
    clientPromise = null;
    try {
      await (await pending).close();
    } catch {
    }
  }

  async function withClient<T>(work: (client: Client) => Promise<T>, repeatable: boolean): Promise<T> {
    try {
      return await work(await getClient());
    } catch (error) {
      if (!(error instanceof StreamableHTTPError && error.code === 404)) throw error;
      await dispose();
      if (!repeatable) {
        throw new Error("The server's session had ended (HTTP 404). The call was not repeated; the next call starts a new session.");
      }
      return work(await getClient());
    }
  }

  return {
    async list(): Promise<ToolDescriptor[]> {
      const result = await withClient((client) => client.listTools(undefined, { timeout: setupTimeout }), true);
      return result.tools.map((tool) => toToolDescriptor(tool, options.serverUrl));
    },

    async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      const result = await withClient(
        (client) => client.callTool({ name: call.name, arguments: (call.args ?? {}) as Record<string, unknown> }, undefined, { signal }),
        false,
      );
      return toToolResult({
        content: result.content,
        structuredContent: result.structuredContent,
        isError: result.isError,
      });
    },

    dispose,
  };
}

async function connect(options: McpHttpOptions, setupTimeout: number): Promise<Client> {
  const staticHeaders: Record<string, string> = { ...options.headers };

  const url = effectiveUrl(options);
  const fetchFn = options.fetchFn ?? fetch;
  const transport =
    options.authHeaderProvider === undefined
      ? new StreamableHTTPClientTransport(url, { requestInit: { headers: staticHeaders }, fetch: fetchFn })
      : new StreamableHTTPClientTransport(url, {
          fetch: dynamicAuthFetch(fetchFn, staticHeaders, options.authHeaderProvider, options.onAuthRejected),
        });

  const client = new Client(
    { name: "afm-runtime", version: "0.0.0" },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );
  await client.connect(transport, { timeout: setupTimeout });
  return client;
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
      onAuthRejected?.();
    }
    return response;
  };
}
