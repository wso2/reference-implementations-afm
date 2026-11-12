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

import { type ReactNode, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildableAgent, collectAfmIssues } from "../../core/agent/agent-validation";
import { type AgentActivity } from "../../core/chat/agent-activity";
import { agentFilename, downloadAgentFile } from "../../core/files/download-agent-file";
import { type Needs } from "../../core/setup/readiness";
import { ConfirmNote } from "../../ui/ConfirmNote";
import { Icon } from "../../ui/Icon";
import { type EditorMode, ModeSwitch } from "../../ui/ViewControls";
import { useSettled } from "../../ui/hooks";
import { chipAnnouncement, type ChipPhase, ReadinessChip } from "../setup/ReadinessChip";
import { BuildPane, type OpenPanel, type ServerReach } from "./BuildPane";
import { CodeEditor } from "./CodeEditor";
import { IssuePill } from "./IssuePill";

interface EditableProps {
  content: string;
  onChange: (content: string) => void;
}

interface Props extends EditableProps {
  activity: AgentActivity;
  reach: ServerReach;
  onOpenModel: () => void;
  onOpenServer: (name: string | null) => void;
  showRaw?: number;
  chip?: { needs: Needs; phase: ChipPhase; onHold: (held: boolean) => void };
  toolbarExtras?: ReactNode;
  openPanel?: OpenPanel;
  onModeChange?: (mode: EditorMode) => void;
}

export function EditorPane({
  content,
  onChange,
  activity,
  reach,
  onOpenModel,
  onOpenServer,
  showRaw = 0,
  chip,
  toolbarExtras,
  openPanel,
  onModeChange,
}: Props) {
  const [mode, setMode] = useState<EditorMode>("simple");
  const announceMode = useEffectEvent((next: EditorMode) => onModeChange?.(next));
  useEffect(() => announceMode(mode), [mode]);
  const [asking, setAsking] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const firstRaw = useRef(showRaw);
  useEffect(() => {
    if (showRaw !== firstRaw.current) setMode("raw");
  }, [showRaw]);
  const buildable = useMemo(() => buildableAgent(content), [content]);
  const settled = useSettled(content);
  const issues = useMemo(() => collectAfmIssues(settled), [settled]);

  function changeMode(next: EditorMode) {
    if (next === "simple" && mode === "raw" && !buildable.ok) {
      setAsking(true);
      return;
    }
    setAsking(false);
    setMode(next);
  }

  const top = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = top.current;
    if (row === null) return;
    const stage = row.parentElement;
    const card = stage?.querySelector<HTMLElement>(".u-brief") ?? null;
    const place = () => {
      if (card === null) {
        row.style.removeProperty("--need-x");
        stage?.style.removeProperty("--card-x");
        stage?.style.removeProperty("--card-w");
        return;
      }
      const r = row.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      row.style.setProperty("--need-x", `${c.left + c.width / 2 - r.left}px`);
      stage?.style.setProperty("--card-x", `${c.left - r.left}px`);
      stage?.style.setProperty("--card-w", `${c.width}px`);
    };
    place();
    const watch = new ResizeObserver(place);
    watch.observe(row);
    if (card !== null) watch.observe(card);
    return () => watch.disconnect();
  }, [mode, buildable.ok]);

  return (
    <>
      <div className="u-stage-top" ref={top}>
        <span className="u-mode-wrap" ref={wrap}>
          <ModeSwitch mode={mode} onMode={changeMode} />
          {asking && (
            <ConfirmNote
              title="Invalid AFM file"
              text="Fix the issues before you switch to Build."
              secondary={{
                label: "Switch to Build",
                onPick: () => {
                  setAsking(false);
                  setMode("simple");
                },
              }}
              primary={{ label: "Stay in Raw", onPick: () => setAsking(false) }}
              focus="primary"
              onDismiss={() => setAsking(false)}
              wrap={wrap}
            />
          )}
        </span>
        {mode === "raw" && (
          <>
            <span className="u-spacer" />
            <span className="u-raw-file">{agentFilename(content)}</span>
            <button className="u-btn ghost sm" onClick={() => downloadAgentFile(content)}>
              Download
            </button>
          </>
        )}
        {toolbarExtras !== undefined && <span className="u-stage-tools">{toolbarExtras}</span>}
        {chip !== undefined && (
          <>
            <ReadinessChip needs={chip.needs} phase={chip.phase} onHold={chip.onHold} />
            <span className="visually-hidden" role="status" aria-live="polite">
              {chipAnnouncement(chip.needs, chip.phase)}
            </span>
          </>
        )}
      </div>

      {mode === "raw" ? (
        <RawEditor content={content} onChange={onChange} issues={issues} />
      ) : (
        <>
          {!buildable.ok && <InvalidBanner onView={() => setMode("raw")} />}
          <div className="u-stage-canvas">
            <BuildPane
              content={content}
              onChange={onChange}
              metadata={buildable.ok ? buildable.metadata : null}
              onOpenModel={onOpenModel}
              onOpenServer={onOpenServer}
              activity={activity}
              reach={reach}
              openPanel={openPanel}
            />
          </div>
        </>
      )}
    </>
  );
}

export function RawEditor({
  content,
  onChange,
  issues,
}: EditableProps & { issues: ReturnType<typeof collectAfmIssues> }) {
  const errorLines = new Set(
    issues.filter((issue) => issue.severity === "error" && issue.line !== null).map((issue) => issue.line as number),
  );
  return (
    <div className="u-stage-canvas">
      <div className="u-rawwrap">
        <CodeEditor value={content} onChange={onChange} errorLines={errorLines} />
        <div className="u-pill-dock">
          <IssuePill issues={issues} />
        </div>
      </div>
    </div>
  );
}

function InvalidBanner({ onView }: { onView: () => void }) {
  return (
    <div className="u-invalid" role="alert">
      <Icon size={18}>
        <path d="M12 9v5M12 17.4h.01" />
        <path d="M10.3 3.9L2.4 17.4A2 2 0 004.1 20.5h15.8a2 2 0 001.7-3.1L13.7 3.9a2 2 0 00-3.4 0z" />
      </Icon>
      <span className="u-invalid-text">Invalid AFM file</span>
      <button className="u-btn primary sm" onClick={onView}>
        View
      </button>
    </div>
  );
}
