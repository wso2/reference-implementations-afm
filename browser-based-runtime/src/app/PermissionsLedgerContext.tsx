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

import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import { setPermission, resetPermissions } from "../core/storage/permissions-store";
import type { PermissionEntry, PermissionRule } from "../core/storage/permissions-store";

interface PermissionsLedgerValue {
  entries: PermissionEntry[];
  forAgent: (agentId: string) => PermissionEntry[];
  set: (agentId: string, toolName: string, rule: PermissionRule, serverId?: string) => void;
  reset: (agentId?: string) => void;
}

const PermissionsLedgerContext = createContext<PermissionsLedgerValue | null>(null);

export function PermissionsLedgerProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<PermissionEntry[]>([]);

  const value: PermissionsLedgerValue = {
    entries,
    forAgent: (agentId) => entries.filter((e) => e.agentId === agentId),
    set: (agentId, toolName, rule, serverId) =>
      setEntries((current) => setPermission(current, agentId, toolName, rule, serverId)),
    reset: (agentId) => setEntries((current) => resetPermissions(current, agentId)),
  };

  return <PermissionsLedgerContext.Provider value={value}>{children}</PermissionsLedgerContext.Provider>;
}

export function usePermissionsLedger(): PermissionsLedgerValue {
  const value = useContext(PermissionsLedgerContext);
  if (value === null) {
    throw new Error("usePermissionsLedger must be used within a PermissionsLedgerProvider");
  }
  return value;
}
