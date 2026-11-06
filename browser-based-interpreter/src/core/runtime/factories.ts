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

import { type AgentMetadata, type SecretPort } from "@afm/engine";
import {
  checkModelKey,
  createDynamicMcpAuthHeaderProvider,
  createModel,
  effectiveUrl,
  isDynamicAuthType,
  type KeyCheck,
  type LanguageModel,
  mcpAuthHeaders,
  type McpDynamicAuthDeps,
  type McpServerOptions,
  mcpServerTools,
  type ToolGuard,
  type ToolSource,
} from "@afm/runtime";
import { DEFAULT_PROVIDER } from "../agent/catalogs";
import { secretNameOf } from "../agent/secret-reference";
import { MissingCredentialError } from "../chat/failure";
import { limitBodies, limitResponses, MAX_AGENT_FILE_BYTES } from "./response-limit";

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

export function mcpServerOptions(
  server: McpServer,
  proxy: McpProxyConfig | null,
  authDeps: McpDynamicAuthDeps = {},
  { setupTimeoutMs }: ToolSetupOptions = {},
): McpServerOptions | null {
  const { transport } = server;
  if (transport.type !== "http") return null;
  if (proxy === null) throw new McpProxyRequiredError();

  const auth = transport.authentication;
  const dynamic = auth !== undefined && isDynamicAuthType(auth);
  return {
    name: server.name,
    url: transport.url,
    headers: auth !== undefined && !dynamic ? mcpAuthHeaders(auth) : undefined,
    authHeaderProvider: dynamic ? createDynamicMcpAuthHeaderProvider(auth, authDeps, transport.url) : undefined,
    proxyUrl: proxy.url,
    fetchFn: proxyFetch(proxy),
    filter: server.tool_filter,
    setupTimeoutMs,
  };
}

function mcpServerSource(
  server: McpServer,
  proxy: McpProxyConfig | null,
  guard: ToolGuard,
  authDeps: McpDynamicAuthDeps = {},
  options: ToolSetupOptions = {},
): ToolSource | null {
  const built = mcpServerOptions(server, proxy, authDeps, options);
  return built === null ? null : mcpServerTools(built, guard);
}

export function toolsFromMetadata(
  metadata: AgentMetadata,
  proxy: McpProxyConfig | null,
  guard: ToolGuard,
  authDeps: McpDynamicAuthDeps = {},
  options: ToolSetupOptions = {},
): ToolSource[] {
  return (metadata.tools?.mcp ?? []).flatMap((server) => mcpServerSource(server, proxy, guard, authDeps, options) ?? []);
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

const providerOf = (model: AgentMetadata["model"]): string => (model?.provider ?? DEFAULT_PROVIDER).toLowerCase();

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

export async function modelFromMetadata(model: AgentMetadata["model"]): Promise<LanguageModel> {
  const apiKey = apiKeyOf(model);
  if (apiKey === null) throw new Error("No API key was provided for the model.");
  return createModel(providerOf(model), { apiKey, model: model?.name });
}

export async function checkModelFromMetadata(model: AgentMetadata["model"]): Promise<KeyCheck> {
  const apiKey = apiKeyOf(model);
  if (apiKey === null) throw new MissingCredentialError("api_key");
  return checkModelKey(providerOf(model), apiKey);
}
