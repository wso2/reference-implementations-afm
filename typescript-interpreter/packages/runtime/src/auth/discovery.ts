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

import type { OAuthProviderRef } from "./authorization-code";
import { isHttpsUrl, sameUrl } from "./utils";

interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  client_id_metadata_document_supported?: boolean;
  code_challenge_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
  scopes_supported?: string[];
}

async function tryFetchJson<T>(url: string, fetchFn: typeof fetch): Promise<T | null> {
  try {
    const response = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const finalUrl = response.url;
    if (isHttpsUrl(url) && finalUrl && !isHttpsUrl(finalUrl)) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function parseResourceMetadataUrl(wwwAuthenticate: string): string | null {
  const match = /(?:^|[,\s])resource_metadata="([^"]+)"/i.exec(wwwAuthenticate);
  return match?.[1] ?? null;
}

function isTrustedMetadataUrl(candidate: string, serverUrl: string): boolean {
  if (isHttpsUrl(candidate)) return true;
  try {
    return new URL(candidate).origin === new URL(serverUrl).origin;
  } catch {
    return false;
  }
}

export function parseChallengeScope(wwwAuthenticate: string): string[] | null {
  const match = /(?:^|[,\s])scope="([^"]*)"/i.exec(wwwAuthenticate);
  if (match?.[1] === undefined || match[1].trim() === "") return null;
  return match[1].trim().split(/\s+/);
}

function wellKnownProtectedResourceCandidates(serverUrl: string): string[] {
  const { origin, pathname } = new URL(serverUrl);
  const path = pathname === "/" ? "" : pathname;
  const root = `${origin}/.well-known/oauth-protected-resource`;
  return path === "" ? [root] : [`${root}${path}`, root];
}

function namesServer(resource: string, serverUrl: string): boolean {
  try {
    const named = new URL(resource);
    const server = new URL(serverUrl);
    const parent = named.pathname.endsWith("/") ? named.pathname : `${named.pathname}/`;
    return (
      named.origin === server.origin &&
      named.search === "" &&
      named.hash === "" &&
      (server.pathname === named.pathname || server.pathname.startsWith(parent))
    );
  } catch {
    return false;
  }
}

export class SignInRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRefusedError";
  }
}

interface ProtectedResourceDiscovery {
  metadata: ProtectedResourceMetadata;
  challengeScope: string[] | null;
}

async function probeServer(serverUrl: string, fetchFn: typeof fetch): Promise<Response | null> {
  try {
    return await fetchFn(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
    });
  } catch {
    return null;
  }
}

export async function discoverProtectedResource(serverUrl: string, fetchFn: typeof fetch): Promise<ProtectedResourceDiscovery | null> {
  const probe = await probeServer(serverUrl, fetchFn);
  if (probe === null || probe.status !== 401) return null;

  const challenge = probe.headers.get("www-authenticate");
  const challengeScope = challenge !== null ? parseChallengeScope(challenge) : null;
  const advertised = challenge !== null ? parseResourceMetadataUrl(challenge) : null;
  const fromHeader = advertised !== null && isTrustedMetadataUrl(advertised, serverUrl) ? advertised : null;
  const candidates = fromHeader !== null ? [fromHeader] : wellKnownProtectedResourceCandidates(serverUrl);

  let foundForOther = false;
  for (const candidate of candidates) {
    const metadata = await tryFetchJson<ProtectedResourceMetadata>(candidate, fetchFn);
    if (metadata === null || !Array.isArray(metadata.authorization_servers) || metadata.authorization_servers.length === 0) continue;
    if (namesServer(metadata.resource, serverUrl)) return { metadata, challengeScope };
    foundForOther = true;
  }
  throw new SignInRefusedError(
    foundForOther
      ? "This server's sign-in metadata does not name this server, so it was not used."
      : "This server publishes no sign-in metadata. If this is an old address, use the server's current one.",
  );
}

function authorizationServerCandidates(issuerUrl: string): string[] {
  const { origin, pathname } = new URL(issuerUrl);
  const path = pathname === "/" ? "" : pathname.replace(/\/$/, "");
  if (path === "") {
    return [`${origin}/.well-known/oauth-authorization-server`, `${origin}/.well-known/openid-configuration`];
  }
  return [
    `${origin}/.well-known/oauth-authorization-server${path}`,
    `${origin}/.well-known/openid-configuration${path}`,
    `${origin}${path}/.well-known/openid-configuration`,
  ];
}

export async function discoverAuthorizationServer(issuerUrl: string, fetchFn: typeof fetch): Promise<AuthorizationServerMetadata | null> {
  if (!isHttpsUrl(issuerUrl)) return null;
  let candidates: string[];
  try {
    candidates = authorizationServerCandidates(issuerUrl);
  } catch {
    return null;
  }
  for (const candidate of candidates) {
    const metadata = await tryFetchJson<AuthorizationServerMetadata>(candidate, fetchFn);
    if (
      metadata !== null &&
      metadata.issuer === issuerUrl &&
      Array.isArray(metadata.code_challenge_methods_supported) &&
      metadata.code_challenge_methods_supported.includes("S256") &&
      isHttpsUrl(metadata.authorization_endpoint) &&
      isHttpsUrl(metadata.token_endpoint)
    ) {
      return metadata;
    }
  }
  return null;
}

