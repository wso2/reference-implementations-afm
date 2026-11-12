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

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useAgentsLibrary, useThemeContext } from "../../app/contexts";
import { getSection } from "../../core/agent/agent-source-edit";
import { type PendingPermission } from "../../core/chat/chat-state";
import {
  identityFor,
  missingAgentId,
  missingAgentNotice,
  openingOf,
  shownIcon,
} from "../../core/links/workspace-content";
import { quietInRaw } from "../../core/setup/readiness";
import { reachOf, type SetupRow } from "../../core/setup/setup-check";
import { SidePane } from "../../ui/SideWindow";
import { StageFoot } from "../../ui/StageFoot";
import { type EditorMode } from "../../ui/ViewControls";
import { useMediaQuery } from "../../ui/hooks";
import { useStandaloneSession } from "../../worker-client/useStandaloneSession";
import { EditorPane } from "../editor/EditorPane";
import { TrustScreen } from "../setup/TrustScreen";
import { useSetup } from "../setup/useSetup";
import { StartHere } from "../start/StartHere";
import { AgentPicker } from "./AgentPicker";
import { ChatHead, ChatPane, StatusPill } from "./ChatPane";
import { OverPanel } from "./OverPanel";
import { AboutButton, ShareButton, WorkspaceBar } from "./WorkspaceBar";
import { useRunControl } from "./useRunControl";
import { usePanelEscape, usePanelFocus } from "./usePanelKeys";
import { useRecordedChat, useWorkspaceDocument } from "./useWorkspaceDocument";
import { LEFT_TITLE, openOver, type SidePanel, useAgentActivity, usePanels } from "./workspace-view";

const COMPACT_QUERY = "(max-width: 640px)";

const PANEL_OF_ROW: Record<SetupRow["kind"], SidePanel> = { model: "model", server: "tools", values: "values" };

