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

import { type AgentMetadata, describeError } from "@afm/engine";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type NewMcpServer } from "../../core/agent/agent-source-edit";
import { hostOf } from "../../core/agent/addresses";
import { brief, logDetails } from "../../core/chat/failure";
import { type DirectoryEntry, type OAuthSignIn } from "../../core/mcp/mcp-directory";
import { type DiscoveredMcpAuth, discoverMcpServerAuth } from "../../core/mcp/mcp-auth";
import { addressNote, type AuthField, isSecretAuthField } from "../../core/mcp/mcp-servers";
import { type SignInOutcome } from "../../core/oauth/oauth-signin";
import { type ProbeResult, type ToolInfo } from "../../core/runtime/protocol";
import { credentialOf, displayName, type Issue, issueSentence } from "../../core/setup/setup-check";
import { useRunTracker } from "../../ui/hooks";
import { authorizationCodeRefreshKey, type OAuthProviderRef } from "../../core/oauth/session";
import { SignInRefusedError } from "../../core/oauth/discovery";

export function discoveredValues(discovered: DiscoveredMcpAuth): Record<string, string> {
  return {
    authorize_url: discovered.authorizeUrl,
    token_url: discovered.tokenUrl,
    client_id: discovered.clientId,
    ...(discovered.scopes !== undefined && discovered.scopes.length > 0 ? { scopes: discovered.scopes.join(" ") } : {}),
  };
}

export const directoryValues = (found: DiscoveredMcpAuth, auth: OAuthSignIn): Record<string, string> =>
  discoveredValues({ ...found, scopes: auth.scopes ?? found.scopes });

export function seedValues(authentication: object | undefined): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const [key, value] of Object.entries(authentication ?? {})) {
    if (key === "type" || key === "grant_type") continue;
    seed[key] = Array.isArray(value) ? value.join(" ") : String(value ?? "");
  }
  return seed;
}

export function authBlockFor(
  method: string,
  fields: readonly AuthField[],
  values: Record<string, string>,
  secretEdits: Record<string, string>,
  scopeList: string[],
): NewMcpServer["auth"] {
  if (method === "none") return undefined;
  const written: Record<string, string> = {};
  for (const field of fields) {
    if (field.key === "scopes") continue;
    const value = isSecretAuthField(field.key) ? (secretEdits[field.key] ?? values[field.key]) : values[field.key];
    if (value !== undefined && value.trim() !== "") written[field.key] = value.trim();
  }
  if (method === "oauth2") written.grant_type = "authorization_code";
  return { type: method, fields: written, scopes: scopeList.length > 0 ? scopeList : undefined };
}

export function providerFor(values: Record<string, string>, scopeList: string[], url: string): OAuthProviderRef {
  return {
    authorizeUrl: values.authorize_url ?? "",
    tokenUrl: values.token_url ?? "",
    clientId: values.client_id ?? "",
    scopes: scopeList,
    resource: url.trim(),
  };
}

export function savedServer(metadata: AgentMetadata, editing: string | null) {
  const server = (metadata.tools?.mcp ?? []).find((candidate) => candidate.name === editing);
  const http = server?.transport.type === "http" ? server.transport : undefined;
  return {
    url: http?.url ?? "",
    auth: http?.authentication,
    isStdio: server?.transport.type === "stdio",
    allow: server?.tool_filter?.allow,
    deny: server?.tool_filter?.deny ?? [],
  };
}

// A person is signed in when the worker holds the sign-in's refresh token (it tells the page its name), or the server just answered.
export function isSignedIn(
  method: string,
  provider: OAuthProviderRef,
  knownSecrets: readonly string[],
  answered: { found: ToolInfo[] | null; error: unknown },
): boolean {
  return method === "oauth2" && (knownSecrets.includes(authorizationCodeRefreshKey(provider)) || (answered.found !== null && answered.error === null));
}

export function signInNeed(missingField: boolean, method: string, signedIn: boolean): "none" | "missing" | "signin" {
  if (missingField) return "missing";
  return method === "oauth2" && !signedIn ? "signin" : "none";
}

