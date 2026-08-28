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

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { grantsToRevoke, permissionScopeFor, resetPermissions, setPermission } from "./permissions-store";
import type { PermissionEntry } from "./permissions-store";

const SOURCE = "---\nname: Demo\n---\n\n# Role\nr\n\n# Instructions\ni\n";

describe("grantsToRevoke", () => {
  const A = "https://a.example/mcp";
  const B = "https://b.example/mcp";
  const entry = (
    toolName: string,
    serverId: string | undefined,
    rule: PermissionEntry["rule"] = "auto-allow",
  ): PermissionEntry => ({
    agentId: "agent:1",
    toolName,
    serverId,
    rule,
    updatedAt: 0,
  });

  it("takes back every grant on the server", () => {
    const entries = [entry("search", A), entry("fetch", A)];
    expect(grantsToRevoke(entries, A)).toEqual(entries);
  });

  it("leaves another server's grant alone, even for a tool of the same name", () => {
    expect(grantsToRevoke([entry("search", B)], A)).toEqual([]);
  });

  it("leaves alone what already asks, and entries that belong to no server", () => {
    const entries = [entry("search", A, "always-ask"), entry("fetch", undefined)];
    expect(grantsToRevoke(entries, A)).toEqual([]);
  });
});

describe("permissionScopeFor", () => {
  it("survives an edit to the agent file", () => {
    const before = permissionScopeFor("agent-1", SOURCE);
    const after = permissionScopeFor("agent-1", SOURCE + "\ntool_filter added\n");
    expect(after).toBe(before);
  });

  it("keeps two saved agents apart", () => {
    expect(permissionScopeFor("agent-1", SOURCE)).not.toBe(permissionScopeFor("agent-2", SOURCE));
  });

  it("falls back to the text for an agent that was never saved", () => {
    expect(permissionScopeFor(null, SOURCE)).toMatch(/^content:/);
    expect(permissionScopeFor(null, SOURCE)).not.toBe(permissionScopeFor(null, SOURCE + "x"));
  });

  it("never lets two different texts share grants, even when they would hash alike", () => {
    expect(permissionScopeFor(null, "Aa")).not.toBe(permissionScopeFor(null, "BB"));
  });
});

describe("setPermission", () => {
  const A = "https://a.example/mcp";
  const B = "https://b.example/mcp";

  it("adds the grant to what is already there", () => {
    const first = setPermission([], "agent:1", "search", "auto-allow", A);
    const both = setPermission(first, "agent:1", "fetch", "auto-allow", A);
    expect(both.map((entry) => entry.toolName)).toEqual(["search", "fetch"]);
  });

  it("replaces the answer for the same agent, tool and server", () => {
    const granted = setPermission([], "agent:1", "search", "auto-allow", A);
    const taken = setPermission(granted, "agent:1", "search", "always-ask", A);
    expect(taken).toHaveLength(1);
    expect(taken[0]?.rule).toBe("always-ask");
  });

  it("keeps the same tool apart across servers and agents", () => {
    let entries = setPermission([], "agent:1", "search", "auto-allow", A);
    entries = setPermission(entries, "agent:1", "search", "auto-allow", B);
    entries = setPermission(entries, "agent:2", "search", "auto-allow", A);
    expect(entries).toHaveLength(3);
  });

  it("leaves the list it was given alone", () => {
    const before: PermissionEntry[] = [];
    setPermission(before, "agent:1", "search", "auto-allow", A);
    expect(before).toEqual([]);
  });
});

describe("resetPermissions", () => {
  const entries = [
    ...setPermission([], "agent:1", "search", "auto-allow"),
    ...setPermission([], "agent:2", "search", "auto-allow"),
  ];

  it("forgets one agent and keeps the rest", () => {
    expect(resetPermissions(entries, "agent:1").map((entry) => entry.agentId)).toEqual(["agent:2"]);
  });

  it("forgets everything when no agent is named", () => {
    expect(resetPermissions(entries)).toEqual([]);
  });
});

describe("the grants", () => {
  it("never reach a browser store", () => {
    for (const file of ["permissions-store.ts", "../../app/PermissionsLedgerContext.tsx"]) {
      const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
      expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|local-json-store/);
    }
  });
});
