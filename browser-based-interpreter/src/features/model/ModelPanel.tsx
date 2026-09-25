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

import { useState } from "react";
import { getModelApiKey, getModelField, setModelApiKey, setModelField } from "../../core/agent/agent-source-edit";
import { findProvider, MODEL_PROVIDERS, type ProviderOption } from "../../core/agent/catalogs";
import { secretNameOf, secretReference } from "../../core/agent/secret-reference";
import { type Issue } from "../../core/setup/setup-check";
import { SECRET_INPUT } from "../../ui/inputs";

interface Props {
  content: string;
  savedSecrets: string[];
  onApply: (content: string) => void;
  issue: Issue | null;
  onSaveKey: (name: string, value: string) => void;
  onBack?: () => void;
  onClose: () => void;
}

export function ModelPanel({ content, savedSecrets, issue, onApply, onSaveKey, onBack, onClose }: Props) {
  const fileProvider = getModelField(content, "provider");

  const [provider, setProvider] = useState(findProvider(fileProvider) !== undefined ? fileProvider : "");

  const [model, setModel] = useState(getModelField(content, "name"));
  const [key, setKey] = useState("");

  const known = findProvider(provider);
  const fileSecretName = secretNameOf(getModelApiKey(content));
  const secretName = provider === fileProvider && fileSecretName !== "" ? fileSecretName : (known?.secretName ?? "");
  const saved = savedSecrets.includes(secretName);
  const rejected = saved && issue?.kind === "rejected";

  function pickProvider(option: ProviderOption) {
    if (option.id !== provider) setModel("");
    setProvider(option.id);
  }

  const canSave = known !== undefined && model.trim() !== "";

  function save() {
    if (!canSave) return;
    let next = setModelField(content, "provider", provider);
    next = setModelField(next, "name", model.trim());
    next = setModelApiKey(next, secretReference(secretName));
    if (key.trim() !== "") onSaveKey(secretName, key.trim());
    onApply(next);
    onClose();
  }

  return (
    <>
      <div className="u-panel-body is-model">
        {onBack !== undefined && (
          <button className="u-detail-back is-near" onClick={onBack}>
            ← Back to Setup
          </button>
        )}
        <div className="u-group">
          <span className="u-label">Provider</span>
          <div className="u-pills">
            {MODEL_PROVIDERS.map((option) => (
              <button
                key={option.id}
                className={`u-pill-btn ${provider === option.id ? "on" : ""}`}
                onClick={() => pickProvider(option)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {known === undefined ? (
          <p className="u-hint">
            {fileProvider === "" ? (
              "Select a provider to see its models."
            ) : (
              <>
                Unsupported model provider <code>{fileProvider}</code>. Choose a provider above.
              </>
            )}
          </p>
        ) : (
          <>
            <div className="u-group">
              <span className="u-label">Model</span>
              <div className="u-rows">
                {known.models.map((option) => (
                  <button
                    key={option.id}
                    className={`u-row ${model === option.id ? "on" : ""}`}
                    onClick={() => setModel(option.id)}
                  >
                    <span className={`u-radio ${model === option.id ? "on" : ""}`} />
                    <span className="u-row-name">
                      {option.label}
                      {option.note !== undefined && <span className="u-row-sub"> · {option.note}</span>}
                    </span>
                  </button>
                ))}
              </div>
              {model.trim() === "" && <p className="u-hint">Select a model to enable Save.</p>}
            </div>

            <div className="u-group">
              <div className="u-label-row">
                <span className="u-label">API key</span>
                <span className={`u-chip ${rejected ? "bad" : saved ? "ok" : "warn"}`}>
                  <span className="u-dot" aria-hidden="true" />
                  {rejected ? "Not accepted" : saved ? "Entered" : "Not entered yet"}
                </span>
              </div>
              <input
                className="u-input u-key-input"
                aria-label={`${known.label} API key`}
                type="password"
                {...SECRET_INPUT}
                value={key}
                placeholder={saved ? "•••••••••••••••••••••" : `Paste your ${known.label} key`}
                onChange={(event) => setKey(event.target.value)}
              />
              {issue !== null && !rejected && <p className="u-hint u-warn-note">{issue.text}</p>}
            </div>
          </>
        )}
      </div>

      <div className="u-panel-foot">
        <button className="u-btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="u-btn primary" disabled={!canSave} onClick={save}>
          Save
        </button>
      </div>
    </>
  );
}
