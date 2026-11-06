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

import { authorizationCodeRefreshKey, type OAuthProviderRef } from "@afm/runtime";
import { type AgentMetadata, serverAddress } from "@afm/engine";
import { useEffect, useState } from "react";
import { removeMcpServer } from "../../core/agent/agent-source-edit";
import { type DirectoryEntry } from "../../core/mcp/mcp-directory";
import {
  addressNote,
  AUTH_METHODS,
  isSecretAuthField,
  lacksRequiredField,
  listedServer,
  nameFromUrl,
  prepareServerSave,
  secretFieldState,
} from "../../core/mcp/mcp-servers";
import { type SignInOutcome } from "../../core/oauth/oauth-signin";
import { type ProbeResult, type ToolInfo } from "../../core/runtime/protocol";
import { type Issue } from "../../core/setup/setup-check";
import { tipFor, type TipTarget, ToolTip } from "../../ui/ToolTip";
import { ServerDetail } from "./ServerDetail";
import { ServerDirectory } from "./ServerDirectory";
import { ConnectHead, PanelFoot, ServerTools, SignInSection } from "./server-panel-sections";
import {
  authBlockFor,
  discoveredValues,
  providerFor,
  savedServer,
  seedValues,
  signInNeed,
  useDirectoryClient,
  useServerProbe,
  useSignIn,
  waitingNote,
} from "./server-panel-state";

interface Props {
  content: string;
  editing: string | null;
  metadata: AgentMetadata;
  onApply: (content: string) => void;
  onProbe: (server: NonNullable<AgentMetadata["tools"]>) => Promise<ProbeResult>;
  onSignIn: (provider: OAuthProviderRef) => Promise<SignInOutcome>;
  onSignOut: (provider: OAuthProviderRef) => void;
  onStoreSecret: (name: string, value: string, address?: string) => void;
  knownSecrets: string[];
  issue: Issue | null;
  onBack?: () => void;
  onClose: () => void;
}

