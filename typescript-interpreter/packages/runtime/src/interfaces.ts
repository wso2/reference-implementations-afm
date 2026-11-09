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

import { type AgentMetadata, checkSignature, type Signature, TEXT_SIGNATURE } from "@afm/engine";

type Interface = NonNullable<AgentMetadata["interfaces"]>[number];
export type WebChat = Extract<Interface, { type: "webchat" }>;
export type Webhook = Extract<Interface, { type: "webhook" }>;

export interface ChosenInterfaces {
  console?: { signature: Signature };
  webchat?: WebChat;
  webhook?: Webhook;
}

export const UI_PATH = "/chat/ui";
export const pathOf = (item: WebChat | Webhook): string => item.exposure.http?.path ?? (item.type === "webchat" ? "/chat" : "/webhook");
const RESERVED_PATHS = ["/", "/health", UI_PATH];

function checkPath(label: string, path: string): void {
  if (!path.startsWith("/")) throw new Error(`The HTTP path of the ${label} interface must start with '/'.`);
  if (RESERVED_PATHS.includes(path)) throw new Error(`The HTTP path '${path}' of the ${label} interface is reserved.`);
}

export function chooseInterfaces({ interfaces }: AgentMetadata): ChosenInterfaces {
  if (interfaces === undefined || interfaces.length === 0) return { console: { signature: TEXT_SIGNATURE } };
  const chosen: ChosenInterfaces = {};
  for (const item of interfaces) {
    if (item.type === "platformchat") throw new Error("The 'platformchat' interface is not yet supported by this interpreter.");
    if (item.type !== "webhook") checkSignature(item.signature, item.type);
    const kind = item.type === "consolechat" ? "console" : item.type;
    if (chosen[kind] !== undefined) throw new Error("Multiple consolechat, webchat, or webhook interfaces are not supported.");
    if (item.type === "consolechat") chosen.console = item;
    else if (item.type === "webchat") chosen.webchat = item;
    else chosen.webhook = item;
  }
  if (chosen.webchat !== undefined && chosen.webhook !== undefined && pathOf(chosen.webchat) === pathOf(chosen.webhook)) {
    throw new Error(`The HTTP path '${pathOf(chosen.webchat)}' is used by both webchat and webhook.`);
  }
  if (chosen.webchat !== undefined) checkPath("webchat", pathOf(chosen.webchat));
  if (chosen.webhook !== undefined) checkPath("webhook", pathOf(chosen.webhook));
  return chosen;
}

