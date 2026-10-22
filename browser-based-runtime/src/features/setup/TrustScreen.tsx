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

import { type AgentMetadata, referencedSecretNames } from "@afm/engine";
import { type ReactNode, useState } from "react";
import { findProvider, shortModelLabel } from "../../core/agent/catalogs";
import { hostOf } from "../../core/links/load-paths";
import { listedToolKey } from "../../core/runtime/protocol";
import { displayName } from "../../core/setup/setup-check";
import { DialogFrame } from "../../ui/DialogFrame";
import { Icon } from "../../ui/Icon";

interface Props {
  metadata: AgentMetadata;
  source: string;
  savedSecrets: string[];
  fileUrl: string | null;
  onRun: (confirmed: string[]) => void;
  onOpenBuilder: (confirmed: string[]) => void;
  canRun?: boolean;
  initialStep?: Choice | null;
}

type Choice = "run" | "builder";

interface ServerTools {
  name: string;
  url: string | null;
  host: string | null;
  tools: string[];
}

export const TRUST_COPY = {
  lead: "This agent comes from outside your library. Here is what the file sets up, before it runs.",
  footer: "Nothing runs until you press Run.",
  toolsNote: "Before it starts, you choose which of these tools may run without asking.",
  noListNote: "Every tool asks first, unless you allow it in this tab.",
  keysNote: "A key you enter stays in memory for this tab and is gone when you close or refresh it.",
  stepTitle: "Choose the tools that may run without asking",
  stepSub: "Tick the tools you trust to run on their own. Every other tool asks first, every time.",
  unlisted: "No tool list in the file. Every tool this server offers asks first.",
};

const SEARCH_FROM = 12;

const ICONS = {
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  model: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
  tools:
    "M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z",
  key: "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.78 7.78 5.5 5.5 0 017.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4",
  link: "M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71",
  search: "M21 21l-4.3-4.3M11 18a7 7 0 100-14 7 7 0 000 14z",
};

export function serverTools(metadata: AgentMetadata): ServerTools[] {
  return (metadata.tools?.mcp ?? []).map((server) => ({
    name: server.name,
    url: server.transport.type === "http" ? server.transport.url : null,
    host: server.transport.type === "http" ? hostOf(server.transport.url) : null,
    tools: server.tool_filter?.allow ?? [],
  }));
}

export function isListed(server: ServerTools): boolean {
  return server.url !== null && server.tools.length > 0;
}

export function countLine(ticked: number, listed: number): string {
  return ticked === 0
    ? `None run without asking · all ${listed} ask first`
    : `${ticked} of ${listed} run without asking`;
}

