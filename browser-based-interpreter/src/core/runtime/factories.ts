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

import { type AgentMetadata } from "@afm/engine";
import { createModel, type LanguageModel } from "@afm/runtime";
import { isInsecure, parseUrl } from "../agent/addresses";
import type { McpServer } from "../agent/browser-agent";
import { DEFAULT_PROVIDER } from "../agent/catalogs";
import { MissingCredentialError } from "../chat/failure";
import { secretNameOf } from "../agent/secret-reference";
import { isInteractiveOAuth, type OAuthProviderRef, oauthProviderFrom } from "../oauth/session";
import { withSignIn } from "../oauth/sign-in-fetch";
import { type McpServerSettings, mcpToolSource, probeMcpServer } from "../tools/mcp-source";
import type { ToolGuard } from "../tools/tool-guard";
import type { ToolSource } from "../tools/toolbox";
import { completeText } from "./complete-text";
import { limitBodies, limitResponses, MAX_AGENT_FILE_BYTES } from "./response-limit";

export class McpProxyRequiredError extends Error {
  constructor() {
    super(
      "No MCP proxy is configured. AFM does not connect to external servers directly from the " +
        "browser - set an MCP proxy (VITE_MCP_PROXY_URL) before connecting tools.",
    );
    this.name = "McpProxyRequiredError";
  }
}

interface McpProxyConfig {
  url: string;
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function proxyTarget(input: RequestInfo | URL): string {
  const address = parseUrl(requestUrl(input));
  if (address === null || (address.protocol !== "https:" && address.protocol !== "http:")) {
    throw new Error("Only http and https addresses can be reached through the proxy.");
  }
  if (address.username !== "" || address.password !== "") {
    throw new Error("An address with a user name or password in it is not used. Put credentials in a key box instead.");
  }
  address.hash = "";
  return address.href;
}

function throughProxyUrl(proxy: McpProxyConfig, send: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(proxy.url);
    url.searchParams.set("target", proxyTarget(input));
    return send(url, init);
  };
}

export function createProxiedFetch(proxy: McpProxyConfig, maxBytes?: number): typeof fetch {
  return throughProxyUrl(proxy, limitBodies(proxySessionFetch(proxy.url), maxBytes));
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

interface SignInDeps {
  getInteractiveToken?: (provider: OAuthProviderRef) => Promise<string>;
  renewInteractiveToken?: (provider: OAuthProviderRef, rejectedToken: string) => Promise<boolean>;
}

export function mcpServerSettings(
  server: McpServer,
  proxy: McpProxyConfig | null,
  { getInteractiveToken, renewInteractiveToken }: SignInDeps = {},
): McpServerSettings | null {
  const { transport } = server;
  if (transport.type !== "http") return null;
  if (proxy === null) throw new McpProxyRequiredError();

  const auth = transport.authentication;
  if (auth !== undefined && isInsecure(proxy.url)) {
    throw new Error(
      `Credentials were not sent to ${new URL(proxy.url).host} because it uses plain http://, ` +
        "where anyone on the network could read them. Use an https:// address (http://localhost is allowed).",
    );
  }
  let send = throughProxyUrl(proxy, limitResponses(proxySessionFetch(proxy.url)));
  const interactive = auth !== undefined && isInteractiveOAuth(auth);
  if (interactive) {
    if (getInteractiveToken === undefined || renewInteractiveToken === undefined) {
      throw new Error(
        "oauth2 grant_type 'authorization_code' requires an interactive sign-in, which isn't available in this context",
      );
    }
    const provider = oauthProviderFrom(auth, transport.url);
    send = withSignIn(send, {
      token: () => getInteractiveToken(provider),
      renew: (rejected) => renewInteractiveToken(provider, rejected),
    });
  }
  return {
    name: server.name,
    url: transport.url,
    authentication: interactive ? undefined : auth,
    filter: server.tool_filter,
    fetch: send,
  };
}

export function toolsFromMetadata(
  metadata: AgentMetadata,
  proxy: McpProxyConfig | null,
  guard: ToolGuard,
  signIn: SignInDeps = {},
): ToolSource[] {
  return (metadata.tools?.mcp ?? []).flatMap((server) => {
    const settings = mcpServerSettings(server, proxy, signIn);
    return settings === null ? [] : mcpToolSource(settings, guard);
  });
}

export async function probeServerTools(
  server: McpServer,
  proxy: McpProxyConfig | null,
  signIn: SignInDeps,
  timeoutMs: number,
): Promise<{ name: string; description?: string }[]> {
  const settings = mcpServerSettings(server, proxy, signIn);
  return settings === null ? [] : probeMcpServer(settings, timeoutMs);
}

const DEFAULT_SESSION_HEADER = "X-Choreo-Correlation-Id";
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

export function sessionHeaderName(configured: string | undefined): string {
  return configured !== undefined && HEADER_NAME.test(configured) ? configured : DEFAULT_SESSION_HEADER;
}

const SESSION_HEADER = sessionHeaderName(import.meta.env.VITE_MCP_PROXY_SESSION_HEADER);
const SESSION_ID_PREFIX = "afm-";
const SESSION_ID_MAX_LENGTH = 64;

let proxySessionId: string | null = null;

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

export function modelWithResolvedKey(
  model: AgentMetadata["model"],
  keys: { enteredForModel(name: string, provider: string): boolean; valueOf(name: string): string | undefined },
): AgentMetadata["model"] {
  const auth = model?.authentication;
  const field = auth?.api_key !== undefined ? "api_key" : "token";
  const raw = auth?.[field];
  const name = typeof raw === "string" ? secretNameOf(raw) : "";
  if (name === "") return model;
  const value = keys.enteredForModel(name, providerOf(model)) ? keys.valueOf(name) : undefined;
  if (value === undefined) throw new MissingCredentialError(name);
  return { ...model, authentication: { ...auth, type: auth?.type ?? "api-key", [field]: value } };
}

const withAnthropicAccess: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("anthropic-dangerous-direct-browser-access", "true");
  return fetch(input, { ...init, headers });
};

export async function modelFromMetadata(model: AgentMetadata["model"]): Promise<LanguageModel> {
  if (apiKeyOf(model) === null) throw new Error("No API key was provided for the model.");
  const provider = providerOf(model);
  return createModel({ ...model, provider, url: undefined }, { fetch: provider === "anthropic" ? withAnthropicAccess : undefined });
}

const KEY_CHECK_TIMEOUT_MS = 25_000;

export async function checkModelFromMetadata(model: AgentMetadata["model"]): Promise<void> {
  if (apiKeyOf(model) === null) throw new MissingCredentialError("api_key");
  const languageModel = await modelFromMetadata(model);
  await completeText(languageModel, "Reply with the single word OK.", AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS));
}
