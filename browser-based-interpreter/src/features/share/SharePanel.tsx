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
import { useState } from "react";
import { buildableAgent } from "../../core/agent/agent-validation";
import { downloadAgentFile } from "../../core/files/download-agent-file";
import { appAddress } from "../../core/links/app-address";
import { normalizeAgentFileUrl } from "../../core/links/load-paths";
import { buildShareLink, canScanForCredentials, literalCredentialFields, type ShareMethod } from "../../core/links/share";
import { Icon } from "../../ui/Icon";
import { useCopyFeedback } from "../../ui/hooks";

interface Props {
  agentSource: string;
}

const DELIVERY_OPTIONS = [
  { id: "inline", name: "In the link", sub: "Recommended for small agents" },
  { id: "url", name: "Hosted file", sub: "For larger agents you keep updated" },
] as const;

export function shareChecks(metadata: AgentMetadata | null): { label: string; done: boolean }[] {
  const filled = (text: string | undefined) => (text?.trim() ?? "") !== "";
  return [
    { label: "Description", done: filled(metadata?.description) },
    { label: "Icon", done: filled(metadata?.icon_url) },
    { label: "Version", done: filled(metadata?.version) },
    { label: "Authors", done: (metadata?.authors?.length ?? 0) > 0 },
    { label: "Provider", done: filled(metadata?.provider?.name) },
    { label: "License", done: filled(metadata?.license) },
  ];
}

type KeyNoticeKind = "written" | "unchecked" | "hosted" | "clean";

// What to say about keys. The check reads this file only, so a hosted file is never called clean.
export function keyNoticeKind(scanned: boolean, writtenIn: string[], hosted: boolean): KeyNoticeKind {
  if (writtenIn.length > 0) return "written";
  if (!scanned) return "unchecked";
  return hosted ? "hosted" : "clean";
}

function KeyNote({ kind, fields, send }: { kind: KeyNoticeKind; fields: string[]; send: "link" | "file" }) {
  if (kind === "clean") {
    return <p className="u-hint">No key is written into the settings, and keys saved in this app are never included.</p>;
  }
  if (kind === "hosted") {
    return (
      <p className="u-hint">
        The link holds only the address of the file. Make sure that file has no key written into it.
      </p>
    );
  }
  if (kind === "unchecked") {
    return (
      <p className="u-hint u-warn-note">
        This file could not be checked for keys. Read through it before you {send === "link" ? "share the link" : "send it"}.
      </p>
    );
  }
  return send === "link" ? (
    <p className="u-hint u-warn-note">
      This file has a key written into it ({fields.join(", ")}), and anyone with the link can read it. Replace it with a{" "}
      <code>{"${env:NAME}"}</code> reference first.
    </p>
  ) : (
    <p className="u-hint u-warn-note">
      This file has a key written into it ({fields.join(", ")}). Replace it with a <code>{"${env:NAME}"}</code>{" "}
      reference before you send it.
    </p>
  );
}

export function SharePanel({ agentSource }: Props) {
  const [method, setMethod] = useState<ShareMethod>("inline");
  const [fileUrl, setFileUrl] = useState("");
  const [tab, setTab] = useState<"link" | "file">("link");
  const { copied, copy } = useCopyFeedback(1500);

  const address = appAddress(window.location.origin, import.meta.env.BASE_URL);
  const built = buildableAgent(agentSource);
  const checks = shareChecks(built.ok ? built.metadata : null);
  const ready = checks.filter((check) => check.done).length;

  const normalized = fileUrl.trim() === "" ? null : normalizeAgentFileUrl(fileUrl);
  const rawFileUrl = normalized?.ok === true ? normalized.url : null;
  const fileKeys = literalCredentialFields(agentSource);
  const scanned = canScanForCredentials(agentSource);
  const link = buildShareLink(address, method, agentSource, rawFileUrl);

  return (
    <div className="u-panel-body u-share">
      <div className="u-group">
        <div className="u-seg fill">
          {(["link", "file"] as const).map((id) => (
            <button key={id} className={tab === id ? "on" : ""} aria-pressed={tab === id} onClick={() => setTab(id)}>
              {id === "link" ? "Link" : "File"}
            </button>
          ))}
        </div>
      </div>

      <div className="u-group">
        <div className="u-label-row">
          <span className="u-label">Ready to share</span>
          <div className="u-spacer" />
          <span className={`u-chip ${ready === checks.length ? "ok" : "warn"}`}>
            {ready} of {checks.length}
          </span>
        </div>
        <div className="u-todo">
          {checks.map((check) => (
            <span className={`u-todo-item ${check.done ? "on" : ""}`} key={check.label}>
              <Icon weight={3} path={check.done ? "M4 12.5l5 5L20 6.5" : "M6 12h12"} />
              {check.label}
              <span className="visually-hidden">{check.done ? " added" : " not added"}</span>
            </span>
          ))}
        </div>
      </div>

      {tab === "link" ? (
        <>
          <div className="u-group">
            <span className="u-label">Delivery</span>
            <div className="u-seg fill">
              {DELIVERY_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  className={method === option.id ? "on" : ""}
                  aria-pressed={method === option.id}
                  onClick={() => setMethod(option.id)}
                >
                  {option.name}
                </button>
              ))}
            </div>
            <p className="u-hint">{DELIVERY_OPTIONS.find((option) => option.id === method)?.sub}</p>
          </div>

          {method === "url" && (
            <div className="u-group">
              <span className="u-label">Public URL of your .afm.md</span>
              <input
                className="u-input mono"
                aria-label="Public URL of your .afm.md"
                value={fileUrl}
                onChange={(event) => setFileUrl(event.target.value)}
                placeholder="https://…/agent.afm.md"
              />
              {rawFileUrl !== null && rawFileUrl !== fileUrl.trim() && (
                <p className="u-hint">
                  Using the raw file URL: <code>{rawFileUrl}</code>
                </p>
              )}
            </div>
          )}

          <div className="u-group is-last">
            <span className="u-label">Link</span>
            <div className="u-code">{link ?? "Add the file's address above to get a link."}</div>
            <button
              className="u-btn primary wide below"
              disabled={link === null}
              onClick={() => link !== null && copy(link)}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <KeyNote kind={keyNoticeKind(scanned, fileKeys, method === "url")} fields={fileKeys} send="link" />
          </div>
        </>
      ) : (
        <div className="u-group is-last">
          <span className="u-label">Agent file</span>
          <p className="u-hint is-flush is-spaced">
            Everything in one file. Send it, edit it anywhere, or run it in another AFM runtime.
          </p>
          <button className="u-btn primary wide" onClick={() => downloadAgentFile(agentSource)}>
            Download .afm.md
          </button>
          <KeyNote kind={keyNoticeKind(scanned, fileKeys, false)} fields={fileKeys} send="file" />
        </div>
      )}
    </div>
  );
}
