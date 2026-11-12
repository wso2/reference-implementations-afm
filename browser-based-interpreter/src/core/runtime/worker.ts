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

import { type AgentMetadata, describeError } from "@afm/engine";
import type { LanguageModel } from "@afm/runtime";
import { referencedSecretNames } from "../agent/secret-usage";
import { generateDraft } from "../agent/drafts";
import { failureOf } from "../chat/failure";
import { appAddress } from "../links/app-address";
import { createOAuthManager } from "../oauth/oauth-manager";
import { createWorkerSecretStore } from "../secrets/worker-secret-store";
import { createPermissionBridge } from "./bridges";
import {
  checkModelFromMetadata,
  defaultMcpProxyConfig,
  probeServerTools,
  modelFromMetadata,
  modelWithResolvedKey,
  proxyAwareFetch,
  toolsFromMetadata,
} from "./factories";
import { probeToolUses, resolveProbeAuth } from "./probe-auth";
import { type ClientMessage, type ServerMessage } from "./protocol";
import { permissionKey } from "../tools/trust";
import { gateSecrets, type ModelUse, secretsOf, type SecretUse } from "./secret-gate";
import { AgentSession } from "./session";
import { type OAuthProviderRef } from "../oauth/session";
import { type PermissionBroker } from "../tools/tool-guard";

const PROBE_TIMEOUT_MS = 25_000;

const scope = globalThis as unknown as {
  postMessage(message: ServerMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<ClientMessage>) => void): void;
};

const emit = (message: ServerMessage) => scope.postMessage(message);
const store = createWorkerSecretStore(emit);

let secretUses: SecretUse[] = [];
let secretModels: ModelUse[] = [];
let secretSettings: string[] = [];
let settingValues: Record<string, string> = {};

function gateDeps(uses: SecretUse[], models: ModelUse[], settings: string[] = [], values: Record<string, string> = {}) {
  return { uses, models, settings, values, approvedFor: store.approvedFor, enteredForModel: store.enteredForModel, valueOf: store.valueOf };
}

const oauth = createOAuthManager({
  fetchFn: (input, init) => proxyAwareFetch()(input, init),
  redirectUri: appAddress(self.location.origin, import.meta.env.BASE_URL),
  refreshStore: store.refreshStore,
  emitAuthorizeUrl: (id, url) => emit({ type: "oauth-authorize-url", id, url }),
  emitSignInResult: (id, ok, error) => emit({ type: "oauth-signin-done", id, ok, error }),
});

const oauthDeps = {
  getInteractiveToken: (provider: OAuthProviderRef) => oauth.getAccessToken(provider),
  renewInteractiveToken: (provider: OAuthProviderRef, rejectedToken: string) => oauth.renewAccessToken(provider, rejectedToken),
};

async function answerProbe(id: string, check: () => Promise<{ name: string; description?: string }[] | undefined>): Promise<void> {
  try {
    emit({ type: "probe-result", id, tools: await check() });
  } catch (error) {
    emit({ type: "probe-result", id, failure: failureOf(error) });
  }
}

function probeServer(id: string, server: AgentMetadata["tools"]): Promise<void> {
  return answerProbe(id, async () => {
    const uses = probeToolUses(server);
    const { env } = gateSecrets(uses.map((use) => use.name), gateDeps(uses, []));
    const entry = resolveProbeAuth(server, env)?.mcp?.[0];
    return entry === undefined ? [] : await probeServerTools(entry, defaultMcpProxyConfig, oauthDeps, PROBE_TIMEOUT_MS);
  });
}

function probeModel(id: string, model: AgentMetadata["model"]): Promise<void> {
  return answerProbe(id, async () => {
    await checkModelFromMetadata(withResolvedKey(model));
    return undefined;
  });
}

function withResolvedKey(model: AgentMetadata["model"]): AgentMetadata["model"] {
  return modelWithResolvedKey(model, { enteredForModel: store.enteredForModel, valueOf: store.valueOf });
}

async function resolveAuthoringModel(model: AgentMetadata["model"]): Promise<LanguageModel> {
  return modelFromMetadata(withResolvedKey(model));
}

const permissionBridge = createPermissionBridge((call) =>
  emit({
    type: "permission-request",
    id: call.id,
    name: call.name,
    args: call.args,
    serverId: call.serverId,
  }),
);

const alwaysAllow = new Set<string>();

const permission: PermissionBroker = {
  async request(call, signal) {
    const key = permissionKey(call.serverId, call.name);
    if (alwaysAllow.has(key)) return "allow";
    const decision = await permissionBridge.ask(call, signal);
    if (decision.allow && decision.remember) alwaysAllow.add(key);
    return decision.allow ? "allow" : "deny";
  },
};

const session = new AgentSession({
  createModel: modelFromMetadata,
  createTools: (metadata, guard) => toolsFromMetadata(metadata, defaultMcpProxyConfig, guard, oauthDeps),
  secrets: (content) => gateSecrets(referencedSecretNames(content), gateDeps(secretUses, secretModels, secretSettings, settingValues)),
  permission,
  emit,
});

scope.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "load":
      ({ uses: secretUses, models: secretModels, settings: secretSettings } = secretsOf(message.content));
      settingValues = message.values ?? {};
      alwaysAllow.clear();
      void session.load(message.content, message);
      break;
    case "send":
      void session.send(message.text, message.images, message.keep);
      break;
    case "regenerate":
      void session.regenerate();
      break;
    case "continue":
      void session.continue();
      break;
    case "reset-chat":
      session.resetChat();
      break;
    case "cancel":
      session.cancel();
      break;
    case "set-secret":
      store.set(message.name, message.value, message.address, message.provider);
      break;
    case "list-secrets":
      store.postNames();
      break;
    case "remove-secret":
      store.remove(message.name);
      break;
    case "set-trusted":
      alwaysAllow.clear();
      session.trust(message.confirmedTools);
      break;
    case "permission-response":
      permissionBridge.resolve(message.id, {
        allow: message.decision === "allow",
        remember: message.remember,
      });
      break;
    case "oauth-signin-start":
      void oauth.startSignIn(message.id, message.provider);
      break;
    case "oauth-signin-code":
      void oauth.completeSignIn(message.id, message.code, message.state, message.iss);
      break;
    case "oauth-signin-error":
      oauth.declineSignIn(message.id, message.error, message.state, message.iss);
      break;
    case "oauth-sign-out":
      oauth.signOut(message.provider);
      break;
    case "probe-server":
      void probeServer(message.id, message.server);
      break;
    case "probe-model":
      void probeModel(message.id, message.model);
      break;
    case "generate-draft":
      void generateDraft(message.prompt, message.model, message.final ?? false, resolveAuthoringModel)
        .then((result) => {
          emit(
            result.kind === "clarify"
              ? { type: "draft-clarify", id: message.id, questions: result.questions }
              : { type: "draft-generated", id: message.id, source: result.source },
          );
        })
        .catch((error) => emit({ type: "draft-generation-error", id: message.id, message: describeError(error) }));
      break;
    default: {
      // Fails to compile when a client message has no handler above.
      const unhandled: never = message;
      void unhandled;
    }
  }
});

emit({ type: "worker-ready" });
