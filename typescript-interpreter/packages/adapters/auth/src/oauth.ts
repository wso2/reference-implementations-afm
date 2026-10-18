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

import { discoverSignIn, resolveClientId } from "./discovery";

function binaryString(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return binary;
}

export function base64(value: string): string {
  return btoa(binaryString(new TextEncoder().encode(value)));
}

export function base64Url(bytes: Uint8Array): string {
  return btoa(binaryString(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function requireHttpsUrl(raw: string, field: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`This agent file's ${field} is not a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `This agent file's ${field} uses ${url.protocol}// - it must use https://. ` +
        "Sign-in credentials are never sent over an unencrypted connection.",
    );
  }
  return url.toString();
}

export interface OAuth2MachineConfig {
  grantType: "client_credentials" | "password" | "refresh_token" | "jwt_bearer";
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  refreshToken?: string;
  assertion?: string;
  scopes?: string[];
  credentialBearer?: "auth_header" | "post_body";
}

export type OAuth2MachineGrant = OAuth2MachineConfig["grantType"];

const MACHINE_GRANTS: readonly string[] = ["client_credentials", "password", "refresh_token", "jwt_bearer"];

export function isOAuth2MachineGrant(grant: string): grant is OAuth2MachineGrant {
  return MACHINE_GRANTS.includes(grant);
}

export function oauth2MachineConfig(
  grantType: OAuth2MachineGrant,
  auth: {
    token_url?: string;
    client_id?: string;
    client_secret?: string;
    username?: string;
    password?: string;
    refresh_token?: string;
    assertion?: string;
    scopes?: string[];
    credential_bearer?: string;
  },
): OAuth2MachineConfig {
  return {
    grantType,
    tokenUrl: auth.token_url ?? "",
    clientId: auth.client_id,
    clientSecret: auth.client_secret,
    username: auth.username,
    password: auth.password,
    refreshToken: auth.refresh_token,
    assertion: auth.assertion,
    scopes: auth.scopes,
    credentialBearer: auth.credential_bearer === "post_body" ? "post_body" : "auth_header",
  };
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

const JWT_BEARER_GRANT_URN = "urn:ietf:params:oauth:grant-type:jwt-bearer";

function tokenRequestBody(config: OAuth2MachineConfig): URLSearchParams {
  const body = new URLSearchParams();
  switch (config.grantType) {
    case "client_credentials":
      body.set("grant_type", "client_credentials");
      break;
    case "password":
      body.set("grant_type", "password");
      body.set("username", config.username ?? "");
      body.set("password", config.password ?? "");
      break;
    case "refresh_token":
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", config.refreshToken ?? "");
      break;
    case "jwt_bearer":
      body.set("grant_type", JWT_BEARER_GRANT_URN);
      body.set("assertion", config.assertion ?? "");
      break;
  }
  if (config.scopes !== undefined && config.scopes.length > 0) {
    body.set("scope", config.scopes.join(" "));
  }
  const bearer = config.credentialBearer ?? "auth_header";
  if (bearer === "post_body" && config.clientId !== undefined && config.clientSecret !== undefined) {
    body.set("client_id", config.clientId);
    body.set("client_secret", config.clientSecret);
  }
  return body;
}

const TOKEN_REQUEST_HEADERS = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };

function tokenRequestHeaders(config: OAuth2MachineConfig): Record<string, string> {
  const headers: Record<string, string> = { ...TOKEN_REQUEST_HEADERS };
  const bearer = config.credentialBearer ?? "auth_header";
  if (bearer === "auth_header" && config.clientId !== undefined && config.clientSecret !== undefined) {
    headers.authorization = `Basic ${base64(`${config.clientId}:${config.clientSecret}`)}`;
  }
  return headers;
}

async function requestToken(config: OAuth2MachineConfig, fetchFn: typeof fetch): Promise<{ token: string; expiresAt: number }> {
  const response = await fetchFn(requireHttpsUrl(config.tokenUrl, "token_url"), {
    method: "POST",
    headers: tokenRequestHeaders(config),
    body: tokenRequestBody(config),
  });
  if (!response.ok) {
    throw new Error(`OAuth2 token request failed: ${response.status}`);
  }
  const payload = (await response.json()) as TokenResponse;
  if (typeof payload.access_token !== "string") {
    throw new Error("OAuth2 token response did not contain 'access_token'");
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
  return { token: payload.access_token, expiresAt: Date.now() + expiresIn * 1000 - 30_000 };
}

export interface OAuth2MachineClient {
  getAccessToken(fetchFn?: typeof fetch): Promise<string>;
}

export function createOAuth2MachineClient(config: OAuth2MachineConfig): OAuth2MachineClient {
  let cached: { token: string; expiresAt: number } | null = null;

  return {
    async getAccessToken(fetchFn: typeof fetch = fetch): Promise<string> {
      if (cached !== null && Date.now() < cached.expiresAt) {
        return cached.token;
      }
      cached = await requestToken(config, fetchFn);
      return cached.token;
    },
  };
}

export interface OAuthProviderRef {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
  resource?: string;
}

export interface AuthorizationCodeConfig extends OAuthProviderRef {
  redirectUri: string;
}

const lowerCase = (value: unknown): string => (typeof value === "string" ? value.toLowerCase() : "");

export function isInteractiveOAuth(auth: { type?: unknown; grant_type?: unknown } | undefined): boolean {
  return lowerCase(auth?.type) === "oauth2" && lowerCase(auth?.grant_type) === "authorization_code";
}

export function oauthProviderFrom(
  auth: { authorize_url?: string; token_url?: string; client_id?: string; scopes?: string[] },
  resource?: string,
): OAuthProviderRef {
  return {
    authorizeUrl: auth.authorize_url ?? "",
    tokenUrl: auth.token_url ?? "",
    clientId: auth.client_id ?? "",
    scopes: auth.scopes,
    resource,
  };
}

export interface AuthorizationCodeTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void;
}

export function randomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function buildAuthorizeUrl(config: AuthorizationCodeConfig, params: { state: string; codeChallenge: string }): string {
  const url = new URL(requireHttpsUrl(config.authorizeUrl, "authorize_url"));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  if (config.scopes !== undefined && config.scopes.length > 0) {
    url.searchParams.set("scope", config.scopes.join(" "));
  }
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (config.resource !== undefined) {
    url.searchParams.set("resource", config.resource);
  }
  return url.toString();
}

interface RawTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

function toTokens(json: RawTokenResponse, fallbackRefresh?: string): AuthorizationCodeTokens {
  if (typeof json.access_token !== "string") {
    throw new Error("OAuth2 token response had no access_token");
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : fallbackRefresh;
  return { accessToken: json.access_token, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
}

export async function exchangeCodeForTokens(
  config: AuthorizationCodeConfig,
  code: string,
  verifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuthorizationCodeTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: verifier,
  });
  if (config.resource !== undefined) body.set("resource", config.resource);
  const response = await fetchFn(requireHttpsUrl(config.tokenUrl, "token_url"), { method: "POST", headers: TOKEN_REQUEST_HEADERS, body });
  if (!response.ok) {
    throw new Error(`OAuth2 token exchange failed: ${response.status}`);
  }
  return toTokens((await response.json()) as RawTokenResponse);
}

export async function refreshAuthorizationCodeTokens(
  config: AuthorizationCodeConfig,
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuthorizationCodeTokens> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: config.clientId });
  if (config.resource !== undefined) body.set("resource", config.resource);
  const response = await fetchFn(requireHttpsUrl(config.tokenUrl, "token_url"), { method: "POST", headers: TOKEN_REQUEST_HEADERS, body });
  if (!response.ok) {
    throw new Error(`OAuth2 token refresh failed: ${response.status}`);
  }
  return toTokens((await response.json()) as RawTokenResponse, refreshToken);
}