export function linkedFileHost(fileUrl: string | null): string | null {
  try {
    const url = new URL(fileUrl ?? "");
    return url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

export function filterTools(tools: string[], query: string): string[] {
  const wanted = query.trim().toLowerCase();
  return wanted === "" ? tools : tools.filter((tool) => tool.toLowerCase().includes(wanted));
}

export function toolCount(count: number): string {
  return count === 1 ? "1 tool" : `${count} tools`;
}

export function withTicks(current: ReadonlySet<string>, keys: string[], on: boolean): Set<string> {
  const next = new Set(current);
  for (const key of keys) {
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

function Row({ icon, label, children }: { icon: string; label: string; children: ReactNode }) {
  return (
    <div className="u-tr-row">
      <span className="u-tr-i">
        <Icon path={icon} size={16} />
      </span>
      <div className="u-tr-b">
        <span className="u-tr-k">{label}</span>
        {children}
      </div>
    </div>
  );
}

interface ToolStepProps {
  servers: ServerTools[];
  ticked: ReadonlySet<string>;
  onTick: (keys: string[], on: boolean) => void;
  onBack: () => void;
  actions: ReactNode;
}

export function ToolStep({ servers, ticked, onTick: setTick, onBack: back, actions }: ToolStepProps) {
  const [query, setQuery] = useState("");
  const listedServers = servers.filter(isListed);
  const listedCount = listedServers.reduce((sum, server) => sum + server.tools.length, 0);
  const keyOf = (server: ServerTools, tool: string) => listedToolKey(server.url ?? "", tool);
  const tickedOn = (server: ServerTools) => server.tools.filter((tool) => ticked.has(keyOf(server, tool))).length;
  const total = listedServers.reduce((sum, server) => sum + tickedOn(server), 0);
  const visible = listedServers.map((server) => ({ server, shown: filterTools(server.tools, query) }));
  return (
    <DialogFrame
      title={TRUST_COPY.stepTitle}
      subtitle={TRUST_COPY.stepSub}
      footer={
        <span className="u-tr-count">
          <i className={total > 0 ? "on" : undefined} />
          {countLine(total, listedCount)}
        </span>
      }
      icon={<Icon path={ICONS.tools} size={17} />}
      actions={actions}
      tall
      sheet
      focusKey="tools"
      onBack={back}
      onEscape={back}
    >
      {listedCount > SEARCH_FROM && (
        <label className="u-tr-search">
          <Icon path={ICONS.search} size={15} />
          <input
            className="u-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${listedCount} tools`}
            aria-label="Search tools"
          />
        </label>
      )}
      {visible.every(({ shown }) => shown.length === 0) && (
        <div className="u-tr-empty">
          <b>No tools match “{query.trim()}”</b>
          <button className="u-linkish" onClick={() => setQuery("")}>
            Clear search
          </button>
        </div>
      )}
      {servers.map((server) => {
        if (!isListed(server)) {
          return (
            <div className="u-tr-sec u-tr-none" key={server.name}>
              <div className="u-tr-sec-h">
                <span className="u-tr-sec-t">
                  {displayName(server.name)}
                  {server.host !== null && <small>{server.host}</small>}
                </span>
              </div>
              <p>{TRUST_COPY.unlisted}</p>
            </div>
          );
        }
        const shown = filterTools(server.tools, query);
        if (shown.length === 0) return null;
        const shownKeys = shown.map((tool) => keyOf(server, tool));
        return (
          <div className="u-tr-sec" key={server.name}>
            <div className="u-tr-sec-h">
              <span className="u-tr-sec-t">
                {displayName(server.name)}
                {server.host !== null && <small>{server.host}</small>}
              </span>
              <span className="u-tr-meta">
                {tickedOn(server)} of {server.tools.length}
              </span>
              <span className="u-tr-sec-b">
                <button
                  className="u-btn ghost"
                  onClick={() => setTick(shownKeys, true)}
                  disabled={shownKeys.every((name) => ticked.has(name))}
                >
                  Select all
                </button>
                <button
                  className="u-btn ghost"
                  onClick={() => setTick(shownKeys, false)}
                  disabled={shownKeys.every((name) => !ticked.has(name))}
                >
                  Unselect all
                </button>
              </span>
            </div>
            <div className="u-tr-names">
              {shown.map((tool) => (
                <label key={tool} className={ticked.has(keyOf(server, tool)) ? "u-tr-name on" : "u-tr-name"}>
                  <input
                    type="checkbox"
                    checked={ticked.has(keyOf(server, tool))}
                    onChange={(event) => setTick([keyOf(server, tool)], event.target.checked)}
                  />
                  <span>{tool}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </DialogFrame>
  );
}

export function TrustScreen({
  metadata,
  source,
  savedSecrets,
  fileUrl,
  onRun,
  onOpenBuilder,
  initialStep = null,
  canRun = true,
}: Props) {
  const [step, setStep] = useState<Choice | null>(initialStep);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const keys = referencedSecretNames(source);
  const servers = serverTools(metadata);
  const listedServers = servers.filter(isListed);
  const fileHost = linkedFileHost(fileUrl);
  const setTick = (names: string[], on: boolean) => setTicked((current) => withTicks(current, names, on));
  const finish = (choice: Choice) => (choice === "run" ? onRun : onOpenBuilder)([...ticked]);
  const choose = (choice: Choice) => {
    if (listedServers.length === 0) {
      finish(choice);
      return;
    }
    setStep(choice);
  };

  if (step !== null && listedServers.length > 0) {
    const back = () => setStep(null);
    return (
      <ToolStep
        servers={servers}
        ticked={ticked}
        onTick={setTick}
        onBack={back}
        actions={
          step === "run" ? (
            <button className="u-btn primary" onClick={() => finish("run")} disabled={!canRun}>
              Run
            </button>
          ) : (
            <button className="u-btn primary" onClick={() => finish("builder")}>
              Open in builder
            </button>
          )
        }
      />
    );
  }

  return (
    <DialogFrame
      title={metadata.name ?? "Untitled agent"}
      subtitle={TRUST_COPY.lead}
      footer={TRUST_COPY.footer}
      icon={<Icon path={ICONS.shield} size={17} />}
      actions={
        <>
          <button className="u-btn ghost" onClick={() => choose("builder")}>
            Open in builder
          </button>
          <button className="u-btn primary" onClick={() => choose("run")} disabled={!canRun}>
            Run
          </button>
        </>
      }
      sheet
      focusKey="summary"
      onEscape={() => {}}
    >
      <div className="u-tr-list">
        {fileHost !== null && (
          <Row icon={ICONS.link} label="File from">
            <span className="u-tr-v">{fileHost}</span>
          </Row>
        )}
        <Row icon={ICONS.model} label="Model">
          <span className="u-tr-v">
            {shortModelLabel(metadata.model?.name ?? "-")}
            {metadata.model?.provider !== undefined && (
              <small> · {findProvider(metadata.model.provider)?.label ?? metadata.model.provider}</small>
            )}
          </span>
        </Row>
        <Row icon={ICONS.tools} label="Tool servers">
          {servers.length === 0 ? (
            <span className="u-tr-v">None</span>
          ) : (
            <>
              {servers.map((server) => (
                <div className="u-tr-srv" key={server.name}>
                  <span className="u-tr-v">
                    {displayName(server.name)}
                    {server.host !== null && <small> · {server.host}</small>}
                  </span>
                  <span className="u-tr-meta">
                    {isListed(server) ? toolCount(server.tools.length) : "No tools listed"}
                  </span>
                </div>
              ))}
              <span className="u-tr-note">
                {listedServers.length > 0 ? TRUST_COPY.toolsNote : TRUST_COPY.noListNote}
              </span>
            </>
          )}
        </Row>
        <Row icon={ICONS.key} label="Needs from you">
          {keys.length === 0 ? (
            <span className="u-tr-v">Nothing</span>
          ) : (
            <>
              {keys.map((name) => (
                <div className="u-tr-srv" key={name}>
                  <span className="u-tr-v">
                    <code>{name}</code>
                  </span>
                  <span className={`tag ${savedSecrets.includes(name) ? "ok" : ""}`}>
                    {savedSecrets.includes(name) ? "Entered" : "Not entered"}
                  </span>
                </div>
              ))}
              <span className="u-tr-note">{TRUST_COPY.keysNote}</span>
            </>
          )}
        </Row>
      </div>
    </DialogFrame>
  );
}
