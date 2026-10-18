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

import type { SecretPort, SecretRef } from "@afm/engine";

export function configSecretPort(values: Record<string, string>): SecretPort {
  return {
    async resolve(ref) {
      const value = Object.hasOwn(values, ref.name) ? values[ref.name] : undefined;
      if (value === undefined || value === "") {
        return { status: "unresolved", reason: `'${ref.name}' is not in the host config` };
      }
      return { status: "resolved", value };
    },
  };
}

export function promptSecretPort(
  ask: (ref: SecretRef) => Promise<string | null>,
): SecretPort {
  return {
    async resolve(ref) {
      const value = await ask(ref);
      if (value === null || value === "") {
        return { status: "unresolved", reason: `'${ref.name}' was not provided` };
      }
      return { status: "resolved", value };
    },
  };
}

export function chainSecretPort(...ports: SecretPort[]): SecretPort {
  return {
    async resolve(ref) {
      for (const port of ports) {
        const result = await port.resolve(ref);
        if (result.status === "resolved") {
          return result;
        }
      }
      return { status: "unresolved", reason: `'${ref.name}' could not be resolved by any source` };
    },
  };
}
