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

import { type AgentDetails, isTextSchema } from "@afm/engine";
import type { AddressInfo } from "node:net";
import type { Agent } from "./agent";
import { CHAT_PAGE_POLICY, chatPage } from "./chat-page";
import { json, type Routes, startServer, stopServer } from "./http-server";
import { authHeaders } from "./auth-headers";
import { type ChosenInterfaces, pathOf, UI_PATH } from "./interfaces";
import { LOOPBACK, refuseCredentialsOverHttp } from "./mcp";
import { Sessions } from "./sessions";
import { webChatHandler } from "./webchat";
import { webhookHandlers, WebSub } from "./webhook";

export interface Serving {
  port: number;
  close(): Promise<void>;
}

function checkHub(hub: string, secret: string | undefined): void {
  let url: URL;
  try {
    url = new URL(hub);
  } catch {
    throw new Error("The webhook subscription 'hub' is not a valid address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The webhook subscription 'hub' must be an http or https address.");
  if (secret !== undefined && secret !== "" && url.protocol === "http:" && !LOOPBACK.test(url.hostname)) {
    throw new Error(`The subscription secret was not sent to ${url.host} because it uses plain http://. Use an https:// address (http://localhost is allowed).`);
  }
}

function webSubOf(webhook: NonNullable<ChosenInterfaces["webhook"]>): WebSub | undefined {
  const subscription = webhook.subscription;
  if (subscription?.hub === undefined || subscription.topic === undefined) return undefined;
  if (subscription.protocol.toLowerCase() !== "websub") throw new Error(`The webhook subscription protocol '${subscription.protocol}' is not yet supported by this interpreter.`);
  checkHub(subscription.hub, subscription.secret);
  const headers = subscription.authentication === undefined ? {} : authHeaders(subscription.authentication);
  refuseCredentialsOverHttp(subscription.hub, headers);
  return new WebSub(subscription.hub, subscription.topic, subscription.secret, headers);
}

export async function serve(agent: Agent, details: AgentDetails, { webchat, webhook }: ChosenInterfaces, { host, port }: { host: string; port: number }): Promise<Serving> {
  const webchatPath = webchat === undefined ? null : pathOf(webchat);
  const webhookPath = webhook === undefined ? null : pathOf(webhook);
  const sessions = new Sessions(agent);
  const routes: Routes = new Map();
  routes.set("/", { GET: async () => json(200, { name: details.name, description: details.description, version: details.version, interfaces: { webchat: webchatPath, webhook: webhookPath } }) });
  routes.set("/health", { GET: async () => json(200, { status: "ok" }) });

  if (webchat !== undefined) {
    const path = pathOf(webchat);
    routes.set(path, { POST: webChatHandler(sessions, webchat.signature) });
    if (isTextSchema(webchat.signature.input) && isTextSchema(webchat.signature.output)) {
      const page = chatPage({ ...details, path });
      routes.set(UI_PATH, {
        GET: async () => ({ status: 200, type: "text/html; charset=utf-8", body: page, headers: { "Content-Security-Policy": CHAT_PAGE_POLICY, "Referrer-Policy": "no-referrer" } }),
      });
    }
  }

  const websub = webhook === undefined ? undefined : webSubOf(webhook);
  if (webhook !== undefined) routes.set(pathOf(webhook), webhookHandlers(sessions, webhook, websub));

  const server = await startServer(routes, host, port);
  const listening = (server.address() as AddressInfo).port;
  if (websub !== undefined && webhook !== undefined) {
    let callback = webhook.subscription?.callback;
    if (callback === undefined) {
      callback = `http://${host === "0.0.0.0" ? "localhost" : host}:${listening}${pathOf(webhook)}`;
      console.warn(`Warning: using the WebSub callback address ${callback}. For production, set 'subscription.callback' in the agent file.`);
    }
    void websub.start(callback);
  }
  return {
    port: listening,
    close: async () => {
      await websub?.stop();
      await stopServer(server);
    },
  };
}
