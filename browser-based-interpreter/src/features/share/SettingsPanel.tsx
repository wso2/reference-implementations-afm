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
import { useRef, useState } from "react";
import { useThemeContext } from "../../app/contexts";
import { withEntryKeys } from "../../core/tools/trust";
import { ConfirmNote } from "../../ui/ConfirmNote";
import { Icon } from "../../ui/Icon";
import { type useStandaloneSession } from "../../worker-client/useStandaloneSession";
import { PermissionsWindow, serverTools, TRUST_COPY, withTicks } from "../setup/TrustScreen";

interface Props {
  session: ReturnType<typeof useStandaloneSession>;
  metadata: AgentMetadata | null;
  trusted: string[] | null;
  onTrustedChange: (keys: string[]) => void;
}

export function SettingsPanel({ session, metadata, trusted, onTrustedChange }: Props) {
  const { setting, setTheme } = useThemeContext();

  const keys = session.state.savedSecrets.filter((name) => !name.startsWith("afm.oauth."));

  return (
    <div className="u-panel-body">
      <div className="u-group">
        <span className="u-label">Your keys</span>
        {keys.length === 0 ? (
          <p className="u-hint is-flush">No key yet.</p>
        ) : (
          <div className="u-rows is-loose">
            {keys.map((name) => (
              <div className="u-row u-key-row" key={name}>
                <span className="u-row-name mono" title={name}>
                  {name}
                </span>
                <ForgetButton name={name} onForget={() => session.removeSecret(name)} />
              </div>
            ))}
          </div>
        )}
      </div>

      <PermissionsRow metadata={metadata} trusted={trusted} onChange={onTrustedChange} />

      <div className="u-group">
        <span className="u-label">Appearance</span>
        <span className="u-seg fill">
          {(["light", "dark", "auto"] as const).map((option) => (
            <button key={option} className={setting === option ? "on" : ""} onClick={() => setTheme(option)}>
              {option === "auto" ? "System" : option === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </span>
      </div>
    </div>
  );
}

interface PermissionsRowProps {
  metadata: AgentMetadata | null;
  trusted: string[] | null;
  onChange: (keys: string[]) => void;
}

function PermissionsRow({ metadata, trusted, onChange }: PermissionsRowProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="u-group">
      <button className="u-navrow" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon path="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" size={16} />
        {TRUST_COPY.permissions}
        <Icon className="chev" path="m9 18 6-6-6-6" size={14} weight={2} />
      </button>
      {open && (
        <PermissionsEditor metadata={metadata} trusted={trusted} onChange={onChange} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

function PermissionsEditor({ metadata, trusted, onChange, onClose }: PermissionsRowProps & { onClose: () => void }) {
  const [servers] = useState(() => (metadata === null ? [] : serverTools(metadata, trusted ?? [])));
  // A selection saved in the older form is shown, and taken back, like any other.
  const current = new Set(withEntryKeys(trusted ?? [], metadata));
  return (
    <PermissionsWindow
      servers={servers}
      ticked={current}
      onTick={(keys, on) => onChange([...withTicks(current, keys, on)])}
      onClose={onClose}
    />
  );
}

export function ForgetButton({ name, onForget }: { name: string; onForget: () => void }) {
  const [asking, setAsking] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  function cancel() {
    setAsking(false);
    trigger.current?.focus();
  }

  return (
    <span className="u-forget" ref={wrap}>
      <button
        className="u-btn quiet sm"
        ref={trigger}
        aria-label={`Forget ${name}`}
        aria-haspopup="dialog"
        aria-expanded={asking}
        onClick={() => setAsking(!asking)}
      >
        Forget
      </button>
      {asking && (
        <ConfirmNote
          title="Forget this key?"
          text={`${name} will be removed. You will need to paste it again to use it.`}
          secondary={{ label: "Cancel", onPick: cancel }}
          primary={{
            label: "Forget",
            onPick: () => {
              setAsking(false);
              onForget();
            },
          }}
          focus="secondary"
          onDismiss={cancel}
          wrap={wrap}
          align="end"
        />
      )}
    </span>
  );
}
