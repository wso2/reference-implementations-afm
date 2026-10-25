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

import { useRef } from "react";
import { usePermissionsLedger } from "../../app/PermissionsLedgerContext";
import { permissionKey } from "../../core/runtime/protocol";
import { grantsToRevoke, permissionScopeFor } from "../../core/storage/permissions-store";
import { type SessionHooks } from "../../worker-client/useStandaloneSession";

export function useAgentPermissions() {
  const permissions = usePermissionsLedger();
  const ledgerRef = useRef(permissions);
  ledgerRef.current = permissions;
  const openRef = useRef<{ agentId: string | null; content: string }>({ agentId: null, content: "" });
  const scope = () => permissionScopeFor(openRef.current.agentId, openRef.current.content);

  const sessionHooks: SessionHooks = {
    permissionSeed: () =>
      ledgerRef.current
        .forAgent(scope())
        .filter((entry) => entry.rule === "auto-allow")
        .map((entry) => permissionKey(entry.serverId, entry.toolName)),
    onRememberPermission: (request, allow) =>
      ledgerRef.current.set(scope(), request.name, allow ? "auto-allow" : "always-ask", request.serverId),
  };

  function follow(agentId: string | null, content: string): void {
    openRef.current = { agentId, content };
  }

  function revokeGrants(serverUrl: string): void {
    const current = scope();
    for (const entry of grantsToRevoke(ledgerRef.current.forAgent(current), serverUrl)) {
      ledgerRef.current.set(current, entry.toolName, "always-ask", serverUrl);
    }
  }

  return { sessionHooks, follow, revokeGrants };
}
