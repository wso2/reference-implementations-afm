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

import type { OAuthProviderRef } from "@afm/adapter-auth";
import { useEffect, useRef } from "react";
import { startBlobWorker } from "../core/files/blob-worker";
import { createOAuthSignIns, type OAuthSignIns, type SignInOutcome } from "../core/oauth/oauth-signin";
import type { ClientMessage, ProbeResult, ServerMessage, SignInVetting } from "../core/runtime/protocol";
import agentWorkerUrl from "../core/runtime/worker.ts?worker&url";

const READY_DEADLINE_MS = 30_000;
const PROBE_DEADLINE_MS = 30_000;

export function useAgentWorker(onMessage: (message: ServerMessage) => void) {
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const workerRef = useRef<Worker | null>(null);
  const outboxRef = useRef<ClientMessage[]>([]);
  const readyRef = useRef(false);
  const failedRef = useRef(false);
  const probeWaitersRef = useRef<Map<string, (result: ProbeResult) => void>>(new Map());
  const oauthRef = useRef<OAuthSignIns | null>(null);
  oauthRef.current ??= createOAuthSignIns({ post });
  const oauth = oauthRef.current;

  useEffect(() => {
    const outbox = outboxRef.current;
    const waiters = probeWaitersRef.current;
    let worker: Worker | null = null;
    let live = true;
    failedRef.current = false;
    readyRef.current = false;

    const fail = () => {
      if (!live || failedRef.current) return;
      window.clearTimeout(readyTimer);
      failedRef.current = true;
      readyRef.current = false;
      oauth.dispose();
      outbox.length = 0;
      for (const finish of waiters.values())
        finish({ failure: { kind: "other", message: "The agent worker stopped." } });
      waiters.clear();
      worker?.terminate();
      workerRef.current = null;
      onMessageRef.current({
        type: "error",
        message: "The agent worker stopped. Reload to try again; saved keys may need verification again.",
      });
    };
    const readyTimer = window.setTimeout(fail, READY_DEADLINE_MS);

    const receive = (event: MessageEvent<unknown>) => {
      if (!live || failedRef.current || worker === null || workerRef.current !== worker) return;
      const message = event.data;
      if (message === null || typeof message !== "object") return;
      const incoming = message as ServerMessage;
      switch (incoming.type) {
        case "worker-ready":
          if (readyRef.current) return;
          window.clearTimeout(readyTimer);
          readyRef.current = true;
          for (const queued of outbox.splice(0)) worker.postMessage(queued);
          post({ type: "list-secrets" });
          return;
        case "oauth-authorize-url":
          oauth.onAuthorizeUrl(incoming.id, incoming.url);
          return;
        case "oauth-signin-confirm":
          oauth.onConfirm(incoming.id, incoming.host);
          return;
        case "oauth-signin-done":
          oauth.onDone(incoming.id, incoming.ok, incoming.error);
          return;
        case "probe-result":
          waiters.get(incoming.id)?.({ tools: incoming.tools, failure: incoming.failure });
          waiters.delete(incoming.id);
          return;
        default:
          onMessageRef.current(incoming);
      }
    };

    startBlobWorker(agentWorkerUrl).then(
      (started) => {
        if (!live || failedRef.current) {
          started.terminate();
          return;
        }
        worker = started;
        workerRef.current = started;
        started.addEventListener("message", receive);
        started.addEventListener("error", fail);
        started.addEventListener("messageerror", fail);
      },
      () => {
        window.clearTimeout(readyTimer);
        fail();
      },
    );

    return () => {
      live = false;
      failedRef.current = true;
      window.clearTimeout(readyTimer);
      readyRef.current = false;
      oauth.dispose();
      for (const finish of waiters.values())
        finish({ failure: { kind: "other", message: "The agent session ended." } });
      waiters.clear();
      worker?.removeEventListener("error", fail);
      worker?.removeEventListener("messageerror", fail);
      worker?.removeEventListener("message", receive);
      worker?.terminate();
      workerRef.current = null;
      outbox.length = 0;
    };
  }, [oauth]);

  function post(message: ClientMessage): void {
    if (failedRef.current) return;
    const worker = workerRef.current;
    if (worker === null || !readyRef.current) {
      outboxRef.current.push(message);
      return;
    }
    worker.postMessage(message);
  }

  function probe(message: (id: string) => ClientMessage): Promise<ProbeResult> {
    if (failedRef.current) return Promise.resolve({ failure: { kind: "other", message: "The agent worker stopped." } });
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const deadline = window.setTimeout(() => {
        probeWaitersRef.current.delete(id);
        resolve({ failure: { kind: "slow", message: "Nothing answered in time." } });
      }, PROBE_DEADLINE_MS);
      probeWaitersRef.current.set(id, (result) => {
        window.clearTimeout(deadline);
        resolve(result);
      });
      post(message(id));
    });
  }

  function startOAuthSignIn(provider: OAuthProviderRef, vetting: SignInVetting): Promise<SignInOutcome> {
    if (failedRef.current) return Promise.resolve({ status: "failed", reason: "Reload the agent to sign in again." });
    return oauth.start(provider, vetting);
  }

  return { post, probe, startOAuthSignIn };
}
