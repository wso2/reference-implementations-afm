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

import { type DirectoryAuth, type DirectoryEntry } from "../../core/mcp/mcp-directory";
import { NameMark } from "../../ui/Marks";

interface Props {
  entry: DirectoryEntry;
  onBack: () => void;
  onConnect: (entry: DirectoryEntry) => void;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="u-fact">
      <span className="u-fact-k">{label}</span>
      <span className="u-fact-v">{children}</span>
    </div>
  );
}

function SignInFact({ auth, title }: { auth: DirectoryAuth; title: string }) {
  if (auth.type === "bearer") {
    return (
      <Fact label="Asks for">
        <span className="mono">Authorization</span> header, stored as a secret - {auth.description}
      </Fact>
    );
  }
  return (
    <Fact label="Sign-in">
      {auth.type === "oauth2" ? `You will sign in with ${title}.` : "None. This server answers without signing in."}
    </Fact>
  );
}

export function ServerDetail({ entry, onBack, onConnect }: Props) {
  return (
    <>
      <div className="u-panel-body panel-slide-in">
        <button className="u-detail-back" onClick={onBack}>
          ← Back to directory
        </button>

        <div className="u-detail-hero">
          <NameMark name={entry.title} seed={entry.id} large />
          <span className="u-detail-id">
            <span className="u-detail-name">{entry.title}</span>
            <span className="u-detail-ns">{entry.publisher}</span>
          </span>
        </div>

        <p className="u-detail-desc">{entry.description}</p>

        <div className="u-detail-chips">
          <span className="u-chip ok">
            <span className="u-dot" aria-hidden="true" />
            Official
          </span>
          {entry.auth.type === "bearer" && <span className="u-chip warn">Needs a key</span>}
        </div>

        <Fact label="Publisher">
          <b>{entry.publisher}</b> - lists this address in its own documentation.
        </Fact>

        <Fact label="Connects to">
          <span className="mono">{entry.url}</span>
        </Fact>

        <SignInFact auth={entry.auth} title={entry.title} />

        <Fact label="Links">
          <a className="u-linkish" href={entry.docsUrl} target="_blank" rel="noreferrer noopener">
            Docs
          </a>
        </Fact>

        <Fact label="Tools">You choose which ones the agent may use. Ticked tools run without asking.</Fact>
      </div>

      <div className="u-panel-foot">
        <button className="u-btn ghost" onClick={onBack}>
          Back
        </button>
        <button className="u-btn primary" onClick={() => onConnect(entry)}>
          Connect
        </button>
      </div>
    </>
  );
}
