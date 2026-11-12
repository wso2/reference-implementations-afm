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

import { describeError } from "@afm/engine";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useAgentsLibrary, useHistory } from "../../app/contexts";
import { buildableAgent } from "../../core/agent/agent-validation";
import { type ChatState } from "../../core/chat/chat-state";
import { logDetails } from "../../core/chat/failure";
import { fetchAgentFile } from "../../core/links/load-paths";
import {
  afterSave,
  autosaveDue,
  EMPTY_TEMPLATE,
  identityFor,
  initialConfirmed,
  initialContent,
  missingAgentId,
  openedFromLink,
  type Opening,
  openingOf,
  originFor,
  pendingEditToSave,
  receivedSource,
} from "../../core/links/workspace-content";
import { agentFileFetch } from "../../core/runtime/factories";
import { findAgent } from "../../core/storage/stores";
import { keepConfirmed, trustKeyFor, withTrusted } from "../../core/tools/trust";
import { useSettled } from "../../ui/hooks";

interface Options {
  clearAgent: () => void;
  onMissingAgent: () => void;
}

interface Provenance {
  trusted: boolean;
  confirmed: string[] | null;
  received: string | null;
}

function provenanceOf(opening: Opening): Provenance {
  return {
    trusted: !openedFromLink(opening),
    confirmed: initialConfirmed(opening),
    received: receivedSource(opening),
  };
}

