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
import { type ReactNode, useState } from "react";
import { findProvider, shortModelLabel } from "../../core/agent/catalogs";
import { hostOf, httpsUrl } from "../../core/agent/addresses";
import { plural } from "../../core/plural";
import { listedToolKey, toolsOfServer } from "../../core/tools/trust";
import { displayName } from "../../core/setup/setup-check";
import { DialogFrame } from "../../ui/DialogFrame";
import { Icon } from "../../ui/Icon";
import { referencedSecretNames } from "../../core/agent/secret-usage";

interface Props {
  metadata: AgentMetadata;
  source: string;
  savedSecrets: string[];
  fileUrl: string | null;
  onRun: (confirmed: string[]) => void;
  onOpenBuilder: (confirmed: string[]) => void;
  canRun?: boolean;
  initialPermissions?: boolean;
}

interface ServerTools {
  name: string;
  url: string | null;
  host: string | null;
  tools: string[];
}

export const TRUST_COPY = {
  lead: "This agent comes from outside your library. Here is what the file sets up, before it runs.",
  footer: "Nothing runs until you press Run.",
  toolsNote: "Every tool asks first, unless you select it in Permissions.",
  noListNote: "Every tool asks first. You can choose Always allow when it asks.",
  keysNote: "A key you enter stays in memory for this tab and is gone when you close or refresh it.",
  permissions: "Permissions",
  permissionsSub: "Select the tools you trust to run on their own. Every other tool asks first, every time.",
  unlisted: "No tool list in the file. Every tool this server offers asks first.",
  noServers: "This agent has no tool servers yet.",
  stepsNote: "The agent can call the model this many times for one message, using your key each time. Stop ends it early.",
};

const SEARCH_FROM = 12;
const DEFAULT_STEPS = 10;

const ICONS = {
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  model: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
  tools:
    "M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z",
  key: "M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.78 7.78 5.5 5.5 0 017.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4",
  link: "M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71",
  steps: "M17 1l4 4-4 4M3 11V9a4 4 0 014-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 01-4 4H3",
  search: "M21 21l-4.3-4.3M11 18a7 7 0 100-14 7 7 0 000 14z",
};

export function serverTools(metadata: AgentMetadata, trusted: readonly string[] = []): ServerTools[] {
  return (metadata.tools?.mcp ?? []).map((server) => {
    const url = server.transport.type === "http" ? server.transport.url : null;
    const listed = server.tool_filter?.allow ?? [];
    return {
      name: server.name,
      url,
      host: url === null ? null : hostOf(url),
      tools: url === null || listed.length > 0 ? listed : [...new Set(toolsOfServer(trusted, url, server.name))],
    };
  });
}

export function isListed(server: ServerTools): boolean {
  return server.url !== null && server.tools.length > 0;
}

export function countLine(ticked: number, listed: number): string {
  return ticked === 0
    ? `None run without asking · all ${listed} ask first`
    : `${ticked} of ${listed} run without asking`;
}

// The host and the path, so two files on one host can be told apart. The query and the part after # are left out.
export function linkedFileAddress(fileUrl: string | null): string | null {
  const address = httpsUrl(fileUrl ?? "");
  if (address === null) return null;
  return address.pathname === "/" ? address.host : `${address.host}${address.pathname}`;
}

export function stepLimitAboveDefault(metadata: AgentMetadata): number | null {
  const limit = metadata.max_iterations;
  return limit !== undefined && limit > DEFAULT_STEPS ? limit : null;
}

export function filterTools(tools: string[], query: string): string[] {
  const wanted = query.trim().toLowerCase();
  return wanted === "" ? tools : tools.filter((tool) => tool.toLowerCase().includes(wanted));
}

