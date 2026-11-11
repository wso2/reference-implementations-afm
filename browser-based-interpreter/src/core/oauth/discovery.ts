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

import { isHttps, isLocalAddress, parseUrl } from "../agent/addresses";

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  client_id_metadata_document_supported?: boolean;
  authorization_response_iss_parameter_supported?: boolean;
  response_types_supported?: string[];
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

// RFC 9207 and the MCP specification (2026-07-28, Authorization Response Validation): an issuer in the
// answer must equal the recorded one exactly, and a missing one is refused when the server said it sends one.
export function issuerIsWrong(metadata: AuthorizationServerMetadata | undefined, iss: string | undefined): boolean {
  if (metadata === undefined) return true;
  if (iss === undefined) return metadata.authorization_response_iss_parameter_supported === true;
  return iss !== metadata.issuer;
}

async function tryFetchJson<T>(url: string, fetchFn: typeof fetch): Promise<T | null> {
  try {
    const response = await fetchFn(url, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const finalUrl = response.url;
    if (isHttps(url) && finalUrl && !isHttps(finalUrl)) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function parseChallengeScope(wwwAuthenticate: string): string[] | null {
  const match = /(?:^|[,\s])scope="([^"]*)"/i.exec(wwwAuthenticate);
  if (match?.[1] === undefined || match[1].trim() === "") return null;
  return match[1].trim().split(/\s+/);
}

function namesServer(resource: string, serverUrl: string): boolean {
  const named = parseUrl(resource);
  const server = parseUrl(serverUrl);
  if (named === null || server === null) return false;
  const parent = named.pathname.endsWith("/") ? named.pathname : `${named.pathname}/`;
  return (
    named.origin === server.origin &&
    named.search === "" &&
    named.hash === "" &&
    (server.pathname === named.pathname || server.pathname.startsWith(parent))
  );
}

const NO_SIGN_IN_METADATA = "This server publishes no sign-in metadata. If this is an old address, use the server's current one.";
const SIGN_IN_METADATA_NAMES_OTHER = "This server's sign-in metadata does not name this server, so it was not used.";
const UNUSABLE_AUTHORIZATION_SERVER =
  "This server's authorization server publishes no metadata that passes the checks " +
  "(an https address, a matching issuer, the code response type, PKCE S256 and https endpoints), so it was not used.";

export class SignInRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRefusedError";
  }
}

export function advertisedMetadataUrl(challenge: string, serverUrl: string): URL | undefined {
  const advertised = parseUrl(/(?:^|[,\s])resource_metadata="([^"]+)"/i.exec(challenge)?.[1] ?? "");
  const server = parseUrl(serverUrl);
  return advertised !== null && server !== null && advertised.origin === server.origin ? advertised : undefined;
}

export function checkedResource(server: string | URL, resource: string | undefined): URL {
  if (resource === undefined) throw new SignInRefusedError(NO_SIGN_IN_METADATA);
  if (!namesServer(resource, String(server))) throw new SignInRefusedError(SIGN_IN_METADATA_NAMES_OTHER);
  return new URL(resource);
}

export async function challengeOf(serverUrl: string, fetchFn: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchFn(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
    });
    return response.status === 401 ? (response.headers.get("www-authenticate") ?? "") : null;
  } catch {
    return null;
  }
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
  if (!isHttps(issuerUrl)) return null;
  for (const candidate of authorizationServerCandidates(issuerUrl)) {
    const metadata = await tryFetchJson<AuthorizationServerMetadata>(candidate, fetchFn);
    if (
      metadata !== null &&
      metadata.issuer === issuerUrl &&
      Array.isArray(metadata.response_types_supported) &&
      metadata.response_types_supported.includes("code") &&
      Array.isArray(metadata.code_challenge_methods_supported) &&
      metadata.code_challenge_methods_supported.includes("S256") &&
      isHttps(metadata.authorization_endpoint) &&
      isHttps(metadata.token_endpoint)
    ) {
      return metadata;
    }
  }
  return null;
}

export async function checkedAuthorizationServer(issuerUrl: string, fetchFn: typeof fetch): Promise<AuthorizationServerMetadata> {
  const metadata = await discoverAuthorizationServer(issuerUrl, fetchFn);
  if (metadata === null) throw new SignInRefusedError(UNUSABLE_AUTHORIZATION_SERVER);
  return metadata;
}

export async function registerClient(
  registrationEndpoint: string,
  redirectUris: string[],
  fetchFn: typeof fetch,
): Promise<{ clientId: string }> {
  if (!isHttps(registrationEndpoint)) {
    throw new Error("Dynamic Client Registration needs an https endpoint");
  }
  const isLocal = redirectUris.some(isLocalAddress);
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