export function isExpired(tokens: AuthorizationCodeTokens, skewMs = 30_000): boolean {
  return Date.now() >= tokens.expiresAt - skewMs;
}

export function authorizationCodeProviderKey(
  config: Pick<AuthorizationCodeConfig, "authorizeUrl" | "tokenUrl" | "clientId" | "resource">,
): string {
  return JSON.stringify([config.authorizeUrl, config.tokenUrl, config.clientId, config.resource ?? null]);
}

export function authorizationCodeRefreshKey(
  config: Pick<AuthorizationCodeConfig, "authorizeUrl" | "tokenUrl" | "clientId" | "resource">,
): string {
  return `afm.oauth.${authorizationCodeProviderKey(config)}.refresh`;
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

export interface SignInServer {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  issuer: string;
  issuerSent: boolean;
  resource: string;
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
  };
}

export interface AuthorizationCodeSession {
  hasSession(): boolean;
  getAccessToken(fetchFn?: typeof fetch): Promise<string | null>;
  startSignIn(server: SignInServer, redirect: (url: string) => void): Promise<void>;
  completeSignIn(code: string, state: string, fetchFn?: typeof fetch, iss?: string): Promise<void>;
  declineSignIn(state: string, iss?: string): void;
  signOut(): void;
}

interface SignedIn {
  provider: AuthorizationCodeConfig;
  tokens: AuthorizationCodeTokens;
}

