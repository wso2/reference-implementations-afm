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
import { looksLikeSecret } from "../../core/setup/setup-check";

interface Props {
  names: string[];
  values: Record<string, string>;
  onSave: (values: Record<string, string>) => void;
  onBack?: () => void;
  onClose: () => void;
}

export function ValuesPanel({ names, values, onSave, onBack, onClose }: Props) {
  const [typed, setTyped] = useState(values);
  const canSave = names.every((name) => (typed[name] ?? "").trim() !== "");

  function save() {
    if (!canSave) return;
    onSave(Object.fromEntries(names.map((name) => [name, (typed[name] ?? "").trim()])));
    onClose();
  }

  return (
    <>
      <div className="u-panel-body">
        {onBack !== undefined && (
          <button className="u-detail-back is-near" onClick={onBack}>
            ← Back to Setup
          </button>
        )}
        <p className="u-hint">
          The agent file asks for these settings. They are plain values, such as a region or a name, kept only in this
          tab. Do not type a password or a key here.
        </p>
        {names.map((name) => (
          <label className="u-group" key={name}>
            <span className="u-label">{name}</span>
            <input
              className="u-input"
              spellCheck={false}
              autoComplete="off"
              value={typed[name] ?? ""}
              onChange={(event) => setTyped((current) => ({ ...current, [name]: event.target.value }))}
            />
            {looksLikeSecret(name) && (
              <span className="u-hint u-warn-note">
                This name looks like a secret. A real key goes in a key box, and a value typed here can appear in the
                agent's requests.
              </span>
            )}
          </label>
        ))}
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
