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

import {
  type AuthorizationCodeConfig,
  authorizationCodeRefreshKey,
  type AuthorizationCodeTokens,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  isExpired,
  refreshAuthorizationCodeTokens,
} from "./authorization-code";
import type { SignInServer } from "./discovery";
import { generatePkce, isGrantRejected, randomString } from "./utils";

const SIGNED_OUT = "You signed out before the sign-in finished - please sign in again.";

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void | Promise<void>;
  remove(key: string): void;
}

export interface CompleteSignInOptions {
  fetchFn?: typeof fetch;
  iss?: string;
}

export interface AuthorizationCodeSession {
  hasSession(): boolean;
  getAccessToken(fetchFn?: typeof fetch): Promise<string | null>;
  startSignIn(server: SignInServer, redirect: (url: string) => void): Promise<void>;
  completeSignIn(code: string, state: string, options?: CompleteSignInOptions): Promise<void>;
  declineSignIn(state: string, iss?: string): void;
  signOut(): void;
}

interface SignedIn {
  provider: AuthorizationCodeConfig;
  tokens: AuthorizationCodeTokens;
}

interface PendingSignIn {
  verifier: string;
  state: string;
  server: SignInServer;
}

function providerFor(config: AuthorizationCodeConfig, server: SignInServer): AuthorizationCodeConfig {
  return {
    ...config,
    authorizeUrl: server.authorizeUrl,
    tokenUrl: server.tokenUrl,
    clientId: server.clientId,
    resource: server.resource,
    scopes: config.scopes !== undefined && config.scopes.length > 0 ? config.scopes : server.scopes,
  };
}

function verifyAnswer(flow: PendingSignIn | null, state: string, iss: string | undefined): PendingSignIn {
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

class CodeSession implements AuthorizationCodeSession {
  readonly #config: AuthorizationCodeConfig;
  readonly #store: KeyValueStore;
  readonly #refreshKey: string;
  #current: SignedIn | null = null;
  #pending: PendingSignIn | null = null;
  #refreshing: { session: SignedIn; promise: Promise<void> } | null = null;
  #signOuts = 0;
  #signIns = 0;

  constructor(config: AuthorizationCodeConfig, store: KeyValueStore) {
    this.#config = config;
    this.#store = store;
    this.#refreshKey = authorizationCodeRefreshKey(config);
  }

  hasSession(): boolean {
    return this.#current !== null;
  }

  async getAccessToken(fetchFn: typeof fetch = fetch): Promise<string | null> {
    const signedIn = this.#current;
    if (signedIn === null) return null;
    const refreshToken = signedIn.tokens.refreshToken;
    if (isExpired(signedIn.tokens) && refreshToken !== undefined) {
      await this.#refreshOf(signedIn, refreshToken, fetchFn);
    }
    return this.#current?.tokens.accessToken ?? null;
  }

  async startSignIn(server: SignInServer, redirect: (url: string) => void): Promise<void> {
    const signOutsAtStart = this.#signOuts;
    const { verifier, challenge } = await generatePkce();
    if (this.#signOuts !== signOutsAtStart) throw new Error(SIGNED_OUT);
    const state = randomString(16);
    const url = buildAuthorizeUrl(providerFor(this.#config, server), { state, codeChallenge: challenge });
    this.#pending = { verifier, state, server };
    redirect(url);
  }

  async completeSignIn(code: string, state: string, { fetchFn = fetch, iss }: CompleteSignInOptions = {}): Promise<void> {
    const flow = this.#takePending(state, iss);
    const provider = providerFor(this.#config, flow.server);
    const signOutsAtStart = this.#signOuts;
    const signIn = ++this.#signIns;
    const tokens = await exchangeCodeForTokens(provider, code, flow.verifier, fetchFn);
    if (this.#signOuts !== signOutsAtStart) throw new Error(SIGNED_OUT);
    if (this.#signIns !== signIn) throw new Error("A newer sign-in replaced this one - please sign in again.");
    this.#current = { provider, tokens };
    this.#store.remove(this.#refreshKey);
    await this.#persist();
  }

  declineSignIn(state: string, iss?: string): void {
    this.#takePending(state, iss);
  }

  signOut(): void {
    this.#signOuts += 1;
    this.#pending = null;
    this.#current = null;
    this.#store.remove(this.#refreshKey);
  }

  #takePending(state: string, iss: string | undefined): PendingSignIn {
    const flow = this.#pending;
    this.#pending = null;
    return verifyAnswer(flow, state, iss);
  }

  #refreshOf(signedIn: SignedIn, refreshToken: string, fetchFn: typeof fetch): Promise<void> {
    if (this.#refreshing?.session === signedIn) return this.#refreshing.promise;
    const promise = this.#refresh(signedIn, refreshToken, fetchFn).finally(() => {
      if (this.#refreshing?.promise === promise) this.#refreshing = null;
    });
    this.#refreshing = { session: signedIn, promise };
    return promise;
  }

  async #persist(): Promise<void> {
    const refreshToken = this.#current?.tokens.refreshToken;
    if (refreshToken === undefined) return;
    const signOutsAtStart = this.#signOuts;
    await this.#save(refreshToken);
    if (this.#signOuts !== signOutsAtStart && this.#store.get(this.#refreshKey) === refreshToken) {
      this.#store.remove(this.#refreshKey);
    }
  }

  async #save(refreshToken: string): Promise<void> {
    try {
      await this.#store.set(this.#refreshKey, refreshToken);
    } catch {
      return;
    }
  }

  async #refresh(from: SignedIn, refreshToken: string, fetchFn: typeof fetch): Promise<void> {
    let tokens: AuthorizationCodeTokens;
    try {
      tokens = await refreshAuthorizationCodeTokens(from.provider, refreshToken, fetchFn);
    } catch (error) {
      if (!isGrantRejected(error)) throw error;
      if (this.#current === from) {
        this.#current = null;
        this.#store.remove(this.#refreshKey);
      }
      return;
    }
    if (this.#current !== from) return;
    this.#current = { provider: from.provider, tokens };
    await this.#persist();
  }
}

export function createAuthorizationCodeSession(config: AuthorizationCodeConfig, persistentStore: KeyValueStore): AuthorizationCodeSession {
  return new CodeSession(config, persistentStore);
}
