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

import { type buildableAgent } from "../../core/agent/agent-validation";
import { MODEL_ROW, serverRowId, type SetupRow } from "../../core/setup/setup-check";
import { type SavedAgent } from "../../core/storage/stores";
import { SidePane } from "../../ui/SideWindow";
import { type useStandaloneSession } from "../../worker-client/useStandaloneSession";
import { ModelPanel } from "../model/ModelPanel";
import { SetupPane } from "../setup/SetupPane";
import { type useSetup } from "../setup/useSetup";
import { InfoPanel } from "../share/InfoPanel";
import { SettingsPanel } from "../share/SettingsPanel";
import { SharePanel } from "../share/SharePanel";
import { ServerPanel } from "../tools/ServerPanel";
import { type SidePanel, sideTitle } from "./workspace-view";

const FLUSH: SidePanel[] = ["model", "tools", "info", "share", "setup"];

interface Props {
  panel: Exclude<SidePanel, "chat">;
  content: string;
  readable: ReturnType<typeof buildableAgent>;
  session: ReturnType<typeof useStandaloneSession>;
  setup: ReturnType<typeof useSetup>;
  savedAgent: SavedAgent | undefined;
  serverEditing: string | null;
  backToSetup: boolean;
  approved: string[] | null;
  onContent: (next: string) => void;
  onApplyServer: (next: string) => void;
  onApproveTools: (serverUrl: string, tools: string[]) => void;
  onServerDropped: (serverUrl: string) => void;
  onConfigure: (row: SetupRow) => void;
  onRun: () => void;
  onLeave: () => void;
}

export function OverPanel(props: Props) {
  const { panel, content, readable, session, setup, savedAgent, serverEditing, backToSetup, onLeave } = props;
  const metadata = readable.ok ? readable.metadata : null;
  return (
    <SidePane key={panel} over title={sideTitle(panel, serverEditing)} onClose={onLeave} flush={FLUSH.includes(panel)}>
      {panel === "share" && <SharePanel agentSource={content} />}
      {panel === "settings" && <SettingsPanel session={session} />}
      {panel === "info" && (
        <InfoPanel
          content={content}
          metadata={metadata}
          saved={savedAgent}
          onApply={props.onContent}
          onClose={onLeave}
        />
      )}
      {panel === "setup" && (
        <SetupPane
          rows={setup.rows}
          provider={metadata?.model?.provider ?? ""}
          ready={setup.ready}
          onConfigure={props.onConfigure}
          onCheckAgain={setup.recheck}
          onRun={props.onRun}
        />
      )}
      {panel === "model" && (
        <ModelPanel
          content={content}
          savedSecrets={session.state.savedSecrets}
          issue={setup.issueOf(MODEL_ROW)}
          onApply={(next) => {
            props.onContent(next);
            setup.changed(MODEL_ROW);
          }}
          onSaveKey={session.storeSecret}
          onBack={backToSetup ? onLeave : undefined}
          onClose={onLeave}
        />
      )}
      {panel === "tools" && metadata !== null && (
        <ServerPanel
          key={serverEditing ?? "new"}
          content={content}
          editing={serverEditing}
          metadata={metadata}
          onApply={(next) => {
            props.onApplyServer(next);
            if (serverEditing !== null) setup.changed(serverRowId(serverEditing));
          }}
          fromSomeoneElse={props.approved !== null}
          approved={props.approved ?? []}
          onApprove={props.onApproveTools}
          onServerDropped={props.onServerDropped}
          onStoreSecret={session.storeSecret}
          knownSecrets={session.state.savedSecrets}
          issue={serverEditing === null ? null : setup.issueOf(serverRowId(serverEditing))}
          onProbe={session.probeServer}
          onSignIn={session.startOAuthSignIn}
          onSignOut={session.signOutOAuth}
          onBack={backToSetup ? onLeave : undefined}
          onClose={onLeave}
        />
      )}
    </SidePane>
  );
}
