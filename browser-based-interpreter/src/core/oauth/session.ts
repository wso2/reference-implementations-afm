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

import { isInsecure } from "../agent/addresses";
import {
  auth as authorize,
  type OAuthClientInformation,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import {
  advertisedMetadataUrl,
  type AuthorizationServerMetadata,
  challengeOf,
  checkedAuthorizationServer,
  checkedResource,
  issuerIsWrong,
  parseChallengeScope,
} from "./discovery";
import { bytesToBase64Url } from "../base64";
import { isDirectoryAddress } from "../mcp/mcp-directory";

export interface OAuthProviderRef {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
  resource: string;
}

export interface AuthorizationCodeConfig extends OAuthProviderRef {
  redirectUri: string;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void;
}

export interface AuthorizationCodeSession {
  hasSession(): boolean;
  accessToken(): string | null;
  renew(rejectedToken: string): Promise<boolean>;
  startSignIn(redirect: (url: string) => void, challenge?: string): Promise<AuthorizationServerMetadata>;
  completeSignIn(code: string, state: string, iss?: string): Promise<void>;
  declineSignIn(state: string, iss?: string): void;
  signOut(): void;
}

const lowerCase = (value: unknown): string => (typeof value === "string" ? value.toLowerCase() : "");

export function isInteractiveOAuth(auth: { type?: unknown; grant_type?: unknown } | undefined): boolean {
  return lowerCase(auth?.type) === "oauth2" && lowerCase(auth?.grant_type) === "authorization_code";
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

export function oauthProviderFrom(auth: Record<string, unknown>, resource: string): OAuthProviderRef {
  const scopes = Array.isArray(auth.scopes) ? auth.scopes.filter((scope): scope is string => typeof scope === "string") : undefined;
  return { authorizeUrl: textOf(auth.authorize_url), tokenUrl: textOf(auth.token_url), clientId: textOf(auth.client_id), scopes, resource };
}

type ProviderIdentity = Pick<OAuthProviderRef, "authorizeUrl" | "tokenUrl" | "clientId" | "resource">;

export function authorizationCodeProviderKey(config: ProviderIdentity): string {
  return JSON.stringify([config.authorizeUrl, config.tokenUrl, config.clientId, config.resource]);
}

export function authorizationCodeRefreshKey(config: ProviderIdentity): string {
  return `afm.oauth.${authorizationCodeProviderKey(config)}.refresh`;
}

interface Attempt {
  state: string;
  verifier: string;
  url: string;
  metadata?: AuthorizationServerMetadata;
  client?: OAuthClientInformation;
}

const SIGNED_OUT = "You signed out before the sign-in finished - please sign in again.";

export function createAuthorizationCodeSession(config: AuthorizationCodeConfig, store: KeyValueStore, fetchFn: typeof fetch): AuthorizationCodeSession {
  const refreshKey = authorizationCodeRefreshKey(config);
  const scope = config.scopes?.join(" ");
  let tokens: OAuthTokens | undefined;
  let client: OAuthClientInformation | undefined;
  let pending: Attempt | undefined;
  let renewing: Promise<boolean> | undefined;
  let metadataUrl: URL | undefined;
  let signOuts = 0;
  let generation = 0; // changes whenever the signed-in session is replaced: by a sign-out or by a new sign-in

  const secureFetch: typeof fetch = (input, init) =>
    isInsecure(String(input)) ? Promise.reject(new Error("Sign-in only talks to https:// addresses (http://localhost is allowed).")) : fetchFn(input, init);

  async function keepSaved(refreshToken: string | undefined): Promise<void> {
    try {
      if (refreshToken === undefined) store.remove(refreshKey);
      else await store.set(refreshKey, refreshToken);
    } catch {
      return;
    }
  }

  // Each run gets its own provider, tied to its own attempt (a renewal has none) and to the session that was current when it started.
  // What it learns after that session was replaced is old news: it must not touch the newer session.
  const providerFor = (attempt: Attempt | undefined): OAuthClientProvider => {
    let at = generation;
    return {
      redirectUrl: config.redirectUri,
      clientMetadata: {
        client_name: "AFM",
        redirect_uris: [config.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      clientInformation: () => (attempt === undefined ? client : attempt.client) ?? (config.clientId === "" ? undefined : { client_id: config.clientId }),
      saveClientInformation: (information) => {
        if (attempt === undefined) client = information;
        else attempt.client = information;
      },
      tokens: () => (attempt === undefined ? tokens : undefined),
      saveTokens: async (saved) => {
        if (generation !== at) return;
        if (attempt !== undefined) at = ++generation;
        tokens = saved;
        await keepSaved(saved.refresh_token);
        // A sign-out or a newer sign-in came while this was being written: make the saved copy match the session in memory again.
        if (generation !== at) await keepSaved(tokens?.refresh_token);
      },
      state: () => attempt?.state ?? "",
      saveCodeVerifier: (verifier) => {
        if (attempt !== undefined) attempt.verifier = verifier;
      },
      codeVerifier: () => attempt?.verifier ?? "",
      validateResourceURL: async (server, resource) => checkedResource(server, resource),
      validateAuthorizationServerURL: async (_server, authorizationServer) => {
        if (attempt !== undefined && attempt.metadata === undefined) {
          attempt.metadata = await checkedAuthorizationServer(String(authorizationServer), secureFetch);
        }
      },
      redirectToAuthorization: (url) => {
        if (attempt !== undefined) attempt.url = url.href;
      },
      invalidateCredentials: () => {
        if (generation === at) tokens = undefined;
      },
    };
  };

  const run = (attempt: Attempt | undefined, extra: { authorizationCode?: string; callbackState?: string } = {}) =>
    authorize(providerFor(attempt), { serverUrl: config.resource, resourceMetadataUrl: metadataUrl, scope, fetchFn: secureFetch, ...extra });

  function forget(): void {
    tokens = undefined;
    store.remove(refreshKey);
  }

  function takePending(state: string, iss: string | undefined): Attempt {
    const flow = pending;
    pending = undefined;
    if (flow === undefined) throw new Error("No OAuth2 sign-in is waiting for this answer - please sign in again.");
    if (state !== flow.state) throw new Error("OAuth2 sign-in state mismatch (possible CSRF) - please sign in again.");
    // A directory server is vetted and names its own login server, so no attacker can stand in between. Every other server is checked.
    if (!isDirectoryAddress(config.resource) && issuerIsWrong(flow.metadata, iss)) {
      throw new Error("The sign-in response did not come from the expected provider - please sign in again.");
    }
    return flow;
  }

  async function refresh(): Promise<boolean> {
    const at = generation;
    const renewed = await run(undefined).then((result) => result === "AUTHORIZED", () => false);
    if (generation === at && !renewed) forget();
    return generation === at && renewed;
  }

  return {
    hasSession: () => tokens !== undefined,
    accessToken: () => tokens?.access_token ?? null,

    renew(rejectedToken) {
      if (tokens?.access_token !== rejectedToken) return Promise.resolve(tokens !== undefined);
      if (tokens.refresh_token === undefined) {
        forget();
        return Promise.resolve(false);
      }
      renewing ??= refresh().finally(() => {
        renewing = undefined;
      });
      return renewing;
    },

    async startSignIn(redirect, challenge) {
      const attempt: Attempt = { state: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))), verifier: "", url: "" };
      const at = signOuts;
      metadataUrl = advertisedMetadataUrl(challenge ?? (await challengeOf(config.resource, secureFetch)) ?? "", config.resource);
      await run(attempt);
      if (signOuts !== at) throw new Error(SIGNED_OUT);
      if (attempt.metadata === undefined) throw new Error("The sign-in did not start.");
      pending = attempt;
      redirect(attempt.url);
      return attempt.metadata;
    },

    async completeSignIn(code, state, iss) {
      const flow = takePending(state, iss);
      const at = signOuts;
      await run(flow, { authorizationCode: code, callbackState: state });
      if (signOuts !== at) throw new Error(SIGNED_OUT);
      client = flow.client ?? client;
    },

    declineSignIn(state, iss) {
      takePending(state, iss);
    },

    signOut() {
      signOuts += 1;
      generation += 1;
      pending = undefined;
      forget();
    },
  };
}

const NO_STORE: KeyValueStore = { get: () => null, set: () => undefined, remove: () => undefined };

export async function discoverSignIn(
  serverUrl: string,
  { fetchFn, redirectUri }: { fetchFn: typeof fetch; redirectUri: string },
): Promise<{ metadata: AuthorizationServerMetadata; scopes: string[] | undefined } | null> {
  const challenge = await challengeOf(serverUrl, fetchFn);
  if (challenge === null) return null;
  const scopes = parseChallengeScope(challenge) ?? undefined;
  const session = createAuthorizationCodeSession({ authorizeUrl: "", tokenUrl: "", clientId: "discovery", redirectUri, resource: serverUrl, scopes }, NO_STORE, fetchFn);
  let address = "";
  const metadata = await session.startSignIn((url) => {
    address = url;
  }, challenge);
  return { metadata, scopes: new URL(address).searchParams.get("scope")?.split(" ") };
}
