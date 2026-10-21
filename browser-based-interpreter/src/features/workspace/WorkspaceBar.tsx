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

import type { ReactNode } from "react";
import type { SidePanel } from "./workspace-view";
import { Icon } from "../../ui/Icon";

interface Props {
  agentName: string;
  saveFailed: boolean;
  canAct: boolean;
  open: SidePanel | null;
  onToggle: (panel: SidePanel) => void;
  agentsOpen: boolean;
  onToggleAgents: () => void;
  onToggleTheme: () => void;
  dark: boolean;
  compact?: boolean;
}

function BarButton({
  children,
  label,
  on = false,
  onClick,
  blocked,
}: {
  children: ReactNode;
  label: string;
  on?: boolean;
  onClick: () => void;
  blocked?: string;
}) {
  return (
    <button
      className={`u-ico ${on ? "on" : ""}${blocked === undefined ? "" : " is-blocked"}`}
      data-tip={blocked ?? label}
      aria-label={label}
      aria-disabled={blocked === undefined ? undefined : true}
      onClick={() => {
        if (blocked === undefined) onClick();
      }}
    >
      <Icon>{children}</Icon>
    </button>
  );
}

interface ToolProps {
  open: SidePanel | null;
  onToggle: (panel: SidePanel) => void;
}

export function ShareButton({ open, onToggle, canAct }: ToolProps & { canAct: boolean }) {
  return (
    <BarButton
      label="Share this agent"
      on={open === "share"}
      blocked={canAct ? undefined : "Build the agent before sharing"}
      onClick={() => onToggle("share")}
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </BarButton>
  );
}

export function AboutButton({ open, onToggle }: ToolProps) {
  return (
    <BarButton label="About this agent" on={open === "info"} onClick={() => onToggle("info")}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </BarButton>
  );
}

export function WorkspaceBar({
  agentName,
  saveFailed,
  canAct,
  open,
  onToggle,
  agentsOpen,
  onToggleAgents,
  onToggleTheme,
  dark,
  compact = false,
}: Props) {
  return (
    <div className="u-bar">
      <span className="u-brand">AFM</span>
      <span className="u-sep" aria-hidden="true" />
      <button className="u-agentname" onClick={onToggleAgents} aria-expanded={agentsOpen} title={agentName}>
        <span className="u-agentname-text">{agentName}</span> <span className="u-caret" aria-hidden="true" />
      </button>
      {saveFailed && (
        <span className="u-saved is-failed" role="status">
          Couldn’t save
        </span>
      )}

      <span className="u-bar-right">
        {!compact && <ShareButton open={open} onToggle={onToggle} canAct={canAct} />}
        {!compact && <AboutButton open={open} onToggle={onToggle} />}
        {!compact && (
          <BarButton label={dark ? "Switch to light" : "Switch to dark"} onClick={onToggleTheme}>
            {dark ? (
              <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
              </>
            ) : (
              <path d="M20.5 14.5A8.5 8.5 0 019.5 3.5a8.5 8.5 0 1011 11z" />
            )}
          </BarButton>
        )}
      </span>
    </div>
  );
}
