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

import { type AuthorizationServerMetadata, discoverSignIn, resolveClientId } from "@afm/adapter-auth";
import { appAddress } from "../links/app-address";
import { proxyAwareFetch } from "../runtime/factories";
import { type OAuthSignIn } from "./mcp-directory";

export interface DiscoveredMcpAuth {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
}

export interface ClientSetup {
  fetchFn: typeof fetch;
  cimdClientId: string | undefined;
  redirectUri: string;
}

function browserSetup(): ClientSetup {
  return {
    fetchFn: proxyAwareFetch(),
    cimdClientId: import.meta.env.VITE_OAUTH_CLIENT_ID_URL || undefined,
    redirectUri: appAddress(window.location.origin, import.meta.env.BASE_URL),
  };
}

type Endpoints = Pick<
  AuthorizationServerMetadata,
  "authorization_endpoint" | "token_endpoint" | "registration_endpoint" | "client_id_metadata_document_supported"
>;

async function discoveredAuth(
  endpoints: Endpoints,
  scopes: string[] | undefined,
  { fetchFn, cimdClientId, redirectUri }: ClientSetup,
): Promise<DiscoveredMcpAuth> {
  return {
    authorizeUrl: endpoints.authorization_endpoint,
    tokenUrl: endpoints.token_endpoint,
    scopes,
    clientId: await resolveClientId(endpoints, cimdClientId, redirectUri, fetchFn),
  };
}

export async function discoverMcpServerAuth(
  serverUrl: string,
  setup: ClientSetup = browserSetup(),
): Promise<DiscoveredMcpAuth | null> {
  const found = await discoverSignIn(serverUrl, setup.fetchFn);
  return found === null ? null : discoveredAuth(found.metadata, found.scopes, setup);
}

export function resolveDirectoryClient(
  auth: OAuthSignIn,
  setup: ClientSetup = browserSetup(),
): Promise<DiscoveredMcpAuth> {
  return discoveredAuth(
    {
      authorization_endpoint: auth.authorizeUrl,
      token_endpoint: auth.tokenUrl,
      registration_endpoint: auth.registrationUrl,
      client_id_metadata_document_supported: auth.clientIdMetadata,
    },
    auth.scopes,
    setup,
  );
}