export function ServerPanel({
  content,
  editing,
  metadata,
  onApply,
  onProbe,
  onSignIn,
  onSignOut,
  onClose,
  onStoreSecret,
  knownSecrets,
  issue,
  onBack,
}: Props) {
  const saved = savedServer(metadata, editing);
  const { url: existingUrl, auth: existingAuth, isStdio, deny: denied } = saved;
  const savedTools = saved.allow ?? [];

  const [url, setUrl] = useState(existingUrl);
  const [method, setMethod] = useState(typeof existingAuth?.type === "string" ? existingAuth.type : "none");
  const [values, setValues] = useState(() => seedValues(existingAuth));
  const [allowed, setAllowed] = useState(savedTools);
  const [tip, setTip] = useState<TipTarget | null>(null);
  const [tab, setTab] = useState<"directory" | "url">("directory");
  const [pendingDirectoryProbe, setPendingDirectoryProbe] = useState(false);
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [detail, setDetail] = useState<DirectoryEntry | null>(null);
  const [secretEdits, setSecretEdits] = useState<Record<string, string>>({});

  const showTip = (tool: ToolInfo, row: HTMLElement) => {
    const body = (tool.description ?? "").trim();
    if (body === "") return;
    setTip(tipFor(tool.name, body, row.getBoundingClientRect()));
  };
  const hideTip = () => setTip(null);

  const chosen = AUTH_METHODS.find((m) => m.id === method) ?? AUTH_METHODS[0]!;
  const writesMethod = AUTH_METHODS.some((option) => option.id === method);

  const fieldState = (fieldKey: string) =>
    secretFieldState(values[fieldKey] ?? "", secretEdits[fieldKey], knownSecrets);
  const secretStored = (fieldKey: string) => fieldState(fieldKey) === "saved";
  const scopeList = (values.scopes ?? "").split(/[\s,]+/).filter((scope) => scope !== "");
  const hasTypedSecret = chosen.fields.some(
    (field) => isSecretAuthField(field.key) && (secretEdits[field.key] ?? "").trim() !== "",
  );

  const listed = saved.allow !== undefined;
  const live = editing === null || !listed || url.trim() !== existingUrl;
  const taken = (metadata.tools?.mcp ?? []).map((s) => s.name).filter((n) => n !== editing);
  const name = editing ?? nameFromUrl(url, taken, listedServer(url.trim())?.id);

  const auth = authBlockFor(method, chosen.fields, values, secretEdits, scopeList);
  const incomplete = lacksRequiredField(chosen.fields, auth);
  const provider = providerFor(values, scopeList, url);
  const probe = useServerProbe({
    url,
    method,
    writesMethod,
    name,
    live,
    auth,
    issue,
    onProbe,
    onDiscovered: (discovered) => {
      setMethod("oauth2");
      setValues(discoveredValues(discovered));
    },
  });
  const directoryClient = useDirectoryClient(setValues);
  const signIn = useSignIn({ provider, onSignIn, onSignedIn: () => void probe.probe(true) });

  const signedIn =
    method === "oauth2" &&
    (knownSecrets.includes(authorizationCodeRefreshKey(provider)) || (probe.found !== null && probe.error === null));
  const need = signInNeed(
    chosen.fields.some((field) => fieldState(field.key) === "missing"),
    method,
    signedIn,
  );
  const tools: ToolInfo[] | null = live ? probe.found : [...savedTools, ...denied].map((tool) => ({ name: tool }));

  useEffect(() => {
    if (!pendingDirectoryProbe) return;
    setPendingDirectoryProbe(false);
    void probe.probe(true);
  }, [pendingDirectoryProbe, probe]);

  function connectFromDirectory(entry: DirectoryEntry) {
    setUrl(entry.url);
    setTab("url");
    setMethod(entry.auth.type);
    setValues({});
    probe.reset();
    setAllowed([]);
    directoryClient.cancel();
    if (entry.auth.type === "none") setPendingDirectoryProbe(true);
    if (entry.auth.type === "oauth2") void directoryClient.lookUp({ ...entry, auth: entry.auth });
  }

  function toggle(tool: string) {
    setAllowed((current) => (current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool]));
  }

  function save() {
    if (name === "") return;
    const next = prepareServerSave({
      content,
      editing,
      server: { name, url: url.trim(), auth },
      knownSecrets,
      tools,
      allowed,
    });
    for (const secret of next.secrets) {
      onStoreSecret(secret.name, secret.value, serverAddress(url.trim()));
    }
    onApply(next.content);
    onClose();
  }

  function remove() {
    if (editing === null) return;
    onApply(removeMcpServer(content, editing));
    onClose();
  }

  const showDirectory = editing === null && tab === "directory";
  const showDetail = showDirectory && detail !== null;
  return (
    <>
      <div className="u-panel-body">
        {onBack !== undefined && (
          <button className="u-detail-back is-near" onClick={onBack}>
            ← Back to Setup
          </button>
        )}
        {editing === null && !showDetail && (
          <ConnectHead tab={tab} onTab={setTab} query={directoryQuery} onQuery={setDirectoryQuery} />
        )}

        {showDetail ? (
          <ServerDetail
            entry={detail}
            onBack={() => setDetail(null)}
            onConnect={(entry) => {
              setDetail(null);
              connectFromDirectory(entry);
            }}
          />
        ) : showDirectory ? (
          <ServerDirectory query={directoryQuery} onConnect={connectFromDirectory} onInfo={setDetail} />
        ) : (
          <>
            {isStdio && (
              <p className="u-hint">
                This server runs a command on the machine rather than answering at a URL. Editing it here would turn it
                into a URL and lose the command, so open <strong>Raw</strong> to change it.
              </p>
            )}
            {!writesMethod && (
              <p className="u-hint">
                This server signs in with <code>{method}</code>, which this panel cannot edit. Choose a method below to
                replace it, or open <strong>Raw</strong> to change the file.
              </p>
            )}
            <label className="u-group">
              <span className="u-label">Address</span>
              <input
                className="u-input mono"
                value={url}
                placeholder="https://example.com/mcp"
                onChange={(event) => setUrl(event.target.value)}
                onBlur={() => void probe.probe()}
                readOnly={isStdio}
              />
            </label>

            <SignInSection
              method={method}
              onMethod={setMethod}
              signedIn={signedIn}
              incomplete={incomplete}
              signIn={signIn}
              onSignOut={() => {
                onSignOut(provider);
                probe.forget();
              }}
              fields={chosen.fields}
              values={values}
              secretEdits={secretEdits}
              saved={secretStored}
              rejected={probe.rejected}
              clientIdState={directoryClient.state}
              onValue={(key, value) => setValues((current) => ({ ...current, [key]: value }))}
              onSecretEdit={(key, value) => setSecretEdits((current) => ({ ...current, [key]: value }))}
              onSecretBlur={() => hasTypedSecret && void probe.probe(true)}
            />

            <ServerTools
              url={url}
              probing={probe.probing}
              found={tools}
              error={probe.error}
              allowed={allowed}
              waiting={waitingNote(url, probe.probing, probe.error, need, editing !== null && !listed)}
              onToggle={toggle}
              onToggleAll={() => {
                if (tools) setAllowed(allowed.length === tools.length ? [] : tools.map((tool) => tool.name));
              }}
              onCheckAgain={() => void probe.probe(true)}
              checkable={live}
              showTip={showTip}
              hideTip={hideTip}
            />
          </>
        )}
      </div>

      <ToolTip tip={tip} />

      {!showDirectory && (
        <PanelFoot
          onRemove={editing === null ? undefined : remove}
          onCancel={onClose}
          onSave={save}
          saveDisabled={
            url.trim() === "" || addressNote(url) !== null || name === "" || isStdio || !writesMethod || incomplete
          }
        />
      )}
    </>
  );
}
