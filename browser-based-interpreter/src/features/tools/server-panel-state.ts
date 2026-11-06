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

import { type OAuthProviderRef, SignInRefusedError } from "@afm/runtime";
import { type AgentMetadata, describeError } from "@afm/engine";
import { useEffect, useRef, useState } from "react";
import { type NewMcpServer } from "../../core/agent/agent-source-edit";
import { brief, logDetails } from "../../core/chat/failure";
import { type DirectoryEntry, type OAuthSignIn } from "../../core/mcp/mcp-directory";
import { type DiscoveredMcpAuth, discoverMcpServerAuth } from "../../core/mcp/mcp-auth";
import { addressNote, type AuthField, isSecretAuthField } from "../../core/mcp/mcp-servers";
import { type SignInOutcome } from "../../core/oauth/oauth-signin";
import { type ProbeResult, type ToolInfo } from "../../core/runtime/protocol";
import { credentialOf, displayName, type Issue, issueSentence } from "../../core/setup/setup-check";
import { useRunTracker } from "../../ui/hooks";

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

export function useServerProbe(options: ProbeOptions) {
  const { url, method, writesMethod, name, live, auth, issue, onProbe, onDiscovered } = options;
  const [probing, setProbing] = useState(false);
  const [found, setFound] = useState<ToolInfo[] | null>(null);
  const [probedUrl, setProbedUrl] = useState("");
  const [error, setError] = useState<string | null>(issue?.text ?? null);
  const [rejected, setRejected] = useState(issue?.kind === "rejected");
  const probes = useRunTracker();
  const urlRef = useRef(url);
  urlRef.current = url;

  async function probe(force = false) {
    if (!writesMethod || url.trim() === "" || name === "") return;
    if (!force && (!live || url.trim() === probedUrl)) return;
    const run = probes.begin("probe");
    const superseded = () => !probes.isCurrent("probe", run) || url.trim() !== urlRef.current.trim();
    setProbing(true);
    setError(null);

    if (method === "none") {
      let discovered: DiscoveredMcpAuth | null = null;
      try {
        discovered = await discoverMcpServerAuth(url.trim());
      } catch (refusal) {
        if (refusal instanceof SignInRefusedError) {
          if (superseded()) return;
          setProbing(false);
          setError(brief(refusal.message));
          return;
        }
      }
      if (superseded()) return;
      if (discovered !== null) {
        onDiscovered(discovered);
        setProbing(false);
        return;
      }
    }

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
      setError(issueSentence(result.failure.kind, displayName(name), credentialOf(server), result.failure.message));
      return;
    }
    const reported = (result.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description }));
    setFound(reported);
    setProbedUrl(url.trim());
  }

  function forget() {
    setFound(null);
    setError(null);
    setProbedUrl("");
  }

  function reset() {
    forget();
    setProbing(false);
  }

  return { probing, found, error, rejected, probe, forget, reset };
}

interface SignInOptions {
  provider: OAuthProviderRef;
  onSignIn: (provider: OAuthProviderRef) => Promise<SignInOutcome>;
  onSignedIn: () => void;
}

export function useSignIn({ provider, onSignIn, onSignedIn }: SignInOptions) {
  const [formOpen, setFormOpen] = useState(false);
  const [note, setNote] = useState<Exclude<SignInOutcome, { status: "signed-in" }> | null>(null);
  const noteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    noteRef.current?.scrollIntoView({ block: "nearest" });
  }, [note]);

  function signIn() {
    setNote(null);
    void onSignIn(provider).then((outcome) => {
      if (outcome.status === "signed-in") onSignedIn();
      else setNote(outcome);
    });
  }

  return { formOpen, openForm: () => setFormOpen(true), note, clearNote: () => setNote(null), noteRef, signIn };
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