export function waitingNote(
  url: string,
  probing: boolean,
  error: string | null,
  need: "none" | "missing" | "signin",
  unlisted: boolean,
): string {
  if (probing) return "Checking the address…";
  if (url.trim() === "") return "Enter the address and its tools are listed here.";
  const badAddress = addressNote(url);
  if (badAddress !== null) return badAddress;
  if (need === "missing") return "This server needs its credential. Enter it above to list its tools.";
  if (need === "signin") return "Sign in above to list this server's tools.";
  if (error !== null) return "No tools listed. Fix the address or check again.";
  if (unlisted)
    return "This file does not list this server's tools, so every tool is allowed. Press Check again to choose which.";
  return "Press Check again to list this server's tools.";
}

interface ProbeOptions {
  url: string;
  method: string;
  writesMethod: boolean;
  name: string;
  live: boolean;
  auth: NewMcpServer["auth"];
  issue: Issue | null;
  onProbe: (server: NonNullable<AgentMetadata["tools"]>) => Promise<ProbeResult>;
  onDiscovered: (discovered: DiscoveredMcpAuth) => void;
}

// A probe answers for one address and one way of signing in, with the settings of that sign-in. The same list is not
// an answer for another. A secret is never part of the key: it is left out, and is checked when it is typed.
export function probeKey(method: string, url: string, auth?: NewMcpServer["auth"]): string {
  const settings = Object.entries(auth?.fields ?? {})
    .filter(([field]) => !isSecretAuthField(field) && !/secret|password/i.test(field))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([field, value]) => `${field}=${value}`);
  return [method, url.trim(), ...settings, (auth?.scopes ?? []).join(" ")].join("\n");
}

// The tools to show. A list found by checking wins. Without one, a server that is already listed in the file shows
// the tools it lists, and any other server shows nothing yet.
export function toolsShown(live: boolean, found: ToolInfo[] | null, listed: string[]): ToolInfo[] | null {
  if (found !== null) return found;
  return live ? null : listed.map((name) => ({ name }));
}

// Whether every tool on show is allowed. It looks at the names, not how many, because the allowed names can include
// ones the list on show no longer has.
export function allShown(shown: ToolInfo[], allowed: string[]): boolean {
  return shown.every((tool) => allowed.includes(tool.name));
}

export function toolsProbedFor(probed: { key: string; tools: ToolInfo[] } | null, key: string): ToolInfo[] | null {
  return probed !== null && probed.key === key ? probed.tools : null;
}

