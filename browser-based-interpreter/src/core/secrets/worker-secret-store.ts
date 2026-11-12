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

import type { ServerMessage } from "../runtime/protocol";
import { type KeyValueStore } from "../oauth/session";

interface WorkerSecretStore {
  valueOf(name: string): string | undefined;
  refreshStore: KeyValueStore;
  approvedFor(name: string, address: string | undefined): boolean;
  enteredForModel(name: string, provider: string): boolean;
  set(name: string, value: string, address?: string, provider?: string): void;
  remove(name: string): void;
  postNames(): void;
}

export function createWorkerSecretStore(emit: (message: ServerMessage) => void): WorkerSecretStore {
  const values: Record<string, string> = Object.create(null);
  const approvals = new Map<string, Set<string>>();
  const providers = new Map<string, string>();

  // Sign-in refresh tokens live here, apart from the keys a person entered, so one can never stand in for the other.
  const refreshTokens = new Map<string, string>();

  // The page learns the names only, never a value. A sign-in's name is how the screens know a person is signed in.
  function postNames(): void {
    emit({ type: "secrets-list", names: [...new Set([...Object.keys(values), ...refreshTokens.keys()])] });
  }

  const refreshStore: KeyValueStore = {
    get: (key) => refreshTokens.get(key) ?? null,
    set: (key, value) => {
      refreshTokens.set(key, value);
      postNames();
    },
    remove: (key) => {
      refreshTokens.delete(key);
      postNames();
    },
  };

  return {
    valueOf: (name) => (Object.hasOwn(values, name) && values[name] !== "" ? values[name] : undefined),
    refreshStore,
    postNames,

    approvedFor: (name, address) => address !== undefined && approvals.get(name)?.has(address) === true,

    enteredForModel: (name, provider) => approvals.get(name)?.size === 0 && providers.get(name) === provider,

    set(name, value, address, provider) {
      if (value === "") return;
      values[name] = value;
      approvals.set(name, new Set(address === undefined ? [] : [address]));
      if (provider === undefined) providers.delete(name);
      else providers.set(name, provider);
      postNames();
    },

    remove(name) {
      delete values[name];
      approvals.delete(name);
      providers.delete(name);
      postNames();
    },
  };
}
