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

import { type AgentMetadata, describeError, type SecretPort } from "@afm/engine";
import {
  FILE_TOOL_NAMES,
  type FileInfo,
  fileToolSource,
  type LanguageModel,
  listFilesText,
  type OAuthProviderRef,
  type PermissionBroker,
  probeMcpServer,
} from "@afm/runtime";
import { generateDraft } from "../agent/drafts";
import { failureFromStatus, failureOf } from "../chat/failure";
import { appAddress } from "../links/app-address";
import { createOAuthManager } from "../oauth/oauth-manager";
import { createWorkerSecretStore } from "../secrets/worker-secret-store";
import { createPermissionBridge } from "./bridges";
import {
  checkModelFromMetadata,
  defaultMcpProxyConfig,
  mcpServerOptions,
  modelFromMetadata,
  modelWithResolvedKey,
  proxyAwareFetch,
  toolsFromMetadata,
} from "./factories";
import { probeToolUses, resolveProbeAuth } from "./probe-auth";
import { type ClientMessage, permissionKey, type ServerMessage } from "./protocol";
import { destinationGatedVault, secretsOf, type SecretUse } from "./secret-gate";
import { AgentSession } from "./session";

const PROBE_TIMEOUT_MS = 12_000;

const scope = globalThis as unknown as {
  postMessage(message: ServerMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent<ClientMessage>) => void): void;
};

const store = createWorkerSecretStore((message) => scope.postMessage(message));

let secretUses: SecretUse[] = [];
let modelNames: string[] = [];

function gatedVault(uses: () => SecretUse[] = () => secretUses, models: () => string[] = () => modelNames): SecretPort {
  return destinationGatedVault(store.memoryPort, {
    uses,
    approvedFor: store.approvedFor,
    modelNames: models,
    enteredForModel: store.enteredForModel,
  });
}

const secrets = gatedVault();

const oauth = createOAuthManager({
  fetchFn: (input, init) => proxyAwareFetch()(input, init),
  redirectUri: appAddress(self.location.origin, import.meta.env.BASE_URL),
  refreshStore: store.refreshStore,
  emitAuthorizeUrl: (id, url) => scope.postMessage({ type: "oauth-authorize-url", id, url }),
  emitSignInResult: (id, ok, error) => scope.postMessage({ type: "oauth-signin-done", id, ok, error }),
});

const oauthDeps = {
  getInteractiveToken: (provider: OAuthProviderRef) => oauth.getAccessToken(provider),
  renewInteractiveToken: (provider: OAuthProviderRef, rejectedToken: string) => oauth.renewAccessToken(provider, rejectedToken),
};

async function probeServer(probeId: string, server: AgentMetadata["tools"]): Promise<void> {
  try {
    const resolved = await resolveProbeAuth(
      server,
      gatedVault(
        () => probeToolUses(server),
        () => [],
      ),
    );
    const entry = resolved?.mcp?.[0];
    const options =
      entry === undefined ? null : mcpServerOptions(entry, defaultMcpProxyConfig, oauthDeps, { setupTimeoutMs: PROBE_TIMEOUT_MS });
    const tools = options === null ? [] : await probeMcpServer(options);
    scope.postMessage({ type: "probe-result", id: probeId, tools });
  } catch (error) {
    scope.postMessage({ type: "probe-result", id: probeId, failure: failureOf(error) });
  }
}

async function probeModel(probeId: string, model: AgentMetadata["model"]): Promise<void> {
  try {
    const check = await checkModelFromMetadata(await withResolvedKey(model));
    scope.postMessage(
      check.ok
        ? { type: "probe-result", id: probeId }
        : {
            type: "probe-result",
            id: probeId,
            failure: { kind: failureFromStatus(check.status), message: `The provider answered ${check.status}.` },
          },
    );
  } catch (error) {
    scope.postMessage({ type: "probe-result", id: probeId, failure: failureOf(error) });
  }
}

async function withResolvedKey(model: AgentMetadata["model"]): Promise<AgentMetadata["model"]> {
  return modelWithResolvedKey(model, {
    enteredForModel: store.enteredForModel,
    resolve: (ref) => store.memoryPort.resolve(ref),
  });
}

async function resolveAuthoringModel(model: AgentMetadata["model"]): Promise<LanguageModel> {
  return modelFromMetadata(await withResolvedKey(model));
}

const permissionBridge = createPermissionBridge((call) =>
  scope.postMessage({
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
    if (alwaysAllow.has(key)) {
      return "allow";
    }
    const decision = await permissionBridge.ask(call, signal);
    if (decision.allow && decision.remember) {
      alwaysAllow.add(key);
    }
    return decision.allow ? "allow" : "deny";
  },
};

const attachedFiles = new Map<string, FileInfo>();

const session = new AgentSession({
  createModel: modelFromMetadata,
  createTools: (metadata, guard) => toolsFromMetadata(metadata, defaultMcpProxyConfig, guard, oauthDeps),
  filesTools: (guard) => fileToolSource(attachedFiles, guard),
  describeAttachedFiles: () => listFilesText(attachedFiles),
  secrets,
  permission,
  emit: (message) => scope.postMessage(message),
});

scope.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "load":
      ({ uses: secretUses, modelNames } = secretsOf(message.content));
      alwaysAllow.clear();
      for (const name of FILE_TOOL_NAMES) alwaysAllow.add(permissionKey(undefined, name));
      attachedFiles.clear();
      void session.load(message.content, message.seedHistory, message.allowBrowserPreview, message.confirmedTools);
      break;
    case "attach-files":
      for (const file of message.files) {
        attachedFiles.set(file.path, file);
      }
      break;
    case "detach-file":
      attachedFiles.delete(message.path);
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
      store.set(message.name, message.value, message.address);
      break;
    case "list-secrets":
      store.postNames();
      break;
    case "remove-secret":
      store.remove(message.name);
      break;
    case "set-trusted":
      alwaysAllow.clear();
      for (const name of FILE_TOOL_NAMES) alwaysAllow.add(permissionKey(undefined, name));
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
          if (result.kind === "clarify") {
            scope.postMessage({ type: "draft-clarify", questions: result.questions });
          } else {
            scope.postMessage({ type: "draft-generated", source: result.source });
          }
        })
        .catch((error) => scope.postMessage({ type: "draft-generation-error", message: describeError(error) }));
      break;
  }
});

scope.postMessage({ type: "worker-ready" });
