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


import { startBlobWorker } from "../core/files/blob-worker";
import { createOAuthSignIns, type SignInOutcome } from "../core/oauth/oauth-signin";
import { type OAuthProviderRef } from "../core/oauth/session";
import type { ClientMessage, ProbeResult, ServerMessage } from "../core/runtime/protocol";
import agentWorkerUrl from "../core/runtime/worker.ts?worker&url";

const READY_DEADLINE_MS = 30_000;
const PROBE_DEADLINE_MS = 30_000;

const RESTARTS_WORKER = new Set<ClientMessage["type"]>(["load", "set-secret"]);

export class WorkerLink {
  readonly oauth = createOAuthSignIns({ post: (message) => this.post(message) });
  private worker: Worker | null = null;
  private outbox: ClientMessage[] = [];
  private waiters = new Map<string, (result: ProbeResult) => void>();
  private readyTimer = 0;
  private ready = false;
  private failed = false;
  private active = false;
  private run = 0;

  constructor(private readonly onMessage: (message: ServerMessage) => void) {}

  start(): void {
    const run = ++this.run;
    this.active = true;
    this.failed = false;
    this.ready = false;
    this.readyTimer = window.setTimeout(this.fail, READY_DEADLINE_MS);

    startBlobWorker(agentWorkerUrl).then(
      (worker) => {
        if (run !== this.run || this.failed) {
          worker.terminate();
          return;
        }
        this.worker = worker;
        worker.addEventListener("message", this.receive);
        worker.addEventListener("error", this.fail);
        worker.addEventListener("messageerror", this.fail);
      },
      () => {
        if (run !== this.run) return;
        window.clearTimeout(this.readyTimer);
        this.fail();
      },
    );
  }

  stop(): void {
    this.run += 1;
    this.active = false;
    this.failed = true;
    this.worker?.removeEventListener("message", this.receive);
    this.worker?.removeEventListener("error", this.fail);
    this.worker?.removeEventListener("messageerror", this.fail);
    this.release("The agent session ended.");
  }

  post(message: ClientMessage): void {
    if (this.failed && !(RESTARTS_WORKER.has(message.type) && this.revive())) return;
    if (this.worker === null || !this.ready) {
      this.outbox.push(message);
      return;
    }
    this.worker.postMessage(message);
  }

  probe(buildMessage: (id: string) => ClientMessage): Promise<ProbeResult> {
    if (this.failed && !this.revive()) {
      return Promise.resolve({ failure: { kind: "other", message: "The agent worker stopped." } });
    }
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const deadline = window.setTimeout(() => {
        this.waiters.delete(id);
        resolve({ failure: { kind: "slow", message: "Nothing answered in time." } });
      }, PROBE_DEADLINE_MS);
      this.waiters.set(id, (result) => {
        window.clearTimeout(deadline);
        resolve(result);
      });
      this.post(buildMessage(id));
    });
  }

  startOAuthSignIn(provider: OAuthProviderRef): Promise<SignInOutcome> {
    if (this.failed && !this.revive()) {
      return Promise.resolve({ status: "failed", reason: "The agent stopped. Try again." });
    }
    return this.oauth.start(provider);
  }

  private fail = (): void => {
    if (!this.active || this.failed) return;
    this.failed = true;
    this.release("The agent worker stopped.");
    this.onMessage({ type: "worker-stopped" });
  };

  private revive(): boolean {
    if (!this.active) return false;
    this.start();
    return true;
  }

  private release(reason: string): void {
    window.clearTimeout(this.readyTimer);
    this.ready = false;
    this.oauth.dispose();
    this.outbox = [];
    for (const finish of this.waiters.values()) finish({ failure: { kind: "other", message: reason } });
    this.waiters.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private receive = (event: MessageEvent<unknown>): void => {
    if (!this.active || this.failed || this.worker === null) return;
    const message = event.data;
    if (message === null || typeof message !== "object") return;
    const incoming = message as ServerMessage;
    switch (incoming.type) {
      case "worker-ready":
        if (this.ready) return;
        window.clearTimeout(this.readyTimer);
        this.ready = true;
        for (const queued of this.outbox.splice(0)) this.worker.postMessage(queued);
        this.post({ type: "list-secrets" });
        return;
      case "oauth-authorize-url":
        this.oauth.onAuthorizeUrl(incoming.id, incoming.url);
        return;
      case "oauth-signin-done":
        this.oauth.onDone(incoming.id, incoming.ok, incoming.error);
        return;
      case "probe-result":
        this.waiters.get(incoming.id)?.({ tools: incoming.tools, failure: incoming.failure });
        this.waiters.delete(incoming.id);
        return;
      default:
        this.onMessage(incoming);
    }
  };
}
