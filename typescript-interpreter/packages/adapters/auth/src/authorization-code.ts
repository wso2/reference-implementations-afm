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

import { EXPIRY_SKEW_MS, expiryOf, postTokenRequest, requireHttpsUrl, TOKEN_REQUEST_HEADERS, type TokenPayload } from "./utils";

const lowerCase = (value: unknown): string => (typeof value === "string" ? value.toLowerCase() : "");

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

type ProviderIdentity = Pick<AuthorizationCodeConfig, "authorizeUrl" | "tokenUrl" | "clientId" | "resource">;

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

export function authorizationCodeProviderKey(config: ProviderIdentity): string {
  return JSON.stringify([config.authorizeUrl, config.tokenUrl, config.clientId, config.resource ?? null]);
}

export function authorizationCodeRefreshKey(config: ProviderIdentity): string {
  return `afm.oauth.${authorizationCodeProviderKey(config)}.refresh`;
}

export interface AuthorizationCodeTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
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

function toTokens(payload: TokenPayload, fallbackRefresh?: string): AuthorizationCodeTokens {
  if (typeof payload.access_token !== "string") {
    throw new Error("OAuth2 token response had no access_token");
  }
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : fallbackRefresh;
  return { accessToken: payload.access_token, refreshToken, expiresAt: expiryOf(payload) };
}

function requestTokens(
  config: AuthorizationCodeConfig,
  parameters: Record<string, string>,
  failure: string,
  fetchFn: typeof fetch,
): Promise<TokenPayload> {
  const body = new URLSearchParams(parameters);
  if (config.resource !== undefined) body.set("resource", config.resource);
  return postTokenRequest(config.tokenUrl, { headers: TOKEN_REQUEST_HEADERS, body }, failure, fetchFn);
}

export async function exchangeCodeForTokens(
  config: AuthorizationCodeConfig,
  code: string,
  verifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuthorizationCodeTokens> {
  const parameters = {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: verifier,
  };
  return toTokens(await requestTokens(config, parameters, "OAuth2 token exchange failed", fetchFn));
}

export async function refreshAuthorizationCodeTokens(
  config: AuthorizationCodeConfig,
  refreshToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<AuthorizationCodeTokens> {
  const parameters = { grant_type: "refresh_token", refresh_token: refreshToken, client_id: config.clientId };
  return toTokens(await requestTokens(config, parameters, "OAuth2 token refresh failed", fetchFn), refreshToken);
}

export function isExpired(tokens: AuthorizationCodeTokens, skewMs = EXPIRY_SKEW_MS): boolean {
  return Date.now() >= tokens.expiresAt - skewMs;
}
