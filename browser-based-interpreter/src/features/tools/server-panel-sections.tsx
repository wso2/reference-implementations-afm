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

import { useRef } from "react";
import { brief } from "../../core/chat/failure";
import { AUTH_METHODS, type AuthField, isSecretAuthField } from "../../core/mcp/mcp-servers";
import { type ToolInfo } from "../../core/runtime/protocol";
import { ConfirmNote } from "../../ui/ConfirmNote";
import { withCode } from "../../ui/FileCheckPanel";
import { Icon } from "../../ui/Icon";
import { SECRET_INPUT } from "../../ui/inputs";
import { type useSignIn } from "./server-panel-state";

interface AuthFieldsProps {
  fields: readonly AuthField[];
  values: Record<string, string>;
  secretEdits: Record<string, string>;
  saved: (key: string) => boolean;
  rejected: boolean;
  clientIdState?: "idle" | "loading" | "failed";
  onValue: (key: string, value: string) => void;
  onSecretEdit: (key: string, value: string) => void;
  onSecretBlur: () => void;
}

export function AuthFields({
  fields,
  values,
  secretEdits,
  saved,
  rejected,
  clientIdState = "idle",
  onValue,
  onSecretEdit,
  onSecretBlur,
}: AuthFieldsProps) {
  return (
    <>
      {fields.map((field) =>
        isSecretAuthField(field.key) ? (
          <label className="u-group" key={field.key}>
            <span className="u-label-row">
              <span className="u-label">{field.name}</span>
              {saved(field.key) ? (
                <span className={`u-chip ${rejected ? "bad" : "ok"}`}>
                  <span className="u-dot" aria-hidden="true" />
                  {rejected ? "Not accepted" : "Saved"}
                </span>
              ) : (
                <span className="u-row-meta">{field.required ? "Required" : "Optional"}</span>
              )}
              {saved(field.key) && (
                <button className="u-linkish" onClick={() => onSecretEdit(field.key, "")}>
                  Clear
                </button>
              )}
            </span>
            <input
              className="u-input mono"
              type="password"
              {...SECRET_INPUT}
              value={secretEdits[field.key] ?? ""}
              placeholder={saved(field.key) ? "•••••••••••••••••••••" : `Paste the ${field.name}`}
              onChange={(event) => onSecretEdit(field.key, event.target.value)}
              onBlur={onSecretBlur}
            />
          </label>
        ) : (
          <label className="u-group" key={field.key}>
            <span className="u-label-row">
              <span className="u-label">{field.name}</span>
              <span className="u-row-meta">{field.required ? "Required" : "Optional"}</span>
              {field.key === "client_id" && clientIdState === "loading" && (
                <span className="u-loading" role="status">
                  <span className="u-spinner sm" aria-hidden="true" />
                  Loading…
                </span>
              )}
              {field.key === "client_id" && clientIdState === "failed" && (values.client_id ?? "") === "" && (
                <span className="u-field-error" role="alert">
                  <Icon weight={2.2}>
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 7.5v5.5M12 16.5h.01" />
                  </Icon>
                  Cannot obtain Client ID
                </span>
              )}
            </span>
            <input
              className="u-input mono"
              value={values[field.key] ?? ""}
              placeholder={field.placeholder}
              onChange={(event) => onValue(field.key, event.target.value)}
            />
          </label>
        ),
      )}
    </>
  );
}

interface ServerToolsProps {
  url: string;
  probing: boolean;
  found: ToolInfo[] | null;
  error: string | null;
  allowed: string[];
  waiting: string;
  onToggle: (tool: string) => void;
  onToggleAll: () => void;
  onCheckAgain: () => void;
  checkable: boolean;
  showTip: (tool: ToolInfo, row: HTMLElement) => void;
  hideTip: () => void;
}

