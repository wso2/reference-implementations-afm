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

import type { ToolCall } from "@afm/runtime";

function createPendingBridge<K, V>() {
  const pending = new Map<K, (value: V) => void>();
  return {
    wait(key: K, abort?: { signal: AbortSignal; value: V }): Promise<V> {
      return new Promise((resolve) => {
        if (abort === undefined) {
          pending.set(key, resolve);
          return;
        }
        const { signal, value } = abort;
        const giveUp = (): void => {
          pending.delete(key);
          resolve(value);
        };
        pending.set(key, (answer) => {
          signal.removeEventListener("abort", giveUp);
          resolve(answer);
        });
        if (signal.aborted) giveUp();
        else signal.addEventListener("abort", giveUp, { once: true });
      });
    },
    resolve(key: K, value: V): void {
      const settle = pending.get(key);
      if (settle !== undefined) {
        pending.delete(key);
        settle(value);
      }
    },
  };
}

interface PermissionDecision {
  allow: boolean;
  remember: boolean;
}

interface PermissionBridge {
  ask: (call: ToolCall, signal?: AbortSignal) => Promise<PermissionDecision>;
  resolve: (id: string, decision: PermissionDecision) => void;
}

export function createPermissionBridge(request: (call: ToolCall) => void): PermissionBridge {
  const bridge = createPendingBridge<string, PermissionDecision>();
  return {
    ask(call, signal) {
      const decision = bridge.wait(call.id, signal && { signal, value: { allow: false, remember: false } });
      request(call);
      return decision;
    },
    resolve: bridge.resolve,
  };
}
