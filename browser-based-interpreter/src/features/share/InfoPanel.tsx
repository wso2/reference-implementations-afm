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
import { useId, useState } from "react";
import {
  ABOUT_FIELDS,
  type AboutField,
  aboutRows,
  applyAbout,
  startingDraft,
  versionError,
} from "../../core/agent/about";
import { type SavedAgent } from "../../core/storage/stores";
import { Icon } from "../../ui/Icon";
import { AgentAvatar, iconUrlError } from "../../ui/Marks";
import { useAutosize } from "../../ui/hooks";
import { whenAgo } from "../../ui/time";
import { LicenseSelect } from "./LicenseSelect";

interface Props {
  content: string;
  metadata: AgentMetadata | null;
  saved: SavedAgent | undefined;
  onApply: (content: string) => void;
  onClose: () => void;
}

const MAX_DESCRIPTION_HEIGHT = 200;

export function InfoPanel({ content, metadata, saved, onApply, onClose }: Props) {
  const [start] = useState(() => startingDraft(metadata));
  const [draft, setDraft] = useState(start);
  const [iconOpen, setIconOpen] = useState(false);
  const [iconText, setIconText] = useState(start.icon);
  const descriptionId = useId();
  const versionErrorId = useId();
  const descriptionRef = useAutosize(draft.description, MAX_DESCRIPTION_HEIGHT);
  const readOnly = metadata === null;
  const edit = (field: AboutField, text: string) => setDraft({ ...draft, [field]: text });
  const versionProblem = draft.version.trim() === start.version ? null : versionError(draft.version);
  const iconProblem = iconText.trim() === "" ? null : iconUrlError(iconText);
  const canUseIcon = iconText.trim() !== "" && iconProblem === null;
  const dirty = ABOUT_FIELDS.some((field) => draft[field].trim() !== start[field]);

  function applyIcon() {
    edit("icon", iconText.trim());
    setIconOpen(false);
  }

  function removeIcon() {
    edit("icon", "");
    setIconText("");
    setIconOpen(false);
  }

  function save() {
    onApply(applyAbout(content, start, draft, metadata?.provider?.url ?? ""));
    onClose();
  }

  return (
    <>
      <div className="u-panel-body">
        <div className="u-group">
          <span className="u-label">About</span>

          <div className="u-info-id">
            <span className="u-info-avatar-wrap">
              <AgentAvatar className="u-info-avatar" name={draft.name} iconUrl={draft.icon} />
              <button
                className="u-info-edit"
                data-tip="Change icon"
                aria-label="Change icon"
                aria-expanded={iconOpen}
                disabled={readOnly}
                onClick={() => setIconOpen(!iconOpen)}
              >
                <Icon weight={2.2} path="M17 3a2.8 2.8 0 114 4L7.5 20.5 2 22l1.5-5.5z" />
              </button>
            </span>
            <div className="u-info-id-fields">
              <input
                className="u-ghost name"
                value={draft.name}
                placeholder="Untitled agent"
                aria-label="Agent name"
                disabled={readOnly}
                onChange={(event) => edit("name", event.target.value)}
              />
            </div>
          </div>

          <div className="u-desc">
            <label className="u-label" htmlFor={descriptionId}>
              Description
            </label>
            <div className={`u-desc-box ${readOnly ? "is-off" : ""}`}>
              <textarea
                id={descriptionId}
                ref={descriptionRef}
                className="u-desc-field"
                rows={3}
                value={draft.description}
                placeholder="Say what this agent is for, in a sentence or two"
                aria-describedby={`${descriptionId}-hint`}
                disabled={readOnly}
                onChange={(event) => edit("description", event.target.value)}
              />
            </div>
            <p className="u-hint" id={`${descriptionId}-hint`}>
              Shown at the top of a new chat. Left empty, it is drawn from the role.
            </p>
          </div>

          {iconOpen && (
            <div className="u-info-icon">
              <span className="u-label">Icon link</span>
              <div className="u-info-icon-row">
                <input
                  className="u-ghost"
                  autoFocus
                  value={iconText}
                  placeholder="Paste an image link, https://…"
                  aria-label="Icon link"
                  onChange={(event) => setIconText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || !canUseIcon) return;
                    event.preventDefault();
                    applyIcon();
                  }}
                />
                <button className="u-btn primary sm" disabled={!canUseIcon} onClick={applyIcon}>
                  Use
                </button>
              </div>
              {iconProblem !== null ? (
                <p className="u-info-error">{iconProblem}</p>
              ) : (
                <p className="u-hint">A square picture works best. It is saved in the file as icon_url.</p>
              )}
              {draft.icon !== "" && (
                <button className="u-btn quiet sm" onClick={removeIcon}>
                  Remove icon
                </button>
              )}
            </div>
          )}

          {aboutRows(metadata).map((row) => {
            const { field } = row;
            if (field === "license") {
              return (
                <div className="u-info-row edit" key={row.label}>
                  <span className="u-info-label">{row.label}</span>
                  <LicenseSelect value={draft.license} disabled={readOnly} onChange={(text) => edit("license", text)} />
                </div>
              );
            }
            const empty = field === "version" ? "0.0.0" : start[field] === "" ? (row.value ?? "Not set") : "Not set";
            return (
              <div key={row.label}>
                <label className="u-info-row edit">
                  <span className="u-info-label">{row.label}</span>
                  <input
                    className="u-ghost"
                    value={draft[field]}
                    placeholder={empty}
                    disabled={readOnly}
                    aria-invalid={field === "version" && versionProblem !== null ? true : undefined}
                    aria-describedby={field === "version" && versionProblem !== null ? versionErrorId : undefined}
                    onChange={(event) => edit(field, event.target.value)}
                  />
                </label>
                {field === "version" && versionProblem !== null && (
                  <p className="u-info-error" id={versionErrorId}>
                    {versionProblem}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="u-group is-last">
          <span className="u-label">In this browser</span>
          {saved === undefined ? (
            <p className="u-info-placeholder">Not in your Agents list yet.</p>
          ) : (
            <>
              <div className="u-info-row bordered">
                <span className="u-info-label">Created</span>
                <span className="u-info-value mono">{new Date(saved.createdAt).toLocaleDateString()}</span>
              </div>
              <div className="u-info-row bordered">
                <span className="u-info-label">Last edited</span>
                <span className="u-info-value mono">{whenAgo(saved.updatedAt)}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="u-panel-foot end">
        <button className="u-btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="u-btn primary" disabled={readOnly || !dirty || versionProblem !== null} onClick={save}>
          Save
        </button>
      </div>
    </>
  );
}