export function ServerTools({
  url,
  probing,
  found,
  error,
  allowed,
  waiting,
  onToggle,
  onToggleAll,
  onCheckAgain,
  checkable,
  showTip,
  hideTip,
}: ServerToolsProps) {
  return (
    <div className="u-group grow">
      <div className="u-label-row">
        <span className="u-label">Tools</span>
        {probing && <span className="u-row-meta">looking…</span>}
        {found !== null && <span className="u-row-meta">{found.length} found</span>}
        <div className="u-spacer" />
        {found !== null && found.length > 0 && (
          <button className="u-linkish" onClick={onToggleAll}>
            {allowed.length === found.length ? "Clear" : "Select all"}
          </button>
        )}
        {checkable && url.trim() !== "" && !probing && (
          <button className="u-linkish" onClick={onCheckAgain}>
            Check again
          </button>
        )}
      </div>

      {error !== null && (
        <div className="repair">
          <p className="repair-what">{error}</p>
          <button className="u-btn ghost" onClick={onCheckAgain}>
            Try again
          </button>
        </div>
      )}

      {probing ? (
        <div className="skeleton-rows" aria-label="Looking for tools">
          {[0, 1, 2].map((row) => (
            <div className="skeleton-row" key={row}>
              <span className="skeleton-box" />
              <span className="skeleton-line" style={{ width: `${64 - row * 14}%` }} />
            </div>
          ))}
        </div>
      ) : found === null ? (
        <p className="u-hint">{withCode(waiting)}</p>
      ) : (
        <div className="u-rows scroll is-found">
          {found.map((tool) => (
            <label
              className="u-row"
              key={tool.name}
              onMouseEnter={(event) => showTip(tool, event.currentTarget)}
              onMouseLeave={hideTip}
            >
              <input type="checkbox" checked={allowed.includes(tool.name)} onChange={() => onToggle(tool.name)} />
              <span className="u-row-name">{tool.name}</span>
              {tool.description !== undefined && tool.description.trim() !== "" && (
                <span className="u-row-meta" aria-hidden="true">
                  ?
                </span>
              )}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

interface SignInSectionProps extends AuthFieldsProps {
  method: string;
  onMethod: (id: string) => void;
  signedIn: boolean;
  incomplete: boolean;
  signIn: ReturnType<typeof useSignIn>;
  onSignOut: () => void;
}

export function SignInSection({
  method,
  onMethod,
  signedIn,
  incomplete,
  signIn,
  onSignOut,
  ...auth
}: SignInSectionProps) {
  const { note } = signIn;
  const askWrap = useRef<HTMLDivElement>(null);
  return (
    <div className="u-group">
      <span className="u-label">How it signs in</span>
      <div className="u-pills">
        {AUTH_METHODS.map((option) => (
          <button
            key={option.id}
            className={`u-pill-btn ${method === option.id ? "on" : ""}`}
            onClick={() => onMethod(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {signedIn && !signIn.formOpen ? (
        <div className="u-signedin-row">
          <span className="u-chip ok">
            <span className="u-dot" aria-hidden="true" />
            Signed in
          </span>
          <button className="u-linkish" onClick={signIn.openForm}>
            Edit
          </button>
          <button className="u-linkish" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      ) : (
        method !== "none" && (
          <div className="u-auth-fields">
            <AuthFields {...auth} />
            {method === "oauth2" && (
              <div className="u-signin-row" ref={askWrap}>
                <button
                  className="u-btn primary"
                  disabled={incomplete || auth.clientIdState === "loading" || signIn.waiting}
                  aria-haspopup="dialog"
                  aria-expanded={signIn.asking}
                  onClick={signIn.ask}
                >
                  Sign in
                </button>
                {signIn.waiting && (
                  <span className="u-loading" role="status">
                    <span className="u-spinner sm" aria-hidden="true" />
                    Waiting for the sign-in…
                  </span>
                )}
                {signIn.asking && (
                  <ConfirmNote
                    {...signIn.question}
                    secondary={{ label: "Cancel", onPick: signIn.cancelAsk }}
                    primary={{ label: "Sign in", onPick: signIn.signIn }}
                    focus="primary"
                    onDismiss={signIn.cancelAsk}
                    wrap={askWrap}
                  />
                )}
              </div>
            )}
            {note?.status === "failed" && note.reason !== undefined && (
              <div className="repair" ref={signIn.noteRef}>
                <p className="repair-what">{brief(note.reason)}</p>
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

interface ConnectHeadProps {
  tab: "directory" | "url";
  onTab: (tab: "directory" | "url") => void;
  query: string;
  onQuery: (query: string) => void;
}

export function ConnectHead({ tab, onTab, query, onQuery }: ConnectHeadProps) {
  return (
    <div className="u-connect-head">
      <span className="u-seg fill">
        <button className={tab === "directory" ? "on" : ""} onClick={() => onTab("directory")}>
          Directory
        </button>
        <button className={tab === "url" ? "on" : ""} onClick={() => onTab("url")}>
          Add by URL
        </button>
      </span>
      {tab === "directory" && (
        <input
          className="u-input"
          aria-label="Search the directory"
          placeholder="Search the directory"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      )}
    </div>
  );
}

interface PanelFootProps {
  onRemove?: () => void;
  onCancel: () => void;
  onSave: () => void;
  saveDisabled: boolean;
}

export function PanelFoot({ onRemove, onCancel, onSave, saveDisabled }: PanelFootProps) {
  return (
    <div className="u-panel-foot">
      {onRemove !== undefined && (
        <button className="u-btn danger" onClick={onRemove}>
          Remove
        </button>
      )}
      <div className="u-spacer" />
      <button className="u-btn ghost" onClick={onCancel}>
        Cancel
      </button>
      <button className="u-btn primary" disabled={saveDisabled} onClick={onSave}>
        Save
      </button>
    </div>
  );
}
