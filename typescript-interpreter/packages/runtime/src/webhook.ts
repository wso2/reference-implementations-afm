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

import { compileTemplate, describeError, evaluateTemplate, type PromptTemplate, TemplateError } from "@afm/engine";
import { createHmac, timingSafeEqual } from "node:crypto";
import { type Handler, headerOf, HttpError, json, text } from "./http-server";
import type { Webhook } from "./interfaces";
import { DEFAULT_SESSION, type Sessions } from "./sessions";

const MAX_BODY = 25 * 1024 * 1024;
const MAX_RUNNING = 10;
const ALGORITHMS = ["sha1", "sha256", "sha512"];
const LEASE_SECONDS = 86400;
const RENEW_AFTER = 0.8;
const MAX_TIMER_MS = 2 ** 31 - 1;
const HUB_TIMEOUT_MS = 30_000;

export function verifySignature(body: Buffer, header: string | undefined, secret: string): boolean {
  if (header === undefined || header === "") return false;
  let algorithm = "sha256";
  let provided = header;
  const equals = header.indexOf("=");
  if (equals !== -1) {
    const named = header.slice(0, equals).toLowerCase();
    provided = header.slice(equals + 1);
    if (ALGORITHMS.includes(named)) algorithm = named;
  }
  const expected = Buffer.from(createHmac(algorithm, secret).update(body).digest("hex"));
  const given = Buffer.from(provided.toLowerCase());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export class WebSub {
  verified = false;
  private stopped = false;
  private callback = "";
  private wake: (() => void) | undefined;
  private renewal: NodeJS.Timeout | undefined;
  private requested: "subscribe" | "unsubscribe" | undefined;

  constructor(
    private readonly hub: string,
    readonly topic: string,
    private readonly secret: string | undefined,
    private readonly headers: Record<string, string> = {},
  ) {}

  private async send(mode: "subscribe" | "unsubscribe", callback: string): Promise<boolean> {
    this.requested = mode;
    const form = new URLSearchParams({ "hub.mode": mode, "hub.topic": this.topic, "hub.callback": callback });
    if (mode === "subscribe") {
      form.set("hub.lease_seconds", String(LEASE_SECONDS));
      if (this.secret !== undefined && this.secret !== "") form.set("hub.secret", this.secret);
    }
    try {
      const response = await fetch(this.hub, { method: "POST", headers: this.headers, body: form, redirect: "error", signal: AbortSignal.timeout(HUB_TIMEOUT_MS) });
      return [200, 202, 204].includes(response.status);
    } catch {
      return false;
    }
  }

  async start(callback: string, attempts = 3, delayMs = 5000): Promise<void> {
    this.callback = callback;
    for (let attempt = 1; attempt <= attempts && !this.stopped; attempt += 1) {
      if (await this.send("subscribe", callback)) return;
      if (attempt < attempts) await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, delayMs).unref();
      });
    }
    if (!this.stopped) console.error(`Could not subscribe to the WebSub hub ${this.hub} after ${attempts} attempts.`);
  }

  confirm(mode: string, topic: string, challenge: string, leaseSeconds = LEASE_SECONDS): string | undefined {
    if (topic !== this.topic || mode !== this.requested) return undefined;
    this.verified = mode === "subscribe";
    clearTimeout(this.renewal);
    if (this.verified && !this.stopped) {
      const wait = Math.min(Math.max(leaseSeconds * RENEW_AFTER * 1000, 1000), MAX_TIMER_MS);
      this.renewal = setTimeout(() => void this.start(this.callback), wait).unref();
    }
    return challenge;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.renewal);
    this.wake?.();
    if (this.verified) await this.send("unsubscribe", this.callback);
  }
}

function compiled(prompt: string | undefined): PromptTemplate | undefined {
  try {
    return prompt === undefined || prompt === "" ? undefined : compileTemplate(prompt);
  } catch (error) {
    throw new Error(`The webhook prompt is not valid: ${describeError(error)}`);
  }
}

export function webhookHandlers(sessions: Sessions, webhook: Webhook, websub: WebSub | undefined): { GET: Handler; POST: Handler } {
  const secret = webhook.subscription?.secret;
  const template = compiled(webhook.prompt);
  let running = 0;
  if (secret === undefined || secret === "") console.warn("Warning: the webhook has no 'subscription.secret', so incoming requests are not signature-verified.");

  const GET: Handler = async ({ url }) => {
    const mode = url.searchParams.get("hub.mode");
    const topic = url.searchParams.get("hub.topic");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === null || topic === null || challenge === null) throw new HttpError(400, "Missing hub.mode, hub.topic or hub.challenge");
    if (mode !== "subscribe" && mode !== "unsubscribe") throw new HttpError(404, "Invalid mode");
    if (websub === undefined) return text(200, challenge);
    const lease = Number(url.searchParams.get("hub.lease_seconds"));
    const confirmed = websub.confirm(mode, topic, challenge, lease > 0 && Number.isFinite(lease) ? lease : undefined);
    if (confirmed === undefined) throw new HttpError(404, "Verification failed");
    return text(200, confirmed);
  };

  const POST: Handler = async ({ headers, body }) => {
    const raw = await body(MAX_BODY);
    if (secret !== undefined && secret !== "") {
      const signature = headerOf(headers, "x-hub-signature-256") ?? headerOf(headers, "x-hub-signature");
      if (!verifySignature(raw, signature, secret)) throw new HttpError(401, "Invalid signature");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf-8"));
    } catch {
      throw new HttpError(400, "Invalid JSON payload");
    }
    let prompt: string;
    try {
      prompt = template === undefined ? JSON.stringify(payload, null, 2) : evaluateTemplate(template, payload, headers);
    } catch (error) {
      if (!(error instanceof TemplateError)) throw error;
      console.warn(`Template evaluation error: ${error.message}`);
      throw new HttpError(400, "Failed to evaluate prompt template");
    }
    if (running >= MAX_RUNNING) throw new HttpError(503, "Too many events are being processed");
    running += 1;
    void sessions
      .ask(DEFAULT_SESSION, prompt)
      .catch((error: unknown) => console.error(`Agent execution error: ${describeError(error)}`))
      .finally(() => {
        running -= 1;
      });
    return json(202, { status: "accepted" });
  };

  return { GET, POST };
}
