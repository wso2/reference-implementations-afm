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

import { type ToolCall } from "../tools/tool-guard";

interface PermissionDecision {
  allow: boolean;
  remember: boolean;
}

interface PermissionBridge {
  ask: (call: ToolCall, signal?: AbortSignal) => Promise<PermissionDecision>;
  resolve: (id: string, decision: PermissionDecision) => void;
}

export function createPermissionBridge(request: (call: ToolCall) => void): PermissionBridge {
  const waiting = new Map<string, (decision: PermissionDecision) => void>();

  return {
    ask(call, signal) {
      const decision = new Promise<PermissionDecision>((resolve) => {
        if (signal === undefined) {
          waiting.set(call.id, resolve);
          return;
        }
        const giveUp = (): void => {
          waiting.delete(call.id);
          resolve({ allow: false, remember: false });
        };
        waiting.set(call.id, (answer) => {
          signal.removeEventListener("abort", giveUp);
          resolve(answer);
        });
        if (signal.aborted) giveUp();
        else signal.addEventListener("abort", giveUp, { once: true });
      });
      request(call);
      return decision;
    },

    resolve(id, decision) {
      const settle = waiting.get(id);
      if (settle === undefined) return;
      waiting.delete(id);
      settle(decision);
    },
  };
}