export function withTicks(current: ReadonlySet<string>, keys: string[], on: boolean): Set<string> {
  const next = new Set(current);
  for (const key of keys) {
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

interface RowProps {
  icon: string;
  label: string;
  action?: ReactNode;
  children: ReactNode;
}

function Row({ icon, label, action, children }: RowProps) {
  return (
    <div className="u-tr-row">
      <span className="u-tr-i">
        <Icon path={icon} size={16} />
      </span>
      <div className="u-tr-b">
        {action === undefined ? (
          <span className="u-tr-k">{label}</span>
        ) : (
          <div className="u-tr-head">
            <span className="u-tr-k">{label}</span>
            {action}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

interface PermissionsWindowProps {
  servers: ServerTools[];
  ticked: ReadonlySet<string>;
  onTick: (keys: string[], on: boolean) => void;
  onClose: () => void;
}

export function PermissionsWindow({ servers, ticked, onTick: setTick, onClose: close }: PermissionsWindowProps) {
  const [query, setQuery] = useState("");
  const listedServers = servers.filter(isListed);
  const listedCount = listedServers.reduce((sum, server) => sum + server.tools.length, 0);
  const keyOf = (server: ServerTools, tool: string) => listedToolKey(server.url ?? "", tool, server.name);
  const tickedOn = (server: ServerTools) => server.tools.filter((tool) => ticked.has(keyOf(server, tool))).length;
  const total = listedServers.reduce((sum, server) => sum + tickedOn(server), 0);
  const visible = listedServers.map((server) => ({ server, shown: filterTools(server.tools, query) }));
  return (
    <DialogFrame
      title={TRUST_COPY.permissions}
      subtitle={TRUST_COPY.permissionsSub}
      footer={
        <span className="u-tr-count">
          <i className={total > 0 ? "on" : undefined} />
          {countLine(total, listedCount)}
        </span>
      }
      icon={<Icon path={ICONS.shield} size={17} />}
      actions={
        <button className="u-btn primary" onClick={close}>
          Done
        </button>
      }
      tall
      sheet
      focusKey="permissions"
      onClose={close}
      onEscape={close}
      onOutside={close}
    >
      {servers.length === 0 && (
        <div className="u-tr-sec u-tr-none">
          <p>{TRUST_COPY.noServers}</p>
        </div>
      )}
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
  initialPermissions = false,
  canRun = true,
}: Props) {
  const [choosing, setChoosing] = useState(initialPermissions);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const keys = referencedSecretNames(source);
  const servers = serverTools(metadata);
  const listedServers = servers.filter(isListed);
  const listedCount = listedServers.reduce((sum, server) => sum + server.tools.length, 0);
  const fileAddress = linkedFileAddress(fileUrl);
  const stepLimit = stepLimitAboveDefault(metadata);
  const setTick = (names: string[], on: boolean) => setTicked((current) => withTicks(current, names, on));

  if (choosing && listedServers.length > 0) {
    return <PermissionsWindow servers={servers} ticked={ticked} onTick={setTick} onClose={() => setChoosing(false)} />;
  }

  return (
    <DialogFrame
      title={metadata.name ?? "Untitled agent"}
      subtitle={TRUST_COPY.lead}
      footer={TRUST_COPY.footer}
      icon={<Icon path={ICONS.shield} size={17} />}
      actions={
        <>
          <button className="u-btn ghost" onClick={() => onOpenBuilder([...ticked])}>
            Open in builder
          </button>
          <button className="u-btn primary" onClick={() => onRun([...ticked])} disabled={!canRun}>
            Run
          </button>
        </>
      }
      sheet
      focusKey="summary"
      onEscape={() => {}}
    >
      <div className="u-tr-list">
        {fileAddress !== null && (
          <Row icon={ICONS.link} label="File from">
            <span className="u-tr-v">{fileAddress}</span>
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
        {stepLimit !== null && (
          <Row icon={ICONS.steps} label="Steps per reply">
            <span className="u-tr-v">
              {stepLimit.toLocaleString("en-US")} steps<small> · default is {DEFAULT_STEPS}</small>
            </span>
            <span className="u-tr-note">{TRUST_COPY.stepsNote}</span>
          </Row>
        )}
        <Row
          icon={ICONS.tools}
          label="Tool servers"
          action={
            listedServers.length > 0 ? (
              <button className="u-btn ghost sm" onClick={() => setChoosing(true)}>
                <Icon path={ICONS.shield} size={14} />
                {TRUST_COPY.permissions}
              </button>
            ) : undefined
          }
        >
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
                    {isListed(server) ? plural(server.tools.length, "tool") : "No tools listed"}
                  </span>
                </div>
              ))}
              <span className="u-tr-note">
                {listedServers.length === 0 ? (
                  TRUST_COPY.noListNote
                ) : ticked.size === 0 ? (
                  TRUST_COPY.toolsNote
                ) : (
                  <>
                    <b>
                      {ticked.size} of {listedCount}
                    </b>{" "}
                    tools run without asking. The rest ask first.
                  </>
                )}
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
                  {savedSecrets.includes(name) && <span className="u-chip ok">Entered</span>}
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
