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

import type { McpServer } from "../../core/agent/browser-agent";
import { plural } from "../../core/plural";
import { type AgentMetadata } from "@afm/engine";
import { type ReactNode, useMemo, useState } from "react";
import { getSection, setSection } from "../../core/agent/agent-source-edit";
import { findProvider, shortModelLabel } from "../../core/agent/catalogs";
import { type ActivityPhase, type AgentActivity } from "../../core/chat/agent-activity";
import { displayName } from "../../core/setup/setup-check";
import { Icon } from "../../ui/Icon";
import { NameMark, ProviderBadge } from "../../ui/Marks";
import { FocusEditor } from "./FocusEditor";
import { RichText } from "./RichText";
import { isInteractiveOAuth } from "../../core/oauth/session";

type BriefName = "Role" | "Instructions";

interface Props {
  content: string;
  onChange: (content: string) => void;
  metadata: AgentMetadata | null;
  onOpenModel: () => void;
  onOpenServer: (name: string | null) => void;
  activity: AgentActivity;
  reach: ServerReach;
  openPanel?: OpenPanel;
}

export interface OpenPanel {
  model: boolean;
  server: string | null;
  adding: boolean;
}

export interface ServerReach {
  ok: string[];
  failed: Record<string, string>;
}

const PLACEHOLDER: Record<BriefName, string> = {
  Role: "e.g. You are a support agent for a coffee roastery.",
  Instructions: "e.g. Answer in two sentences. Ask one question if the request is unclear.",
};

function urlOf(server: McpServer): string | undefined {
  return server.transport.type === "http" ? server.transport.url : undefined;
}

function lead(out: boolean, back: boolean, broken: boolean): string {
  return `u-lead${out ? " live is-flowing" : ""}${back ? " live is-returning" : ""}${broken ? " broken" : ""}`;
}

function serverSummary(server: McpServer): { tools: string; state: "ready" | "sign-in" } {
  const allowed = server.tool_filter?.allow?.length;
  const auth = server.transport.type === "http" ? server.transport.authentication : undefined;
  return {
    tools: allowed === undefined ? "All tools" : plural(allowed, "tool"),
    state: isInteractiveOAuth(auth) ? "sign-in" : "ready",
  };
}

type Heard = { kind: "ok" | "unknown" } | { kind: "failed"; reason: string };

function heardFrom(url: string | undefined, reach: ServerReach): Heard {
  if (url === undefined) return { kind: "unknown" };
  const reason = Object.hasOwn(reach.failed, url) ? reach.failed[url] : undefined;
  if (reason !== undefined) return { kind: "failed", reason };
  return { kind: reach.ok.includes(url) ? "ok" : "unknown" };
}

function nodeTone(state: "ready" | "sign-in", heard: Heard["kind"]): string {
  if (heard === "failed") return "bad";
  if (state === "sign-in") return "";
  return heard === "ok" ? "ok" : "";
}

function ExpandButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="u-ico tiny"
      onClick={onClick}
      data-tip="Write in a bigger window"
      aria-label="Write in a bigger window"
    >
      <Icon weight={2}>
        <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
      </Icon>
    </button>
  );
}

function PlusMark({ size }: { size: number }) {
  return <Icon size={size} weight={2.4} path="M12 5v14M5 12h14" />;
}

function LockedNode({ name }: { name: string }) {
  return (
    <button className="u-node is-locked" disabled>
      <span className="u-node-lock" aria-hidden="true">
        <Icon size={13} path="M7 11V8a5 5 0 0110 0v3M5 11h14v10H5z" />
      </span>
      <span className="u-node-body">
        <span className="u-node-name">{name}</span>
        <span className="u-node-sub">Locked</span>
      </span>
    </button>
  );
}

interface BriefFieldProps {
  name: BriefName;
  hint: string;
  icon: ReactNode;
  grow?: boolean;
  textClass: string;
  value: string;
  onChange: (text: string) => void;
  onExpand: () => void;
}

function BriefField({ name, hint, icon, grow = false, textClass, value, onChange, onExpand }: BriefFieldProps) {
  return (
    <div className={grow ? "u-field grow" : "u-field"}>
      <div className="u-field-head">
        <span className="u-field-ico">{icon}</span>
        <span className="u-field-name">{name}</span>
        <span className="u-field-hint">{hint}</span>
        <span className="u-field-tools">
          <ExpandButton onClick={onExpand} />
        </span>
      </div>
      <RichText
        className={textClass}
        value={value}
        placeholder={PLACEHOLDER[name]}
        ariaLabel={name}
        rewindOnBlur
        onChange={onChange}
      />
    </div>
  );
}

interface ModelNodeProps {
  metadata: AgentMetadata | null;
  activity: AgentActivity;
  isOpen: boolean;
  onOpen: () => void;
}

