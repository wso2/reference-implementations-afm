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
  authorizationCodeProviderKey,
  createAuthorizationCodeSession,
  discoverSignInServer,
  type AuthorizationCodeSession,
  type KeyValueStore,
  type OAuthProviderRef,
} from "@afm/adapter-auth";
import { describeError } from "@afm/engine";
import { SignInRequiredError } from "../chat/failure";
import type { SignInVetting } from "../runtime/protocol";

export interface OAuthManagerDeps {
  fetchFn: typeof fetch;
  redirectUri: string;
  cimdClientId?: string;
  refreshStore: KeyValueStore;
  emitAuthorizeUrl: (id: string, url: string) => void;
  emitSignInConfirm: (id: string, host: string) => void;
  emitSignInResult: (id: string, ok: boolean, error?: string) => void;
}

interface OAuthManager {
  getAccessToken(provider: OAuthProviderRef): Promise<string>;
  startSignIn(id: string, provider: OAuthProviderRef, vetting: SignInVetting): Promise<void>;
  completeSignIn(id: string, code: string, state: string, iss?: string): Promise<void>;
  declineSignIn(id: string, error: string, state: string, iss?: string): void;
  signOut(provider: OAuthProviderRef): void;
}

export function createOAuthManager(deps: OAuthManagerDeps): OAuthManager {
  const sessions = new Map<string, AuthorizationCodeSession>();
  const inFlight = new Map<string, OAuthProviderRef>();

  function sessionFor(provider: OAuthProviderRef): AuthorizationCodeSession {
    const key = authorizationCodeProviderKey(provider);
    let session = sessions.get(key);
    if (session === undefined) {
      session = createAuthorizationCodeSession({ ...provider, redirectUri: deps.redirectUri }, deps.refreshStore);
      sessions.set(key, session);
    }
    return session;
  }

  function waitingProvider(id: string): OAuthProviderRef | undefined {
    const provider = inFlight.get(id);
    inFlight.delete(id);
    if (provider === undefined) deps.emitSignInResult(id, false, "This sign-in is no longer waiting.");
    return provider;
  }

  return {
    async getAccessToken(provider) {
      const session = sessionFor(provider);
      const token = await session.getAccessToken(deps.fetchFn);
      if (token !== null) return token;
      throw new SignInRequiredError();
    },

    async startSignIn(id, provider, vetting) {
      inFlight.set(id, provider);
      try {
        const server = await discoverSignInServer(provider, deps);
        const host = new URL(server.issuer).host;
        if (!vetting.listed && !server.issuerSent && vetting.confirmedHost !== host) {
          inFlight.delete(id);
          deps.emitSignInConfirm(id, host);
          return;
        }
        await sessionFor(provider).startSignIn(server, (url) => deps.emitAuthorizeUrl(id, url));
      } catch (error) {
        inFlight.delete(id);
        deps.emitSignInResult(id, false, describeError(error));
      }
    },

    async completeSignIn(id, code, state, iss) {
      const provider = waitingProvider(id);
      if (provider === undefined) return;
      try {
        await sessionFor(provider).completeSignIn(code, state, { fetchFn: deps.fetchFn, iss });
        deps.emitSignInResult(id, true);
      } catch (error) {
        deps.emitSignInResult(id, false, describeError(error));
      }
    },

    declineSignIn(id, error, state, iss) {
      const provider = waitingProvider(id);
      if (provider === undefined) return;
      try {
        sessionFor(provider).declineSignIn(state, iss);
        deps.emitSignInResult(id, false, `The provider declined the sign-in (${error.slice(0, 80)}).`);
      } catch (refusal) {
        deps.emitSignInResult(id, false, describeError(refusal));
      }
    },

    signOut(provider) {
      sessionFor(provider).signOut();
    },
  };
}
