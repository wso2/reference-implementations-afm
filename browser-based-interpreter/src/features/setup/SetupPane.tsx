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

import { useEffect, useRef } from "react";
import { MODEL_ROW, rowLabel, type SetupRow, summaryOf } from "../../core/setup/setup-check";
import { Icon } from "../../ui/Icon";
import { NameMark, ProviderBadge } from "../../ui/Marks";

const AUTO_RUN_DELAY_MS = 500;

interface Props {
  rows: SetupRow[];
  provider: string;
  ready: boolean;
  onConfigure: (row: SetupRow) => void;
  onCheckAgain: () => void;
  onRun: () => void;
}

function Status({ row, onConfigure }: { row: SetupRow; onConfigure: () => void }) {
  if (row.state === "ready") {
    return (
      <span className="u-run-st ok">
        <Icon size={16} weight={2}>
          <circle cx="12" cy="12" r="10" />
          <path d="m9 12 2 2 4-4" />
        </Icon>
        Ready
      </span>
    );
  }
  if (row.state === "checking") {
    return (
      <span className="u-run-st">
        <span className="u-spinner" aria-hidden="true" />
        Checking
      </span>
    );
  }
  if (row.state === "needs" || row.state === "failed") {
    return (
      <button className="u-btn ghost sm" onClick={onConfigure}>
        Configure
      </button>
    );
  }
  return (
    <span className="u-run-st wait">
      <i />
      {row.state === "changed" ? "Not checked" : "Waiting"}
    </span>
  );
}

function rowTone(row: SetupRow): string {
  if (row.state === "changed") return "is-changed";
  if (row.state !== "needs" && row.state !== "failed") return "";
  return row.failure === "signin" || row.failure === "rejected" ? "is-bad" : "is-need";
}

export function SetupPane({ rows, provider, ready, onConfigure, onCheckAgain, onRun }: Props) {
  const run = useRef(onRun);
  run.current = onRun;
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => run.current(), AUTO_RUN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [ready]);

  const summary = summaryOf(rows);
  const servers = rows.filter((row) => row.kind === "server");
  const values = rows.filter((row) => row.kind === "values");
  const busy = rows.some((row) => row.state === "checking");

  const renderRow = (row: SetupRow) => (
    <div className={`u-run-row ${rowTone(row)}`} key={row.id}>
      {row.kind === "model" ? <ProviderBadge provider={provider} /> : <NameMark name={row.name} />}
      <span className="u-run-t">
        <span className="u-run-name">{rowLabel(row)}</span>
        <span className="u-run-note">{row.note}</span>
      </span>
      <Status row={row} onConfigure={() => onConfigure(row)} />
    </div>
  );

  return (
    <>
      <div className="u-panel-body">
        <div className="u-run-sum">
          <span className={`u-chip ${summary.tone}`}>{summary.chip}</span>
          <span>{summary.text}</span>
        </div>
        <span className="u-label">Model</span>
        {rows.filter((row) => row.id === MODEL_ROW).map(renderRow)}
        {servers.length > 0 && (
          <>
            <span className="u-label u-run-gap">Tools · {servers.length}</span>
            {servers.map(renderRow)}
          </>
        )}
        {values.length > 0 && (
          <>
            <span className="u-label u-run-gap">Values</span>
            {values.map(renderRow)}
          </>
        )}
      </div>

      <div className="u-panel-foot">
        <button
          className={`u-btn ${rows.some((row) => row.state === "changed") ? "primary" : "ghost"}`}
          disabled={busy}
          onClick={onCheckAgain}
        >
          Check again
        </button>
        <div className="u-spacer" />
        <button className="u-btn primary" disabled={!ready} onClick={onRun}>
          <span className="u-play" aria-hidden="true" />
          Run
        </button>
      </div>
    </>
  );
}