export function WorkspacePage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const draftSource = (location.state as { draftSource?: string } | null)?.draftSource;
  const [serverEditing, setServerEditing] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("simple");
  const [rawRequest, setRawRequest] = useState(0);
  const theme = useThemeContext();
  const library = useAgentsLibrary();
  const compact = useMediaQuery(COMPACT_QUERY);
  const chatView = searchParams.get("view") === "chat";
  const [opening] = useState(() => openingOf(searchParams, location.hash, draftSource));
  const {
    nav,
    side,
    backToSetup,
    left,
    setLeft,
    chatFull,
    setChatFull,
    reveal,
    openSide,
    toggleSide,
    leavePanel,
    closeSide,
    openLeft,
    toggleLeft,
    closeLeft,
    closeChat,
  } = usePanels(
    {
      chat: chatView,
      start: !chatView && (identityFor(opening) === "blank" || missingAgentId(opening) !== null),
    },
    compact,
  );
  const remember = useRef<(request: PendingPermission) => void>(() => {});
  const session = useStandaloneSession({
    onRememberPermission: (request, allow) => {
      if (allow) remember.current(request);
    },
  });
  const resetSetup = useRef<() => void>(() => {});
  const doc = useWorkspaceDocument({
    clearAgent: () => {
      session.clearAgent();
      resetSetup.current();
    },
    onMissingAgent: () => setLeft("start"),
  });
  remember.current = (request) => doc.trustRequested(request.serverId, request.name);
  const { content, readable } = doc;
  const activity = useAgentActivity(session.state);
  const agentLabel = (readable.ok ? readable.metadata.name : undefined) ?? "Untitled agent";
  const agentIcon = readable.ok ? shownIcon(doc.trusted, readable.metadata.icon_url) : "";
  useRecordedChat(doc.agentId, agentLabel, content, session.state);
  const setup = useSetup(session, readable.ok ? readable.metadata : null, content);
  resetSetup.current = setup.reset;
  const run = useRunControl({
    content,
    setContent: doc.setContent,
    readable,
    session,
    activity,
    confirmedTools: doc.confirmedTools,
    values: setup.values,
    persistToLibrary: doc.persistToLibrary,
    startSetup: setup.start,
    openSide,
  });

  function configure(row: SetupRow) {
    if (row.kind === "server") setServerEditing(row.name);
    reveal(openOver(nav, PANEL_OF_ROW[row.kind]));
  }

  function resetToBlank() {
    closeSide();
    doc.startBlank();
  }

  const dismissMissingAgent = useEffectEvent(doc.dismissMissingAgent);
  useEffect(() => {
    if (left !== "start") dismissMissingAgent();
  }, [left]);

  const startDialog = left === "start" && !compact;
  const leftPanel = startDialog ? null : left;
  const startHere = (dialog: boolean) => (
    <StartHere
      dialog={dialog}
      notice={doc.missingAgent === null ? undefined : missingAgentNotice(doc.missingAgent)}
      state={session.state}
      onUseSource={(source, fromOutside = false) => {
        doc.startFrom(source, fromOutside);
        closeLeft();
        closeSide();
      }}
      onBlank={closeLeft}
      onGenerate={(prompt, model, final) => session.generateDraft(prompt, model, final)}
      onSaveKey={session.storeModelKey}
      onDismissDraft={session.dismissDraft}
    />
  );

  const overPanel = side !== null && side !== "chat" ? side : null;
  const leftRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  usePanelEscape(
    leftRef,
    sideRef,
    { left: leftPanel !== null, side: side !== null, over: overPanel !== null },
    {
      left: closeLeft,
      over: leavePanel,
      chat: closeChat,
    },
  );
  usePanelFocus(leftRef, leftPanel, leftPanel === null ? 0 : 1);
  usePanelFocus(sideRef, side, side === null ? 0 : nav.under.length + 1);
  const reachedServerIds = [
    ...new Set(session.state.tools.map((tool) => tool.serverId).filter((id): id is string => id !== undefined)),
  ];

  return (
    <div className="workspace-shell">
      <WorkspaceBar
        agentName={agentLabel}
        saveFailed={doc.saveFailed}
        canAct={run.preview.ok}
        canRun={run.canRun}
        running={run.running}
        onRun={run.requestRun}
        runPrompt={run.pendingConfirmation}
        onAcceptRunPrompt={run.acceptRunPrompt}
        onDeclineRunPrompt={run.declineRunPrompt}
        runTip={run.runTip}
        open={side}
        onToggle={toggleSide}
        agentsOpen={left === "agents"}
        onToggleAgents={() => toggleLeft("agents")}
        onToggleTheme={theme.toggle}
        dark={theme.resolved === "dark"}
        compact={compact}
      />

      {doc.fileLoading && <div className="draft-banner">Loading the agent file…</div>}
      {doc.fileError !== null && (
        <div className="draft-banner draft-banner-error">
          <span>{doc.fileError}</span>
        </div>
      )}

      <div
        className={`u-body ${side !== null ? "has-side" : ""} ${leftPanel !== null ? "has-left" : ""} ${
          chatFull ? "is-chat-full" : ""
        }`}
      >
        {doc.showTrust && readable.ok && (
          <TrustScreen
            key={doc.documentKey}
            metadata={readable.metadata}
            source={content}
            savedSecrets={session.state.savedSecrets}
            fileUrl={doc.linkedFile}
            canRun={run.canRun}
            onRun={(ticked) => {
              doc.confirmTools(ticked);
              doc.trust();
              run.requestRun();
            }}
            onOpenBuilder={(ticked) => {
              doc.confirmTools(ticked);
              doc.trust();
              setChatFull(false);
              closeSide();
            }}
          />
        )}
        <aside className="u-side-left" aria-hidden={leftPanel === null} ref={leftRef}>
          {leftPanel !== null && (
            <SidePane key={leftPanel} title={LEFT_TITLE[leftPanel]} onClose={closeLeft} flush={leftPanel === "agents"}>
              {leftPanel === "agents" && (
                <AgentPicker
                  currentId={doc.agentId}
                  onPick={(saved) => {
                    closeLeft();
                    closeSide();
                    doc.openSaved(saved.id);
                  }}
                  onNew={() => {
                    resetToBlank();
                    openLeft("start");
                  }}
                  onRemoved={(removed) => {
                    if (removed.id === doc.agentId) resetToBlank();
                  }}
                />
              )}
              {leftPanel === "start" && startHere(false)}
            </SidePane>
          )}
        </aside>

        <div className="u-stage" inert={doc.fileLoading}>
          <EditorPane
            content={content}
            onChange={run.editContent}
            activity={activity}
            reach={reachOf(setup.rows, reachedServerIds)}
            onOpenModel={() => openSide("model")}
            onOpenServer={(name) => {
              setServerEditing(name);
              openSide("tools");
            }}
            showRaw={rawRequest}
            onModeChange={setEditorMode}
            openPanel={{
              model: overPanel === "model",
              server: overPanel === "tools" ? serverEditing : null,
              adding: overPanel === "tools" && serverEditing === null,
            }}
            chip={run.chip}
            toolbarExtras={
              compact ? (
                <>
                  <ShareButton open={side} onToggle={toggleSide} canAct={run.preview.ok} />
                  <AboutButton open={side} onToggle={toggleSide} />
                </>
              ) : undefined
            }
          />
          <StageFoot
            state={quietInRaw(run.ready, editorMode === "raw")}
            onFix={(fix) => {
              if (fix === "raw") {
                setRawRequest((n) => n + 1);
                return;
              }
              // Open the server that went quiet, not the one that was open last.
              if (fix === "tools") setServerEditing(run.ready.server ?? null);
              openSide(fix);
            }}
          />
        </div>

        {startDialog && startHere(true)}

        <div className="u-float-scrim" onClick={side !== null ? leavePanel : closeLeft} role="presentation" />

        <aside className="u-side" aria-hidden={side === null} ref={sideRef}>
          <SidePane
            title="Chat"
            heading={
              chatFull && !compact ? (
                <StatusPill status={run.chatState} />
              ) : (
                <ChatHead name={agentLabel} iconUrl={agentIcon} status={run.chatState} />
              )
            }
            onClose={closeChat}
            onExpand={chatFull ? undefined : () => setChatFull(true)}
            floating={chatFull}
            covered={overPanel !== null}
            flush
          >
            <ChatPane
              session={session}
              serverNameByUrl={run.nameByUrl}
              onReplaceKey={() => openSide("model")}
              onRetry={run.openSetup}
              description={readable.ok ? (readable.metadata.description ?? "") : ""}
              role={getSection(content, "Role")}
              iconUrl={agentIcon}
            />
          </SidePane>

          {overPanel !== null && (
            <OverPanel
              panel={overPanel}
              content={content}
              readable={readable}
              session={session}
              setup={setup}
              savedAgent={library.agents.find((agent) => agent.id === doc.agentId)}
              serverEditing={serverEditing}
              backToSetup={backToSetup}
              documentKey={doc.documentKey}
              trusted={doc.confirmedTools ?? null}
              onContent={doc.setContent}
              onApplyServer={doc.applyServer}
              onTrustedChange={(keys) => {
                doc.setTrusted(keys);
                session.syncTrusted(keys);
              }}
              onConfigure={configure}
              onRun={run.runAgent}
              onLeave={leavePanel}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
