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

export type PermissionRule = "auto-allow" | "always-ask";

export interface PermissionEntry {
  agentId: string;
  toolName: string;
  serverId?: string;
  rule: PermissionRule;
  updatedAt: number;
}

export function setPermission(
  entries: PermissionEntry[],
  agentId: string,
  toolName: string,
  rule: PermissionRule,
  serverId?: string,
): PermissionEntry[] {
  const rest = entries.filter((e) => !(e.agentId === agentId && e.toolName === toolName && e.serverId === serverId));
  return [...rest, { agentId, toolName, serverId, rule, updatedAt: Date.now() }];
}

export function resetPermissions(entries: PermissionEntry[], agentId?: string): PermissionEntry[] {
  return agentId === undefined ? [] : entries.filter((e) => e.agentId !== agentId);
}

export function grantsToRevoke(entries: PermissionEntry[], serverId: string): PermissionEntry[] {
  return entries.filter((entry) => entry.serverId === serverId && entry.rule === "auto-allow");
}

export function permissionScopeFor(agentId: string | null, content: string): string {
  return agentId !== null ? `agent:${agentId}` : `content:${content}`;
}