export function createAuthorizationCodeSession(
  config: AuthorizationCodeConfig,
  persistentStore: KeyValueStore,
): AuthorizationCodeSession {
  const REFRESH_KEY = authorizationCodeRefreshKey(config);
  let current: SignedIn | null = null;
  let pending: { verifier: string; state: string; server: SignInServer } | null = null;
  let refreshing: Promise<void> | null = null;

  const providerFor = (server: SignInServer): AuthorizationCodeConfig => ({
    ...config,
    authorizeUrl: server.authorizeUrl,
    tokenUrl: server.tokenUrl,
    clientId: server.clientId,
    resource: server.resource,
  });

  function takeFlow(state: string, iss: string | undefined): NonNullable<typeof pending> {
    const flow = pending;
    pending = null;
    if (flow === null) {
      throw new Error("No OAuth2 sign-in is waiting for this answer - please sign in again.");
    }
    if (state !== flow.state) {
      throw new Error("OAuth2 sign-in state mismatch (possible CSRF) - please sign in again.");
    }
    if (iss === undefined ? flow.server.issuerSent : iss !== flow.server.issuer) {
      throw new Error("The sign-in response did not come from the expected provider - please sign in again.");
    }
    return flow;
  }

  async function persist(): Promise<void> {
    if (current?.tokens.refreshToken !== undefined) {
      await persistentStore.set(REFRESH_KEY, current.tokens.refreshToken);
    }
  }

  async function refresh(from: SignedIn, refreshToken: string, fetchFn: typeof fetch): Promise<void> {
    const tokens = await refreshAuthorizationCodeTokens(from.provider, refreshToken, fetchFn);
    if (current !== from) return;
    current = { provider: from.provider, tokens };
    await persist();
  }

  return {
    hasSession(): boolean {
      return current !== null;
    },

    async getAccessToken(fetchFn: typeof fetch = fetch): Promise<string | null> {
      const signedIn = current;
      if (signedIn === null) return null;
      const refreshToken = signedIn.tokens.refreshToken;
      if (isExpired(signedIn.tokens) && refreshToken !== undefined) {
        refreshing ??= refresh(signedIn, refreshToken, fetchFn).finally(() => {
          refreshing = null;
        });
        await refreshing;
      }
      return current?.tokens.accessToken ?? null;
    },

    async startSignIn(server: SignInServer, redirect: (url: string) => void): Promise<void> {
      const { verifier, challenge } = await generatePkce();
      const state = randomString(16);
      const url = buildAuthorizeUrl(providerFor(server), { state, codeChallenge: challenge });
      pending = { verifier, state, server };
      redirect(url);
    },

    async completeSignIn(code: string, state: string, fetchFn: typeof fetch = fetch, iss?: string): Promise<void> {
      const flow = takeFlow(state, iss);
      const provider = providerFor(flow.server);
      const tokens = await exchangeCodeForTokens(provider, code, flow.verifier, fetchFn);
      current = { provider, tokens };
      persistentStore.remove(REFRESH_KEY);
      await persist();
    },

    declineSignIn(state: string, iss?: string): void {
      takeFlow(state, iss);
    },

    signOut(): void {
      current = null;
      persistentStore.remove(REFRESH_KEY);
    },
  };
}
