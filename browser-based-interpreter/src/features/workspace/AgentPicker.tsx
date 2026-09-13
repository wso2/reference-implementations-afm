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

import { useEffect, useState } from "react";
import { useAgentsLibrary, useHistory } from "../../app/contexts";
import { type AgentOrigin, type HistoryEntry, type SavedAgent } from "../../core/storage/stores";
import { Icon } from "../../ui/Icon";
import { NameMark } from "../../ui/Marks";
import { shortAgo } from "../../ui/time";

interface Props {
  currentId: string | null;
  onPick: (agent: SavedAgent) => void;
  onNew: () => void;
  onRemoved: (agent: SavedAgent) => void;
}

export function AgentPicker({ currentId, onPick, onNew, onRemoved }: Props) {
  const library = useAgentsLibrary();
  const history = useHistory();
  const [undo, setUndo] = useState<{ agent: SavedAgent; conversations: HistoryEntry[] } | null>(null);
  const [query, setQuery] = useState("");

  const shown = library.agents.filter((agent) =>
    query.trim() === "" ? true : agent.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const now = Date.now();

  return (
    <>
      <div className="u-panel-body u-agents">
        <label className="u-agent-search">
          <Icon>
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </Icon>
          <input
            className="u-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search agents"
            aria-label="Search your agents"
          />
        </label>
        <button className="u-agent-new" onClick={onNew}>
          <span className="u-agent-plus" aria-hidden="true">
            <Icon path="M12 5v14M5 12h14" />
          </span>
          New agent
        </button>
        {shown.length === 0 ? (
          <div className="u-empty">
            <span className="u-empty-ico" aria-hidden="true">
              <Icon weight={1.7} path="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6" />
            </span>
            <h4>{library.agents.length === 0 ? "No agents yet" : "Nothing matches"}</h4>
            <p>
              {library.agents.length === 0
                ? "The one you are building is saved as you write it, and appears here."
                : "Try a different word."}
            </p>
          </div>
        ) : (
          <div className="u-agent-list">
            {agentSections(shown).map((group) => (
              <section className="u-agent-group" key={group.label}>
                <span className="u-label">{group.label}</span>
                {group.agents.map((agent) => (
                  <div className={`u-agent ${agent.id === currentId ? "on" : ""}`} key={agent.id}>
                    <button className="u-row-pick" onClick={() => onPick(agent)} title={agent.name}>
                      <NameMark name={agent.name} fallback="A" />
                      <span className="u-agent-name">{agent.name}</span>
                    </button>
                    <span className="u-agent-end">
                      {agent.id === currentId ? (
                        <span className="u-agent-open">
                          <span className="u-dot" aria-hidden="true" />
                          Open
                        </span>
                      ) : (
                        <span className="u-agent-ago">{shortAgo(agent.updatedAt, now)}</span>
                      )}
                      <button
                        className="u-ico u-agent-del"
                        aria-label={`Delete ${agent.name}`}
                        data-tip="Delete this agent"
                        onClick={() => {
                          const conversations = history.entries.filter((entry) => entry.agentId === agent.id);
                          history.removeForAgent(agent.id);
                          library.remove(agent.id);
                          setUndo({ agent, conversations });
                          onRemoved(agent);
                        }}
                      >
                        <Icon weight={1.75} path="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6" />
                      </button>
                    </span>
                  </div>
                ))}
              </section>
            ))}
          </div>
        )}
      </div>

      {undo !== null && (
        <UndoToast
          message={`Deleted ${undo.agent.name}`}
          onAction={() => {
            library.save({
              id: undo.agent.id,
              name: undo.agent.name,
              description: undo.agent.description,
              source: undo.agent.source,
              origin: undo.agent.origin,
              confirmedTools: undo.agent.confirmedTools,
            });
            if (undo.conversations.length > 0) history.restore(undo.conversations);
            setUndo(null);
          }}
          onDismiss={() => setUndo(null)}
        />
      )}
    </>
  );
}

export function agentSections<T extends { origin: AgentOrigin }>(
  agents: T[],
): { label: "Your agents" | "Shared agents"; agents: T[] }[] {
  return [
    { label: "Your agents" as const, agents: agents.filter((agent) => agent.origin !== "import") },
    { label: "Shared agents" as const, agents: agents.filter((agent) => agent.origin === "import") },
  ].filter((group) => group.agents.length > 0);
}

interface UndoToastProps {
  message: string;
  actionLabel?: string;
  onAction: () => void;
  onDismiss: () => void;
  ms?: number;
}

function UndoToast({ message, actionLabel = "Undo", onAction, onDismiss, ms = 7000 }: UndoToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, ms);
    return () => window.clearTimeout(timer);
  }, [onDismiss, ms]);

  return (
    <div className="u-toast" role="status">
      <span>{message}</span>
      <button onClick={onAction}>{actionLabel}</button>
    </div>
  );
}
