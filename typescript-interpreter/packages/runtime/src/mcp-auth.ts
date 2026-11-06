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

import { isOAuth2MachineGrant } from "@afm/engine";
import type { ClientAuthentication } from "@afm/engine";
import { base64, createOAuth2MachineClient, oauth2MachineConfig, oauthProviderFrom } from "./auth";
import type { OAuthProviderRef } from "./auth";

export class McpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAuthError";
  }
}

export type McpAuthHeaderProvider = (() => Promise<Record<string, string>>) & { invalidate?: () => void };

export interface McpDynamicAuthDeps {
  getInteractiveToken?: (provider: OAuthProviderRef) => Promise<string>;
  fetchFn?: typeof fetch;
  onInteractiveAuthRejected?: (provider: OAuthProviderRef) => void;
}

const bearerHeader = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

export function isDynamicAuthType(auth: ClientAuthentication): boolean {
  return auth.type.toLowerCase() === "oauth2";
}

export function mcpAuthHeaders(auth: ClientAuthentication): Record<string, string> {
  switch (auth.type.toLowerCase()) {
    case "bearer":
      if (!auth.token) {
        throw new McpAuthError("bearer authentication requires a 'token' field");
      }
      return bearerHeader(auth.token);

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

function interactiveHeaderProvider(auth: ClientAuthentication, deps: McpDynamicAuthDeps, resource?: string): McpAuthHeaderProvider {
  const { getInteractiveToken } = deps;
  if (getInteractiveToken === undefined) {
    throw new McpAuthError("oauth2 grant_type 'authorization_code' requires an interactive sign-in, which isn't available in this context");
  }
  const provider = oauthProviderFrom(auth, resource);
  return Object.assign(async () => bearerHeader(await getInteractiveToken(provider)), {
    invalidate: () => deps.onInteractiveAuthRejected?.(provider),
  });
}

function machineHeaderProvider(auth: ClientAuthentication, deps: McpDynamicAuthDeps, grant: string): McpAuthHeaderProvider {
  if (!isOAuth2MachineGrant(grant)) {
    throw new McpAuthError(`Unsupported oauth2 grant_type: '${auth.grant_type}'`);
  }
  const client = createOAuth2MachineClient(oauth2MachineConfig(grant, auth));
  return Object.assign(async () => bearerHeader(await client.getAccessToken(deps.fetchFn)), { invalidate: () => client.invalidate() });
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
  return grant === "authorization_code" ? interactiveHeaderProvider(auth, deps, resource) : machineHeaderProvider(auth, deps, grant);
}
