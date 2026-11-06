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
import {
  identityFor,
  missingAgentId,
  missingAgentNotice,
  openingOf,
} from "../../core/links/workspace-content";
import { reachOf } from "../../core/setup/setup-check";
import { SidePane } from "../../ui/SideWindow";
import { useMediaQuery } from "../../ui/hooks";
import { useStandaloneSession } from "../../worker-client/useStandaloneSession";
import { EditorPane } from "../editor/EditorPane";
import { useSetup } from "../setup/useSetup";
import { StartHere } from "../start/StartHere";
import { AgentPicker } from "./AgentPicker";
import { OverPanel } from "./OverPanel";
import { AboutButton, ShareButton, WorkspaceBar } from "./WorkspaceBar";
import { usePanelEscape, usePanelFocus } from "./usePanelKeys";
import { useRecordedChat, useWorkspaceDocument } from "./useWorkspaceDocument";
import { LEFT_TITLE, useAgentActivity, usePanels } from "./workspace-view";

const COMPACT_QUERY = "(max-width: 640px)";

export function WorkspacePage() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const draftSource = (location.state as { draftSource?: string } | null)?.draftSource;
  const [serverEditing, setServerEditing] = useState<string | null>(null);
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
  const session = useStandaloneSession();
  const doc = useWorkspaceDocument({ clearAgent: session.clearAgent, onMissingAgent: () => setLeft("start") });
  const { content, readable } = doc;
  const activity = useAgentActivity(session.state);
  const agentLabel = (readable.ok ? readable.metadata.name : undefined) ?? "Untitled agent";
  useRecordedChat(doc.agentId, agentLabel, content, session.state);
  const setup = useSetup(session, readable.ok ? readable.metadata : null);

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
      onSaveKey={session.storeSecret}
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
        canAct={readable.ok}
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

        <div className="u-stage">
          <EditorPane
            content={content}
            onChange={doc.setContent}
            onRawInsert={doc.holdInserted}
            activity={activity}
            reach={reachOf(setup.rows, reachedServerIds)}
            onOpenModel={() => openSide("model")}
            onOpenServer={(name) => {
              setServerEditing(name);
              openSide("tools");
            }}
            openPanel={{
              model: overPanel === "model",
              server: overPanel === "tools" ? serverEditing : null,
              adding: overPanel === "tools" && serverEditing === null,
            }}
            toolbarExtras={
              compact ? (
                <>
                  <ShareButton open={side} onToggle={toggleSide} canAct={readable.ok} />
                  <AboutButton open={side} onToggle={toggleSide} />
                </>
              ) : undefined
            }
          />
        </div>

        {startDialog && startHere(true)}

        <div className="u-float-scrim" onClick={side !== null ? leavePanel : closeLeft} role="presentation" />

        <aside className="u-side" aria-hidden={side === null} ref={sideRef}>

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
              onContent={doc.setContent}
              onApplyServer={doc.applyServer}
              onLeave={leavePanel}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