export function useServerProbe(options: ProbeOptions) {
  const { url, method, writesMethod, name, live, auth, issue, onProbe, onDiscovered } = options;
  const [probing, setProbing] = useState(false);
  const [probed, setProbed] = useState<{ key: string; tools: ToolInfo[] } | null>(null);
  const [error, setError] = useState<string | null>(issue?.text ?? null);
  const [rejected, setRejected] = useState(issue?.kind === "rejected");
  const probes = useRunTracker();
  // Kept after each commit, not while rendering: a render that React drops must not change what a waiting check compares with.
  const latest = useRef({ url, method });
  useLayoutEffect(() => {
    latest.current = { url, method };
  });
  const key = probeKey(method, url, auth);
  const found = toolsProbedFor(probed, key);

  async function signInFoundOrRefused(superseded: () => boolean): Promise<boolean> {
    let discovered: DiscoveredMcpAuth | null = null;
    try {
      discovered = await discoverMcpServerAuth(url.trim());
    } catch (refusal) {
      if (!(refusal instanceof SignInRefusedError)) return superseded();
      if (superseded()) return true;
      setProbing(false);
      setError(brief(refusal.message));
      return true;
    }
    if (superseded()) return true;
    if (discovered === null) return false;
    onDiscovered(discovered);
    setProbing(false);
    return true;
  }

  async function probe(force = false) {
    if (!writesMethod || url.trim() === "" || name === "") return;
    if (!force && (!live || found !== null)) return;
    const run = probes.begin("probe");
    const superseded = () =>
      !probes.isCurrent("probe", run) || url.trim() !== latest.current.url.trim() || method !== latest.current.method;
    setProbing(true);
    setError(null);

    if (method === "none" && (await signInFoundOrRefused(superseded))) return;

    const server = {
      name,
      transport: {
        type: "http" as const,
        url: url.trim(),
        ...(auth === undefined
          ? {}
          : { authentication: { type: auth.type, ...auth.fields, ...(auth.scopes ? { scopes: auth.scopes } : {}) } }),
      },
    };
    const result = await onProbe({ mcp: [server] });
    if (superseded()) {
      if (probes.isCurrent("probe", run)) setProbing(false);
      return;
    }
    setProbing(false);
    setRejected(result.failure?.kind === "rejected");
    if (result.failure !== undefined) {
      setProbed(null);
      logDetails(result.failure.message);
      setError(issueSentence(result.failure.kind, displayName(name), credentialOf(server), result.failure.message));
      return;
    }
    const reported = (result.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description }));
    setProbed({ key, tools: reported });
  }

  function forget() {
    setProbed(null);
    setError(null);
  }

  function reset() {
    forget();
    setProbing(false);
  }

  // A credential was typed or cleared. A secret is not part of the key, so this is how the list found with the old one
  // goes: it is dropped, and a check still running for the old one is out of date, so it cannot bring the list back.
  function credentialEdited() {
    probes.begin("probe");
    reset();
    setRejected(false);
  }

  return { probing, found, error, rejected, probe, forget, reset, credentialEdited };
}

export function signInQuestion(provider: OAuthProviderRef): { title: string; text: string } {
  return {
    title: "Open the sign-in window?",
    text: `A window opens on ${hostOf(provider.authorizeUrl)} so you can sign in to ${hostOf(provider.resource)}. Type your password only there.`,
  };
}

interface SignInOptions {
  provider: OAuthProviderRef;
  onSignIn: (provider: OAuthProviderRef) => Promise<SignInOutcome>;
  onSignedIn: () => void;
}

export function useSignIn({ provider, onSignIn, onSignedIn }: SignInOptions) {
  const [formOpen, setFormOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [note, setNote] = useState<Exclude<SignInOutcome, { status: "signed-in" }> | null>(null);
  const noteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    noteRef.current?.scrollIntoView({ block: "nearest" });
  }, [note]);

  function signIn() {
    setAsking(false);
    setNote(null);
    setWaiting(true);
    void onSignIn(provider)
      .catch((): SignInOutcome => ({ status: "failed" }))
      .then((outcome) => {
        setWaiting(false);
        if (outcome.status === "signed-in") onSignedIn();
        else setNote(outcome);
      });
  }

  return {
    formOpen,
    openForm: () => setFormOpen(true),
    asking,
    waiting,
    ask: () => setAsking(true),
    cancelAsk: () => setAsking(false),
    question: signInQuestion(provider),
    note,
    clearNote: () => setNote(null),
    noteRef,
    signIn,
  };
}

export function useDirectoryClient(onValues: (values: Record<string, string>) => void) {
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  const latest = useRef(0);

  function cancel() {
    latest.current += 1;
    setState("idle");
  }

  async function lookUp(entry: DirectoryEntry & { auth: OAuthSignIn }) {
    const pick = ++latest.current;
    setState("loading");
    try {
      const found = await discoverMcpServerAuth(entry.url);
      if (pick !== latest.current) return;
      if (found !== null) onValues(directoryValues(found, entry.auth));
      if (found === null || found.clientId === "") logDetails(`No client ID could be obtained for ${entry.url}`);
      setState(found === null || found.clientId === "" ? "failed" : "idle");
    } catch (failure) {
      if (pick !== latest.current) return;
      logDetails(describeError(failure));
      setState("failed");
    }
  }

  return { state, cancel, lookUp };
}
