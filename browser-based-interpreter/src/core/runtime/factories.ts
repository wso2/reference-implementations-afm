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

import { checkModelKey, createAnthropicModel, createOpenAIModel, type KeyCheck } from "@afm/adapter-model";
import {
  compositeToolPort,
  createDynamicMcpAuthHeaderProvider,
  effectiveUrl,
  filteredToolPort,
  isDynamicAuthType,
  mcpAuthHeaders,
  type McpDynamicAuthDeps,
  mcpToolPort,
  namespacedToolPort,
} from "@afm/adapter-tool";
import { type AgentMetadata, type ModelPort, type SecretPort, type ToolPort } from "@afm/engine";
import { DEFAULT_PROVIDER } from "../agent/catalogs";
import { secretNameOf } from "../agent/secret-reference";
import { MissingCredentialError } from "../chat/failure";
import { limitBodies, limitResponses, MAX_AGENT_FILE_BYTES } from "./response-limit";
import { dropEmptyArgs } from "./tool-args";

interface McpProxyConfig {
  url: string;
}

function proxyFetch(proxy: McpProxyConfig): typeof fetch {
  return limitResponses(proxySessionFetch(proxy.url));
}

export function createProxiedFetch(proxy: McpProxyConfig, maxBytes?: number): typeof fetch {
  const send = limitBodies(proxySessionFetch(proxy.url), maxBytes);
  return (input, init) => send(effectiveUrl({ serverUrl: requestUrl(input), proxyUrl: proxy.url }), init);
}

const BUILD_TIME_PROXY_URL = import.meta.env.VITE_MCP_PROXY_URL;

export const defaultMcpProxyConfig: McpProxyConfig | null =
  BUILD_TIME_PROXY_URL !== undefined && BUILD_TIME_PROXY_URL !== "" ? { url: BUILD_TIME_PROXY_URL } : null;

function throughProxy(maxBytes?: number): typeof fetch {
  const proxy = defaultMcpProxyConfig;
  return proxy === null ? () => Promise.reject(new McpProxyRequiredError()) : createProxiedFetch(proxy, maxBytes);
}

export function proxyAwareFetch(): typeof fetch {
  return throughProxy();
}

export function agentFileFetch(): typeof fetch {
  return throughProxy(MAX_AGENT_FILE_BYTES);
}

export class McpProxyRequiredError extends Error {
  constructor() {
    super(
      "No MCP proxy is configured. AFM does not connect to external servers directly from the " +
        "browser - set an MCP proxy (VITE_MCP_PROXY_URL) before connecting tools.",
    );
    this.name = "McpProxyRequiredError";
  }
}

interface ToolSetupOptions {
  setupTimeoutMs?: number;
}

type McpServer = NonNullable<NonNullable<AgentMetadata["tools"]>["mcp"]>[number];

export function mcpServerPort(
  server: McpServer,
  proxy: McpProxyConfig | null,
  authDeps: McpDynamicAuthDeps = {},
  { setupTimeoutMs }: ToolSetupOptions = {},
): ToolPort | null {
  const { transport } = server;
  if (transport.type !== "http") return null;
  if (proxy === null) throw new McpProxyRequiredError();

  const effectiveAuthDeps: McpDynamicAuthDeps = {
    ...authDeps,
    fetchFn: authDeps.fetchFn ?? createProxiedFetch(proxy),
  };
  const auth = transport.authentication;
  const dynamic = auth !== undefined && isDynamicAuthType(auth);
  const port: ToolPort = dropEmptyArgs(
    mcpToolPort({
      serverUrl: transport.url,
      headers: auth !== undefined && !dynamic ? mcpAuthHeaders(auth) : undefined,
      authHeaderProvider: dynamic
        ? createDynamicMcpAuthHeaderProvider(auth, effectiveAuthDeps, transport.url)
        : undefined,
      proxyUrl: proxy.url,
      fetchFn: proxyFetch(proxy),
      setupTimeoutMs,
    }),
  );
  return server.tool_filter === undefined ? port : filteredToolPort(port, server.tool_filter);
}

export function toolsFromMetadata(
  metadata: AgentMetadata,
  proxy: McpProxyConfig | null,
  authDeps: McpDynamicAuthDeps = {},
  options: ToolSetupOptions = {},
): ToolPort {
  const servers = metadata.tools?.mcp ?? [];
  return compositeToolPort(
    servers.flatMap((server) => {
      const port = mcpServerPort(server, proxy, authDeps, options);
      return port === null ? [] : [namespacedToolPort(port, server.name)];
    }),
  );
}

const SESSION_HEADER = "X-Choreo-Correlation-Id";
const SESSION_ID_PREFIX = "afm-";
const SESSION_ID_MAX_LENGTH = 64;

let proxySessionId: string | null = null;

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

export function proxySessionFetch(proxyUrl: string, baseFetch?: typeof fetch): typeof fetch {
  const proxyOrigin = new URL(proxyUrl).origin;
  return async (input, init) => {
    const send = baseFetch ?? fetch;
    if (new URL(requestUrl(input)).origin !== proxyOrigin) return send(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (proxySessionId !== null) headers.set(SESSION_HEADER, proxySessionId);
    const response = await send(input, { ...init, headers });

    const issued = response.headers.get(SESSION_HEADER);
    if (issued !== null && issued.startsWith(SESSION_ID_PREFIX) && issued.length <= SESSION_ID_MAX_LENGTH) {
      proxySessionId = issued;
    }
    return response;
  };
}

function apiKeyOf(model: AgentMetadata["model"]): string | null {
  const auth = model?.authentication;
  const key = auth?.api_key ?? auth?.token ?? null;
  return key === null || key.trim() === "" ? null : key;
}

export async function modelWithResolvedKey(
  model: AgentMetadata["model"],
  keys: { enteredForModel(name: string): boolean; resolve: SecretPort["resolve"] },
): Promise<AgentMetadata["model"]> {
  const auth = model?.authentication;
  const field = auth?.api_key !== undefined ? "api_key" : "token";
  const raw = auth?.[field];
  const name = typeof raw === "string" ? secretNameOf(raw) : "";
  if (name === "") return model;
  if (!keys.enteredForModel(name)) throw new MissingCredentialError(name);
  const resolution = await keys.resolve({ prefix: "env", name, raw: raw! });
  if (resolution.status !== "resolved") throw new MissingCredentialError(name);
  return { ...model, authentication: { ...auth, type: auth?.type ?? "api-key", [field]: resolution.value } };
}

function unsupported(provider: string): Error {
  return new Error(`Unsupported model provider ${provider}. Use openai or anthropic.`);
}

export async function modelFromMetadata(model: AgentMetadata["model"]): Promise<ModelPort> {
  const provider = (model?.provider ?? DEFAULT_PROVIDER).toLowerCase();
  const name = model?.name;
  const apiKey = apiKeyOf(model);

  if (apiKey === null) {
    throw new Error("No API key was provided for the model.");
  }

  switch (provider) {
    case "openai":
      return createOpenAIModel({ apiKey, model: name });
    case "anthropic":
      return createAnthropicModel({ apiKey, model: name });
    default:
      throw unsupported(provider);
  }
}

export async function checkModelFromMetadata(model: AgentMetadata["model"]): Promise<KeyCheck> {
  const provider = (model?.provider ?? DEFAULT_PROVIDER).toLowerCase();
  const apiKey = apiKeyOf(model);

  if (apiKey === null) throw new MissingCredentialError("api_key");
  if (provider !== "openai" && provider !== "anthropic") throw unsupported(provider);
  return checkModelKey(provider, apiKey);
}
