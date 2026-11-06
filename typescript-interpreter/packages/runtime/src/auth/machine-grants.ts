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

import type { ClientAuthentication, OAuth2MachineGrant } from "@afm/engine";
import { base64, EXPIRY_SKEW_MS, expiryOf, postTokenRequest, TOKEN_REQUEST_HEADERS } from "./utils";

const JWT_BEARER_GRANT_URN = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export interface OAuth2MachineConfig {
  grantType: OAuth2MachineGrant;
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

interface OAuth2MachineClient {
  getAccessToken(fetchFn?: typeof fetch): Promise<string>;
  invalidate(): void;
}

type MachineAuthentication = Pick<
  ClientAuthentication,
  | "token_url"
  | "client_id"
  | "client_secret"
  | "username"
  | "password"
  | "refresh_token"
  | "assertion"
  | "scopes"
  | "credential_bearer"
>;

const GRANT_PARAMETERS: Record<OAuth2MachineGrant, (config: OAuth2MachineConfig) => Record<string, string>> = {
  client_credentials: () => ({ grant_type: "client_credentials" }),
  password: (config) => ({ grant_type: "password", username: config.username ?? "", password: config.password ?? "" }),
  refresh_token: (config) => ({ grant_type: "refresh_token", refresh_token: config.refreshToken ?? "" }),
  jwt_bearer: (config) => ({ grant_type: JWT_BEARER_GRANT_URN, assertion: config.assertion ?? "" }),
};

export function oauth2MachineConfig(grantType: OAuth2MachineGrant, auth: MachineAuthentication): OAuth2MachineConfig {
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

function credentialBearer(config: OAuth2MachineConfig): "auth_header" | "post_body" {
  return config.credentialBearer ?? "auth_header";
}

function hasClientCredentials(config: OAuth2MachineConfig): config is OAuth2MachineConfig & { clientId: string; clientSecret: string } {
  return config.clientId !== undefined && config.clientSecret !== undefined;
}

function tokenRequestBody(config: OAuth2MachineConfig): URLSearchParams {
  const body = new URLSearchParams(GRANT_PARAMETERS[config.grantType](config));
  if (config.scopes !== undefined && config.scopes.length > 0) {
    body.set("scope", config.scopes.join(" "));
  }
  if (credentialBearer(config) === "post_body" && hasClientCredentials(config)) {
    body.set("client_id", config.clientId);
    body.set("client_secret", config.clientSecret);
  }
  return body;
}

function formEncode(value: string): string {
  return new URLSearchParams([["", value]]).toString().slice(1);
}

function tokenRequestHeaders(config: OAuth2MachineConfig): Record<string, string> {
  const headers: Record<string, string> = { ...TOKEN_REQUEST_HEADERS };
  if (credentialBearer(config) === "auth_header" && hasClientCredentials(config)) {
    headers.authorization = `Basic ${base64(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`)}`;
  }
  return headers;
}

interface IssuedToken {
  token: string;
  expiresAt: number;
  refreshToken?: string;
}

async function requestToken(config: OAuth2MachineConfig, fetchFn: typeof fetch): Promise<IssuedToken> {
  const request = { headers: tokenRequestHeaders(config), body: tokenRequestBody(config) };
  const payload = await postTokenRequest(config.tokenUrl, request, "OAuth2 token request failed", fetchFn);
  if (typeof payload.access_token !== "string") {
    throw new Error("OAuth2 token response did not contain 'access_token'");
  }
  const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token !== "" ? payload.refresh_token : undefined;
  return { token: payload.access_token, expiresAt: expiryOf(payload) - EXPIRY_SKEW_MS, refreshToken };
}

export function createOAuth2MachineClient(config: OAuth2MachineConfig): OAuth2MachineClient {
  let cached: { token: string; expiresAt: number } | null = null;
  let current = config;
  let pending: Promise<string> | null = null;

  async function issue(fetchFn: typeof fetch): Promise<string> {
    const issued = await requestToken(current, fetchFn);
    if (config.grantType === "refresh_token" && issued.refreshToken !== undefined) {
      current = { ...current, refreshToken: issued.refreshToken };
    }
    cached = { token: issued.token, expiresAt: issued.expiresAt };
    return issued.token;
  }

  return {
    async getAccessToken(fetchFn: typeof fetch = fetch): Promise<string> {
      if (cached !== null && Date.now() < cached.expiresAt) {
        return cached.token;
      }
      pending ??= issue(fetchFn).finally(() => {
        pending = null;
      });
      return pending;
    },

    invalidate(): void {
      cached = null;
    },
  };
}
