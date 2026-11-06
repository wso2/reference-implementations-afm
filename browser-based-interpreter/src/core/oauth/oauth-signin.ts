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

import { type OAuthProviderRef } from "@afm/runtime";
import { httpsUrl } from "../links/load-paths";
import type { ClientMessage } from "../runtime/protocol";

type PopupResult = { code: string; state: string; iss?: string } | { error: string; state: string; iss?: string };

export type SignInOutcome = { status: "signed-in" } | { status: "failed"; reason?: string };

const POPUP_NAME = "afm-oauth-signin";
const CALLBACK_CHANNEL = "afm-oauth-callback";
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const POPUP_POLL_MS = 500;
const POPUP_CLOSE_GRACE_MS = 1500;

function openSignInPopup(): Window | null {
  const popup = window.open("about:blank", POPUP_NAME, "width=520,height=680");
  if (popup !== null) popup.opener = null;
  return popup;
}

export function relayOAuthCallback(): boolean {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const iss = params.get("iss");
  const error = params.get("error");
  if (state === null || (code === null && error === null)) return false;
  const issuer = iss === null ? {} : { iss };
  const result = error !== null ? { error, state, ...issuer } : { code, state, ...issuer };
  const channel = new BroadcastChannel(CALLBACK_CHANNEL);
  channel.postMessage(result);
  channel.close();
  document.body.textContent = "You can close this window.";
  window.close();
  return true;
}

function awaitCallback(stateOf: () => string | undefined): { promise: Promise<PopupResult>; cancel(): void } {
  let cancel = () => {};
  const promise = new Promise<PopupResult>((resolve, reject) => {
    const channel = new BroadcastChannel(CALLBACK_CHANNEL);
    const timer = window.setTimeout(() => settle(() => reject(new Error("Sign-in timed out."))), SIGN_IN_TIMEOUT_MS);

    function settle(done: () => void): void {
      window.clearTimeout(timer);
      channel.close();
      done();
    }

    cancel = () => {
      window.clearTimeout(timer);
      channel.close();
    };

    channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { code?: unknown; state?: unknown; iss?: unknown; error?: unknown } | null;
      if (typeof data?.state !== "string" || data.state !== stateOf()) return;
      const iss = typeof data.iss === "string" ? { iss: data.iss } : {};
      if (typeof data.error === "string") {
        settle(() => resolve({ error: data.error as string, state: data.state as string, ...iss }));
      } else if (typeof data.code === "string") {
        settle(() => resolve({ code: data.code as string, state: data.state as string, ...iss }));
      }
    };
  });
  return { promise, cancel: () => cancel() };
}

interface Flow {
  popup: Window;
  provider: OAuthProviderRef;
  state?: string;
  navigated?: boolean;
  relayed?: boolean;
  resolve: (outcome: SignInOutcome) => void;
  cancelCallback: () => void;
}

interface OAuthSignInDeps {
  post: (message: ClientMessage) => void;
}

export interface OAuthSignIns {
  dispose(): void;
  start(provider: OAuthProviderRef): Promise<SignInOutcome>;
  onAuthorizeUrl(id: string, url: string): void;
  onDone(id: string, ok: boolean, error?: string): void;
}

export function createOAuthSignIns(deps: OAuthSignInDeps): OAuthSignIns {
  const flows = new Map<string, Flow>();

  function watchPopup(id: string): void {
    window.setTimeout(() => {
      const flow = flows.get(id);
      if (flow === undefined || flow.relayed || flow.navigated) return;
      if (!flow.popup.closed) return watchPopup(id);
      window.setTimeout(() => {
        const closed = flows.get(id);
        if (closed === undefined || closed.relayed || closed.navigated) return;
        flows.delete(id);
        closed.cancelCallback();
        if (closed.state !== undefined)
          deps.post({ type: "oauth-signin-error", id, error: "closed", state: closed.state });
        closed.resolve({ status: "failed", reason: "The sign-in window was closed before it finished." });
      }, POPUP_CLOSE_GRACE_MS);
    }, POPUP_POLL_MS);
  }

  return {
    dispose() {
      for (const flow of flows.values()) {
        flow.cancelCallback();
        if (!flow.popup.closed) flow.popup.close();
        flow.resolve({ status: "failed" });
      }
      flows.clear();
    },
    start(provider) {
      if ([...flows.values()].some((flow) => !flow.popup.closed && !flow.relayed)) {
        return Promise.resolve<SignInOutcome>({
          status: "failed",
          reason: "Finish the sign-in window that is already open.",
        });
      }
      const popup = openSignInPopup();
      if (popup === null) {
        return Promise.resolve<SignInOutcome>({ status: "failed", reason: "Allow pop-ups to sign in." });
      }
      const id = crypto.randomUUID();
      return new Promise<SignInOutcome>((resolve) => {
        const callback = awaitCallback(() => flows.get(id)?.state);
        flows.set(id, { popup, provider, resolve, cancelCallback: callback.cancel });
        deps.post({ type: "oauth-signin-start", id, provider });
        watchPopup(id);

        callback.promise.then(
          (result) => {
            const flow = flows.get(id);
            if (flow !== undefined) flow.relayed = true;
            deps.post(
              "error" in result
                ? { type: "oauth-signin-error", id, ...result }
                : { type: "oauth-signin-code", id, ...result },
            );
          },
          () => {
            flows.delete(id);
            if (!popup.closed) popup.close();
            resolve({ status: "failed" });
          },
        );
      });
    },

    onAuthorizeUrl(id, url) {
      const flow = flows.get(id);
      if (flow === undefined || flow.popup.closed) return;
      const target = httpsUrl(url);
      if (target === null) {
        flows.delete(id);
        flow.cancelCallback();
        flow.popup.close();
        flow.resolve({ status: "failed", reason: "The sign-in address is not a secure (https) address." });
        return;
      }
      flow.state = target.searchParams.get("state") ?? undefined;
      flow.popup.location.href = target.href;
      flow.navigated = true;
    },

    onDone(id, ok, error) {
      const flow = flows.get(id);
      flows.delete(id);
      if (flow === undefined) return;
      flow.cancelCallback();
      if (!flow.popup.closed) flow.popup.close();
      flow.resolve(
        ok
          ? { status: "signed-in" }
          : { status: "failed", reason: error === undefined ? undefined : `Sign-in failed: ${error}` },
      );
    },
  };
}
