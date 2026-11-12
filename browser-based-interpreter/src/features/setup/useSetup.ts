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

import { type AgentMetadata } from "@afm/engine";
import { useMemo, useState } from "react";
import { findProvider } from "../../core/agent/catalogs";
import {
  answeredBy,
  changedResult,
  checkingResult,
  credentialOf,
  displayName,
  everyRowReady,
  type Issue,
  issueSentence,
  MODEL_ROW,
  plannedRows,
  resultOf,
  type RowResult,
  serverRowId,
  type SetupRow,
  valuesRow,
} from "../../core/setup/setup-check";
import { secretsOf } from "../../core/runtime/secret-gate";
import { fillValues } from "../../core/agent/secret-usage";
import { useRunTracker } from "../../ui/hooks";
import { type useStandaloneSession } from "../../worker-client/useStandaloneSession";
import { authorizationCodeRefreshKey, oauthProviderFrom } from "../../core/oauth/session";

type Session = ReturnType<typeof useStandaloneSession>;

export function useSetup(session: Session, metadata: AgentMetadata | null, content: string, agentId: string | null) {
  const [results, setResults] = useState<Record<string, RowResult>>({});
  const [entered, setEntered] = useState<{ agentId: string | null; values: Record<string, string> }>({
    agentId,
    values: {},
  });
  const runs = useRunTracker();

  const valueNames = useMemo(() => secretsOf(content).settings, [content]);
  const typed = entered.agentId === agentId ? entered.values : {};
  const values = Object.fromEntries(valueNames.map((name) => [name, Object.hasOwn(typed, name) ? typed[name]! : ""]));

  const rows: SetupRow[] = (metadata === null ? [] : [...plannedRows(metadata), ...valuesRow(valueNames, values)]).map(
    (row) => ({
      ...row,
      ...results[row.id],
    }),
  );

  function settle(id: string, result: RowResult): void {
    setResults((current) => ({ ...current, [id]: result }));
  }

  async function check(row: SetupRow, current: AgentMetadata, usable: string[]): Promise<void> {
    const server = (current.tools?.mcp ?? []).find((candidate) => serverRowId(candidate.name) === row.id);
    const http = server?.transport.type === "http" ? server.transport : undefined;
    const credential = server === undefined ? "key" : credentialOf(server);
    const run = runs.begin(row.id);
    settle(row.id, checkingResult(credential));
    const probe =
      server === undefined
        ? await session.probeModel(current.model)
        : await session.probeServer({ mcp: [fillValues(server, values)] });
    if (!runs.isCurrent(row.id, run)) return;
    const hadSignIn =
      http?.authentication !== undefined &&
      usable.includes(authorizationCodeRefreshKey(oauthProviderFrom(http.authentication, http.url)));
    const answered =
      server === undefined
        ? (findProvider(current.model?.provider ?? "")?.label ?? "")
        : answeredBy(server, probe.tools?.length ?? 0);
    settle(row.id, resultOf(probe, { credential, hadSignIn, answered }));
  }

  function run(targets: SetupRow[]): void {
    if (metadata === null) return;
    const usable = session.state.savedSecrets;
    for (const row of targets) {
      if (row.kind === "values" || (row.id === MODEL_ROW && (metadata.model?.name ?? "") === "")) continue;
      void check(row, metadata, usable);
    }
  }

  // Another agent replaced the open one. What was checked for the old agent says nothing about the new one,
  // and a check still waiting for its answer must not write it into the new agent's rows.
  function reset(): void {
    runs.reset();
    setResults({});
  }

  function start(): void {
    reset();
    run(rows);
  }

  return {
    rows,
    valueNames,
    values,
    saveValues: (next: Record<string, string>) => setEntered({ agentId, values: { ...typed, ...next } }),
    ready: everyRowReady(rows),
    start,
    reset,
    recheck: () => run(rows.filter((row) => row.state !== "ready")),
    changed: (id: string) => {
      runs.begin(id);
      settle(id, changedResult);
    },
    issueOf: (id: string): Issue | null => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row?.failure === undefined || (row.state !== "needs" && row.state !== "failed")) return null;
      const server = (metadata?.tools?.mcp ?? []).find((candidate) => serverRowId(candidate.name) === id);
      const who =
        server === undefined
          ? (findProvider(metadata?.model?.provider ?? "")?.label ?? row.name)
          : displayName(server.name);
      return {
        kind: row.failure,
        text: issueSentence(row.failure, who, server === undefined ? "key" : credentialOf(server), row.note),
      };
    },
  };
}