interface SignInDiscovery {
  metadata: AuthorizationServerMetadata;
  scopes: string[] | undefined;
  challengeScope: string[] | null;
  resource: string;
}

const MAX_AUTHORIZATION_SERVERS = 5;

async function firstUsableAuthorizationServer(issuers: string[], fetchFn: typeof fetch): Promise<AuthorizationServerMetadata | null> {
  for (const issuer of issuers.slice(0, MAX_AUTHORIZATION_SERVERS)) {
    const metadata = await discoverAuthorizationServer(issuer, fetchFn);
    if (metadata !== null) return metadata;
  }
  return null;
}

export async function discoverSignIn(serverUrl: string, fetchFn: typeof fetch): Promise<SignInDiscovery | null> {
  const resource = await discoverProtectedResource(serverUrl, fetchFn);
  if (resource === null) return null;
  const metadata = await firstUsableAuthorizationServer(resource.metadata.authorization_servers, fetchFn);
  if (metadata === null) {
    throw new SignInRefusedError(
      "This server's authorization server publishes no metadata that passes the checks " +
        "(an https address, a matching issuer, PKCE S256 and https endpoints), so it was not used.",
    );
  }
  return {
    metadata,
    scopes: resource.challengeScope ?? resource.metadata.scopes_supported,
    challengeScope: resource.challengeScope,
    resource: resource.metadata.resource,
  };
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function isLoopbackRedirect(uri: string): boolean {
  try {
    const { protocol, hostname } = new URL(uri);
    return (protocol === "http:" || protocol === "https:") && LOOPBACK_HOSTS.includes(hostname);
  } catch {
    return false;
  }
}

export async function registerClient(
  registrationEndpoint: string,
  redirectUris: string[],
  fetchFn: typeof fetch,
): Promise<{ clientId: string }> {
  if (!isHttpsUrl(registrationEndpoint)) {
    throw new Error("Dynamic Client Registration needs an https endpoint");
  }
  const isLocal = redirectUris.some(isLoopbackRedirect);
  const response = await fetchFn(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "AFM",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: isLocal ? "native" : "web",
    }),
  });
  if (!response.ok) {
    throw new Error(`Dynamic Client Registration failed: ${response.status}`);
  }
  const body = (await response.json()) as { client_id?: unknown };
  if (typeof body.client_id !== "string" || body.client_id === "") {
    throw new Error("Dynamic Client Registration response had no client_id");
  }
  return { clientId: body.client_id };
}

export async function resolveClientId(
  metadata: Pick<AuthorizationServerMetadata, "registration_endpoint" | "client_id_metadata_document_supported">,
  cimdClientId: string | undefined,
  redirectUri: string,
  fetchFn: typeof fetch,
): Promise<string> {
  if (cimdClientId !== undefined && cimdClientId !== "" && metadata.client_id_metadata_document_supported === true) return cimdClientId;
  if (metadata.registration_endpoint === undefined || metadata.registration_endpoint === "") return "";
  try {
    return (await registerClient(metadata.registration_endpoint, [redirectUri], fetchFn)).clientId;
  } catch {
    return "";
  }
}

export interface SignInServer {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  issuer: string;
  issuerSent: boolean;
  resource: string;
  scopes?: string[];
}

export async function discoverSignInServer(
  provider: OAuthProviderRef,
  deps: { fetchFn: typeof fetch; redirectUri: string; cimdClientId?: string },
): Promise<SignInServer> {
  const found = provider.resource === undefined ? null : await discoverSignIn(provider.resource, deps.fetchFn);
  if (found === null) {
    throw new Error("This server did not ask for a sign-in, or did not answer, so the sign-in was not started.");
  }
  const { metadata } = found;
  const sameServer = sameUrl(metadata.authorization_endpoint, provider.authorizeUrl) && sameUrl(metadata.token_endpoint, provider.tokenUrl);
  const clientId =
    sameServer && provider.clientId !== ""
      ? provider.clientId
      : await resolveClientId(metadata, deps.cimdClientId, deps.redirectUri, deps.fetchFn);
  if (clientId === "") {
    throw new Error("This server's sign-in needs a client ID, and none could be registered. Enter one in the server window.");
  }
  return {
    authorizeUrl: metadata.authorization_endpoint,
    tokenUrl: metadata.token_endpoint,
    clientId,
    issuer: metadata.issuer,
    issuerSent: metadata.authorization_response_iss_parameter_supported === true,
    resource: found.resource,
    ...(found.challengeScope === null ? {} : { scopes: found.challengeScope }),
  };
}
