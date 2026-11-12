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

import { type AgentOrigin, findAgent, type SavedAgent } from "../storage/stores";
import { decodeInlineAfm, inlineAfmParam } from "./load-paths";

export const EMPTY_TEMPLATE = `---
name: New Agent
interfaces:
  - type: webchat
---

# Role

# Instructions
`;

export interface Opening {
  draft: string | undefined;
  file: string | null;
  agentId: string | null;
  saved: SavedAgent | null;
  inline: string | null;
  decoded: string | null;
}

function decodedOrNull(encoded: string): string | null {
  try {
    return decodeInlineAfm(encoded);
  } catch {
    return null;
  }
}

export function openingOf(searchParams: URLSearchParams, hash: string, draftSource: string | undefined): Opening {
  const agentId = searchParams.get("agentId");
  const inline = inlineAfmParam(hash);
  return {
    draft: draftSource,
    file: searchParams.get("file"),
    agentId,
    saved: agentId === null ? null : findAgent(agentId),
    inline,
    decoded: inline === null ? null : decodedOrNull(inline),
  };
}

export function initialContent(opening: Opening): string {
  return opening.draft ?? opening.saved?.source ?? opening.decoded ?? EMPTY_TEMPLATE;
}

export function missingAgentId(opening: Opening): string | null {
  const { draft, agentId, saved, file, decoded } = opening;
  return draft === undefined && agentId !== null && saved === null && file === null && decoded === null ? agentId : null;
}

export function missingAgentNotice(agentId: string): string {
  return agentId === "" ? "Agent not found." : `Agent not found \`${agentId}\`.`;
}

export function autosaveDue(settled: string, current: string, saved: string): boolean {
  return settled === current && settled !== saved;
}

// What the workspace does after a save. A save that did not reach storage gives the draft no id and no address:
// nothing could open that id again, so the draft would be taken for a missing agent.
export function afterSave(
  agentId: string | null,
  result: { saved: { id: string }; persisted: boolean },
): { id: string | null; adopt: boolean } {
  return { id: result.persisted ? result.saved.id : agentId, adopt: result.persisted && agentId === null };
}

// An edit that autosave has not reached yet must be saved before the document is replaced by another one.
// An agent that was removed in the meantime stays removed.
export function pendingEditToSave(
  edit: { buildable: boolean; content: string; saved: string; agentId: string | null },
  stillInLibrary: boolean,
): boolean {
  if (!edit.buildable || edit.content === edit.saved) return false;
  return edit.agentId === null || stillInLibrary;
}

export function openedFromLink(opening: Opening): boolean {
  return opening.draft === undefined && (opening.file !== null || opening.inline !== null);
}

export function initialConfirmed(opening: Opening): string[] | null {
  if (openedFromLink(opening)) return [];
  if (opening.draft !== undefined || opening.agentId === null) return null;
  return opening.saved?.confirmedTools ?? null;
}

export function identityFor(opening: Opening): string {
  if (opening.draft !== undefined) return `draft:${opening.draft}`;
  if (opening.file !== null) return `file:${opening.file}`;
  return opening.agentId ?? opening.inline ?? "blank";
}

export function receivedSource(opening: Opening): string | null {
  if (opening.draft !== undefined) return null;
  if (opening.saved !== null) return opening.saved.origin === "import" ? opening.saved.source : null;
  return opening.decoded;
}

export function originFor(received: string | null, source: string): AgentOrigin {
  return received !== null && source === received ? "import" : "blank";
}

export function shownIcon(trusted: boolean, iconUrl: string | undefined): string {
  return trusted ? (iconUrl ?? "") : "";
}