function ModelNode({ metadata, activity, isOpen, onOpen }: ModelNodeProps) {
  if (metadata === null) return <LockedNode name="Model" />;
  const modelName = metadata.model?.name ?? "";
  if (modelName === "") {
    return (
      <button className={`u-node add${isOpen ? " is-open" : ""}`} onClick={onOpen}>
        <PlusMark size={13} />
        Choose a model
      </button>
    );
  }
  const provider = metadata.model?.provider ?? "";
  const live = activity.phase === "thinking" || activity.phase === "answering";
  return (
    <button
      className={`u-node ${live ? "live" : ""} ${activity.modelBroken ? "bad" : ""} ${isOpen ? "is-open" : ""}`}
      onClick={onOpen}
      title={activity.modelBroken ? `${modelName} - this call did not come back` : modelName}
    >
      <ProviderBadge provider={provider} />
      <span className="u-node-body">
        <span className="u-node-name">{shortModelLabel(modelName)}</span>
        <span className="u-node-sub">{findProvider(provider)?.label ?? provider}</span>
      </span>
    </button>
  );
}

interface ServerRowProps {
  server: McpServer;
  activity: AgentActivity;
  reach: ServerReach;
  isOpen: boolean;
  onOpen: () => void;
}

function ServerRow({ server, activity, reach, isOpen, onOpen }: ServerRowProps) {
  const url = urlOf(server);
  const on = (at: ActivityPhase) =>
    activity.phase === at && activity.serverId !== undefined && url === activity.serverId;
  const broken = url !== undefined && activity.brokenServerIds.includes(url) && !on("tool");
  const summary = serverSummary(server);
  const heard = heardFrom(url, reach);
  return (
    <div className="u-rail-row">
      <span className={lead(on("tool"), on("from-tool"), broken)} />
      <button
        className={`u-node ${nodeTone(summary.state, heard.kind)} ${on("tool") ? "live" : ""} ${isOpen ? "is-open" : ""}`}
        onClick={onOpen}
      >
        <NameMark name={server.name} />
        <span className="u-node-body">
          <span className="u-node-name">{displayName(server.name)}</span>
          <span className={`u-node-sub ${heard.kind === "failed" || broken ? "bad" : ""}`}>
            {heard.kind === "failed" ? heard.reason : broken ? "No answer" : summary.tools}
          </span>
        </span>
      </button>
    </div>
  );
}

export function BuildPane({
  content,
  onChange,
  metadata,
  onOpenModel,
  onOpenServer,
  activity,
  reach,
  openPanel,
}: Props) {
  const [focus, setFocus] = useState<BriefName | null>(null);
  const { phase } = activity;
  const locked = metadata === null;
  const servers = metadata?.tools?.mcp ?? [];
  const agentLive = phase === "incoming" || phase === "from-model" || phase === "from-tool";

  const role = useMemo(() => getSection(content, "Role"), [content]);
  const instructions = useMemo(() => getSection(content, "Instructions"), [content]);
  const write = (heading: string) => (text: string) => onChange(setSection(content, heading, text));

  return (
    <div className="u-flow">
      <div className="u-flow-mid">
        <div className={`u-brief ${agentLive ? "live" : ""}`}>
          <BriefField
            name="Role"
            hint="who the agent is"
            icon={
              <Icon>
                <circle cx="12" cy="8" r="5" />
                <path d="M20 21a8 8 0 0 0-16 0" />
              </Icon>
            }
            textClass="u-field-text u-role"
            value={role}
            onChange={write("Role")}
            onExpand={() => setFocus("Role")}
          />
          <BriefField
            name="Instructions"
            hint="how it should behave"
            icon={<Icon weight={1.9} path="M4 6h16M4 12h16M4 18h11" />}
            grow
            textClass="u-field-text"
            value={instructions}
            onChange={write("Instructions")}
            onExpand={() => setFocus("Instructions")}
          />
        </div>
      </div>

      <div className="u-rail">
        <div className="u-rail-group">
          <div className="u-rail-label">MODEL</div>
          <div className="u-rail-row">
            <span
              className={lead(
                phase === "thinking",
                phase === "from-model" || phase === "answering",
                activity.modelBroken,
              )}
            />
            <ModelNode
              metadata={metadata}
              activity={activity}
              isOpen={openPanel?.model === true}
              onOpen={onOpenModel}
            />
          </div>
        </div>

        <div className="u-rail-gap" />
        <div className={`u-rail-group${servers.length > 1 ? " is-list" : ""}`}>
          <div className="u-rail-label">
            TOOLS
            {servers.length > 0 && (
              <button
                className={`u-node-add-sm${openPanel?.adding === true ? " is-open" : ""}`}
                onClick={() => onOpenServer(null)}
                data-tip="Connect tools"
                aria-label="Connect tools"
              >
                <Icon weight={2.6} path="M12 5v14M5 12h14" />
              </button>
            )}
          </div>

          {servers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              activity={activity}
              reach={reach}
              isOpen={openPanel?.server === server.name}
              onOpen={() => onOpenServer(server.name)}
            />
          ))}

          {servers.length === 0 && (
            <div className="u-rail-row">
              <span className="u-lead" />
              {locked ? (
                <LockedNode name="Connect tools" />
              ) : (
                <button
                  className={`u-node add${openPanel?.adding === true ? " is-open" : ""}`}
                  onClick={() => onOpenServer(null)}
                >
                  <PlusMark size={13} />
                  Connect tools
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {focus !== null && (
        <FocusEditor
          title={focus}
          hint={focus === "Role" ? "who this agent is" : "how it should behave"}
          value={focus === "Role" ? role : instructions}
          placeholder={PLACEHOLDER[focus]}
          onChange={write(focus)}
          onClose={() => setFocus(null)}
        />
      )}
    </div>
  );
}
