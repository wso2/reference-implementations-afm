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


export interface ProtectedResourceMetadata {
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
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function parseResourceMetadataUrl(wwwAuthenticate: string): string | null {
  const match = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate);
  return match?.[1] ?? null;
}

export function parseChallengeScope(wwwAuthenticate: string): string[] | null {
  const match = /(?:^|,)\s*scope="([^"]*)"/.exec(wwwAuthenticate);
  if (match?.[1] === undefined || match[1].trim() === "") return null;
  return match[1].split(/\s+/);
}

function wellKnownProtectedResourceCandidates(serverUrl: string): string[] {
  const { origin, pathname } = new URL(serverUrl);
  const path = pathname === "/" ? "" : pathname;
  return path === "" ? [`${origin}/.well-known/oauth-protected-resource`] : [`${origin}/.well-known/oauth-protected-resource${path}`, `${origin}/.well-known/oauth-protected-resource`];
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

export interface ProtectedResourceDiscovery {
  metadata: ProtectedResourceMetadata;
  challengeScope: string[] | null;
}

export async function discoverProtectedResource(serverUrl: string, fetchFn: typeof fetch): Promise<ProtectedResourceDiscovery | null> {
  let probe: Response;
  try {
    probe = await fetchFn(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
    });
  } catch {
    return null;
  }
  if (probe.status !== 401) return null;

  const challenge = probe.headers.get("www-authenticate");
  const challengeScope = challenge !== null ? parseChallengeScope(challenge) : null;
  const fromHeader = challenge !== null ? parseResourceMetadataUrl(challenge) : null;
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
      metadata.code_challenge_methods_supported.includes("S256")
    ) {
      return metadata;
    }
  }
  return null;
}

export interface SignInDiscovery {
  metadata: AuthorizationServerMetadata;
  scopes: string[] | undefined;
  resource: string;
}

export async function discoverSignIn(serverUrl: string, fetchFn: typeof fetch): Promise<SignInDiscovery | null> {
  const resource = await discoverProtectedResource(serverUrl, fetchFn);
  if (resource === null) return null;
  const issuer = resource.metadata.authorization_servers[0];
  const metadata = issuer === undefined ? null : await discoverAuthorizationServer(issuer, fetchFn);
  if (metadata === null) {
    throw new SignInRefusedError(
      "This server's authorization server publishes no metadata that passes the checks (a matching issuer and PKCE S256), so it was not used.",
    );
  }
  return { metadata, scopes: resource.challengeScope ?? resource.metadata.scopes_supported, resource: resource.metadata.resource };
}

export async function registerClient(
  registrationEndpoint: string,
  redirectUris: string[],
  fetchFn: typeof fetch,
): Promise<{ clientId: string }> {
  const isLocal = redirectUris.some((uri) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(uri));
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
  if (cimdClientId !== undefined && metadata.client_id_metadata_document_supported === true) return cimdClientId;
  if (metadata.registration_endpoint === undefined || metadata.registration_endpoint === "") return "";
  try {
    return (await registerClient(metadata.registration_endpoint, [redirectUri], fetchFn)).clientId;
  } catch {
    return "";
  }
}