export function useWorkspaceDocument({ clearAgent, onMissingAgent }: Options) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const draftSource = (location.state as { draftSource?: string } | null)?.draftSource;
  const library = useAgentsLibrary();
  const [initial] = useState(() => openingOf(searchParams, location.hash, draftSource));
  const [content, setContent] = useState(() => initialContent(initial));
  const [savedContent, setSavedContent] = useState(content);
  const [missingAgent, setMissingAgent] = useState<string | null>(() => missingAgentId(initial));
  const [agentId, setAgentId] = useState<string | null>(() => (missingAgent === null ? initial.agentId : null));
  const [saveFailed, setSaveFailed] = useState(false);
  const [fileLoading, setFileLoading] = useState(initial.file !== null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [linkedFile, setLinkedFile] = useState<string | null>(null);
  const [provenance, setProvenance] = useState(() => provenanceOf(initial));
  const { trusted, confirmed, received } = provenance;
  const loadedIdentityRef = useRef(identityFor(initial));
  const callbacks = useRef({ clearAgent, onMissingAgent, flushPendingEdit });
  callbacks.current = { clearAgent, onMissingAgent, flushPendingEdit };
  const readable = useMemo(() => buildableAgent(content), [content]);

  function updateConfirmed(update: (current: string[] | null) => string[] | null) {
    setProvenance((current) => ({ ...current, confirmed: update(current.confirmed) }));
  }

  useEffect(() => {
    const opening = openingOf(searchParams, location.hash, draftSource);
    const gone = missingAgentId(opening);
    if (gone !== null) {
      setMissingAgent(gone);
      setAgentId(null);
      if (searchParams.get("view") !== "chat") callbacks.current.onMissingAgent();
      const rest = new URLSearchParams(searchParams);
      rest.delete("agentId");
      setSearchParams(rest, { replace: true });
      return;
    }
    const nextIdentity = identityFor(opening);
    if (nextIdentity === loadedIdentityRef.current) return;
    loadedIdentityRef.current = nextIdentity;
    callbacks.current.flushPendingEdit();
    setProvenance(provenanceOf(opening));
    setLinkedFile(null);
    const next = initialContent(opening);
    setContent(next);
    setSavedContent(next);
    setAgentId(opening.agentId);
    callbacks.current.clearAgent();
  }, [searchParams, setSearchParams, location.hash, draftSource]);

  const fileParam = searchParams.get("file");
  useEffect(() => {
    if (fileParam === null) {
      setFileLoading(false);
      setFileError(null);
      return;
    }
    let cancelled = false;
    setFileLoading(true);
    setFileError(null);
    void fetchAgentFile(fileParam, agentFileFetch())
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setSavedContent(text);
        setAgentId(null);
        setLinkedFile(fileParam);
        setProvenance((current) => ({ ...current, confirmed: [], received: text }));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        logDetails(describeError(error));
        setFileError("Couldn't load that file");
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [fileParam]);

  function persistToLibrary(
    source: string = content,
    tools: string[] | null = confirmed,
  ): { id: string | null; persisted: boolean } {
    if (!readable.ok) return { id: null, persisted: false };
    const origin = originFor(received, source);
    if (origin === "blank") setProvenance((current) => ({ ...current, received: null }));
    const result = library.save({
      id: agentId ?? undefined,
      name: readable.metadata.name ?? "Untitled agent",
      description: readable.metadata.description ?? "",
      source,
      origin,
      confirmedTools: tools,
    });
    const after = afterSave(agentId, result);
    if (result.persisted) setSavedContent(source);
    setSaveFailed(!result.persisted);
    if (after.adopt) {
      setAgentId(result.saved.id);
      loadedIdentityRef.current = result.saved.id;
      setSearchParams({ agentId: result.saved.id }, { replace: true });
    }
    return { id: after.id, persisted: result.persisted };
  }

  // Autosave waits for 700 ms without typing. Opening another agent in that time would drop the edit.
  function flushPendingEdit() {
    const edit = { buildable: readable.ok, content, saved: savedContent, agentId };
    if (!pendingEditToSave(edit, agentId !== null && findAgent(agentId) !== null)) return;
    if (!readable.ok) return;
    library.save({
      id: agentId ?? undefined,
      name: readable.metadata.name ?? "Untitled agent",
      description: readable.metadata.description ?? "",
      source: content,
      origin: originFor(received, content),
      confirmedTools: confirmed,
    });
  }

  const settledContent = useSettled(content, 700);
  const autosave = useEffectEvent((source: string) => persistToLibrary(source));
  useEffect(() => {
    if (!autosaveDue(settledContent, content, savedContent)) return;
    if (!buildableAgent(settledContent).ok) return;
    autosave(settledContent);
  }, [settledContent, content, savedContent]);

  function replaceWith(source: string) {
    flushPendingEdit();
    setContent(source);
    setSavedContent(source);
    setAgentId(null);
    setSearchParams({}, { replace: true });
    loadedIdentityRef.current = "blank";
    callbacks.current.clearAgent();
  }

  function startFrom(source: string, fromOutside: boolean) {
    setProvenance({ trusted: !fromOutside, confirmed: fromOutside ? [] : null, received: fromOutside ? source : null });
    replaceWith(source);
  }

  function startBlank() {
    setProvenance((current) => ({ ...current, confirmed: null, received: null }));
    replaceWith(EMPTY_TEMPLATE);
  }

  function openSaved(id: string) {
    setSearchParams({ agentId: id }, { replace: true });
  }

  function applyServer(next: string) {
    setContent(next);
    const saved = buildableAgent(next);
    updateConfirmed((current) => (current === null ? null : keepConfirmed(current, saved.ok ? saved.metadata : null)));
  }

  function setTrusted(next: string[]) {
    updateConfirmed(() => next);
    if (agentId !== null && readable.ok) persistToLibrary(content, next);
  }

  function trustRequested(serverId: string | undefined, name: string) {
    const key = trustKeyFor(readable.ok ? readable.metadata : null, serverId, name);
    if (key === null) return;
    setTrusted(withTrusted(confirmed, key));
  }

  return {
    content,
    setContent,
    readable,
    agentId,
    saveFailed,
    fileLoading,
    fileError,
    linkedFile,
    trusted,
    showTrust: !trusted && !fileLoading,
    fromSomeoneElse: confirmed !== null,
    missingAgent,
    dismissMissingAgent: () => setMissingAgent(null),
    trust: () => setProvenance((current) => ({ ...current, trusted: true })),
    confirmTools: (ticked: string[]) => updateConfirmed(() => ticked),
    confirmedTools: confirmed ?? undefined,
    persistToLibrary,
    startFrom,
    startBlank,
    openSaved,
    applyServer,
    setTrusted,
    trustRequested,
  };
}

export function useRecordedChat(agentId: string | null, agentName: string, source: string, state: ChatState) {
  const history = useHistory();
  const record = useEffectEvent((id: string) => {
    const existing = history.entries.find((entry) => entry.agentId === id);
    history.upsert({
      id: existing?.id ?? id,
      agentId: id,
      agentName,
      agentSource: source,
      messages: state.messages,
      tokenCount: state.usage?.totalTokens ?? 0,
      startedAt: existing?.startedAt ?? Date.now(),
      updatedAt: Date.now(),
    });
  });
  useEffect(() => {
    if (agentId === null || state.messages.length === 0) return;
    if (state.status === "streaming" || state.status === "connecting") return;
    record(agentId);
  }, [agentId, state.messages, state.status]);
}
