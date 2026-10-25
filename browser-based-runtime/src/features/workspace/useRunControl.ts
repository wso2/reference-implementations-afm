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

import { useCallback, useMemo, useRef, useState } from "react";
import { useHistory } from "../../app/contexts";
import { agentBrief, getSection } from "../../core/agent/agent-source-edit";
import { buildableAgent, collectAfmIssues, previewAgent } from "../../core/agent/agent-validation";
import { type AgentActivity } from "../../core/chat/agent-activity";
import { type ChatState } from "../../core/chat/chat-state";
import {
  chipStatus,
  needsToRun,
  readiness,
  readinessSentence,
  runReason,
  serverNameByUrl,
} from "../../core/setup/readiness";
import { useSettled } from "../../ui/hooks";
import { type useStandaloneSession } from "../../worker-client/useStandaloneSession";
import { useReadyChip } from "../setup/ReadinessChip";
import { type RunConfirmation, runConfirmations } from "../setup/run-confirmations";
import { headerStatus } from "./ChatPane";
import { type SidePanel } from "./workspace-view";

type Readable = ReturnType<typeof buildableAgent>;

function useFileAnalysis(content: string) {
  return useMemo(
    () => ({
      preview: previewAgent(content),
      issues: collectAfmIssues(content),
      role: getSection(content, "Role"),
      instructions: getSection(content, "Instructions"),
    }),
    [content],
  );
}

function useReadiness(content: string, readable: Readable, state: ChatState, activity: AgentActivity) {
  const settledContent = useSettled(content);
  const { preview, issues: fileIssues, role, instructions } = useFileAnalysis(content);
  const settled = useFileAnalysis(settledContent);
  const running = state.status !== "no-agent" && state.status !== "not-ready";
  const startedHere = state.status !== "no-agent" && state.agentSource === content;
  const failed = startedHere && state.status === "not-ready";
  const current = running && startedHere;
  const typedNeeds = needsToRun({ role, instructions, metadata: readable.ok ? readable.metadata : null });
  const canRun =
    preview.ok &&
    preview.plan.runnable &&
    !fileIssues.some((issue) => issue.severity === "error") &&
    !current &&
    typedNeeds?.allDone === true;

  const servers = readable.ok ? (readable.metadata.tools?.mcp ?? []) : [];
  const nameByUrl = serverNameByUrl(servers);
  const chatState = headerStatus(
    state.status,
    activity.phase,
    activity.serverId === undefined ? undefined : nameByUrl.get(activity.serverId),
  );

  const settledPreview = settled.preview;
  const readinessMetadata = settledPreview.ok ? settledPreview.metadata : readable.ok ? readable.metadata : null;
  const ready = readiness({
    role: settled.role,
    instructions: settled.instructions,
    metadata: readinessMetadata,
    issues: [
      ...settled.issues,
      ...(settledPreview.ok
        ? settledPreview.plan.issues
            .filter((issue) => issue.severity === "blocked")
            .map((issue) => ({
              severity: "error" as const,
              message: issue.message,
              field: issue.path ?? "",
              line: null,
            }))
        : []),
    ],
    status: state.status,
    current,
    failed,
    brokenServerIds: activity.brokenServerIds,
    serverNameByUrl: nameByUrl,
  });
  const needs = needsToRun({ role: settled.role, instructions: settled.instructions, metadata: readinessMetadata });
  const runTip = canRun
    ? "Start the agent with this file"
    : ((needs !== null ? runReason(needs) : null) ??
      (ready.tone === "bad" ? readinessSentence(ready) : "Fix the file before running"));

  return { preview, running, canRun, nameByUrl, chatState, ready, needs, runTip };
}

interface Options {
  content: string;
  setContent: (next: string) => void;
  readable: Readable;
  session: ReturnType<typeof useStandaloneSession>;
  activity: AgentActivity;
  confirmedTools: string[] | undefined;
  persistToLibrary: () => { id: string | null };
  startSetup: () => void;
  openSide: (panel: SidePanel) => void;
}

export function useRunControl(options: Options) {
  const { content, setContent, readable, session, activity, confirmedTools, persistToLibrary, startSetup, openSide } =
    options;
  const history = useHistory();
  const [runPrompt, setRunPrompt] = useState<{ source: string; choices: RunConfirmation[]; index: number } | null>(
    null,
  );
  const [approvedPreviewSource, setApprovedPreviewSource] = useState<string | null>(null);
  const [chipHeld, setChipHeld] = useState(false);
  const lastEditAt = useRef(0);
  const { preview, running, canRun, nameByUrl, chatState, ready, needs, runTip } = useReadiness(
    content,
    readable,
    session.state,
    activity,
  );
  const chipPhase = useReadyChip(chipStatus(needs, ready), lastEditAt, chipHeld);

  const editContent = useCallback(
    (next: string) => {
      lastEditAt.current = Date.now();
      setRunPrompt(null);
      setApprovedPreviewSource(null);
      setContent(next);
    },
    [setContent],
  );

  function openSetup() {
    startSetup();
    openSide("setup");
  }

  function requestRun() {
    if (!canRun || !preview.ok) return;
    const choices = runConfirmations(preview.metadata, preview.plan.issues);
    setApprovedPreviewSource(null);
    if (choices.length === 0) {
      openSetup();
      return;
    }
    setRunPrompt({ source: content, choices, index: 0 });
  }

  function acceptRunPrompt() {
    if (runPrompt === null) return;
    if (runPrompt.source !== content) {
      setRunPrompt(null);
      return;
    }
    if (runPrompt.index + 1 < runPrompt.choices.length) {
      setRunPrompt({ ...runPrompt, index: runPrompt.index + 1 });
      return;
    }
    setRunPrompt(null);
    setApprovedPreviewSource(content);
    openSetup();
  }

  function runAgent() {
    if (!canRun) return;
    if (
      preview.ok &&
      runConfirmations(preview.metadata, preview.plan.issues).length > 0 &&
      approvedPreviewSource !== content
    ) {
      requestRun();
      return;
    }
    const { id } = persistToLibrary();
    const previous = id === null ? undefined : history.entries.find((entry) => entry.agentId === id);
    const rewritten = running && agentBrief(session.state.agentSource) !== agentBrief(content);
    session.loadContent(content, previous?.messages, {
      carryConversation: !rewritten,
      allowBrowserPreview: approvedPreviewSource === content,
      confirmedTools,
    });
    openSide("chat");
  }

  return {
    preview,
    running,
    canRun,
    runTip,
    nameByUrl,
    chatState,
    ready,
    editContent,
    openSetup,
    requestRun,
    acceptRunPrompt,
    runAgent,
    declineRunPrompt: () => setRunPrompt(null),
    pendingConfirmation: runPrompt?.source === content ? (runPrompt.choices[runPrompt.index] ?? null) : null,
    chip: needs === null ? undefined : { needs, phase: chipPhase, onHold: setChipHeld },
  };
}
