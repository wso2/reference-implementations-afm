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

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EMPTY_TEMPLATE,
  autosaveDue,
  identityFor,
  initialConfirmed,
  initialContent,
  missingAgentId,
  missingAgentNotice,
  openedFromLink,
  openingOf,
  originFor,
  receivedSource,
  shownIcon,
  afterSave,
  pendingEditToSave,
} from "./workspace-content";
import { encodeInlineAfm } from "./load-paths";
import { previewAgent } from "../agent/agent-validation";

const AGENT_SOURCE = "---\nname: Saved\n---\n\n# Role\nr\n\n# Instructions\ni\n";

function storageHolding(agents: unknown[]) {
  const map = new Map([["afm.agents.v1", JSON.stringify(agents)]]);
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

const params = (query: string) => new URLSearchParams(query);

describe("initialContent", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "localStorage",
      storageHolding([
        { id: "a1", name: "Saved", description: "", source: AGENT_SOURCE, createdAt: 1, updatedAt: 1, origin: "blank" },
      ]),
    );
  });

  it("starts from a draft when one is handed over", () => {
    expect(initialContent(openingOf(params("agentId=a1"), "", "draft text"))).toBe("draft text");
  });

  it("opens a saved agent by its id", () => {
    expect(initialContent(openingOf(params("agentId=a1"), "", undefined))).toBe(AGENT_SOURCE);
  });

  it("opens an agent carried in a share link's fragment", () => {
    const encoded = encodeInlineAfm(AGENT_SOURCE);
    expect(initialContent(openingOf(params(""), `#afm=${encoded}`, undefined))).toBe(AGENT_SOURCE);
  });

  it("does not read an agent from the query, only from the fragment", () => {
    const encoded = encodeInlineAfm(AGENT_SOURCE);
    expect(initialContent(openingOf(params(`afm=${encoded}`), "", undefined))).toBe(EMPTY_TEMPLATE);
  });

  it("falls back to the empty template for an id that is not in the library", () => {
    expect(initialContent(openingOf(params("agentId=gone"), "", undefined))).toBe(EMPTY_TEMPLATE);
  });

  it("falls back to the empty template for a share link that cannot be decoded", () => {
    expect(initialContent(openingOf(params(""), "#afm=%%%not-base64", undefined))).toBe(EMPTY_TEMPLATE);
  });

  it("gives the empty template when there is nothing to open", () => {
    expect(initialContent(openingOf(params(""), "", undefined))).toBe(EMPTY_TEMPLATE);
  });

  it.each(["agentId=", "agentId=missing", "code=fixture&state=fixture"])(
    "does not recover an absent saved agent from %s",
    (query) => {
      const search = params(query);
      const before = search.toString();
      expect(initialContent(openingOf(search, "", undefined))).toBe(EMPTY_TEMPLATE);
      expect(search.toString()).toBe(before);
    },
  );

  it.each(["agentId=a1&agentId=missing", "agentId=a1&code=fixture&state=fixture&keep=1&keep=2"])(
    "opens the first saved id without rewriting %s",
    (query) => {
      const search = params(query);
      const before = search.toString();
      expect(initialContent(openingOf(search, "", undefined))).toBe(AGENT_SOURCE);
      expect(search.toString()).toBe(before);
    },
  );

  it("prefers a saved agent over inline content, but falls back to inline content for a missing id", () => {
    const hash = `#afm=${encodeInlineAfm("inline source")}`;
    expect(initialContent(openingOf(params("agentId=a1"), hash, undefined))).toBe(AGENT_SOURCE);
    expect(initialContent(openingOf(params("agentId=missing"), hash, undefined))).toBe("inline source");
  });

  it("preserves an explicitly empty draft instead of falling back to the URL", () => {
    expect(initialContent(openingOf(params("agentId=a1"), `#afm=${encodeInlineAfm(AGENT_SOURCE)}`, ""))).toBe("");
  });

  it("leaves remote fetching to the effect rather than changing initial content", () => {
    expect(initialContent(openingOf(params("file=https://example.test/agent.afm.md&agentId=a1"), "", undefined))).toBe(
      AGENT_SOURCE,
    );
    expect(initialContent(openingOf(params("file=https://example.test/agent.afm.md"), "", undefined))).toBe(
      EMPTY_TEMPLATE,
    );
  });
});

describe("EMPTY_TEMPLATE", () => {
  it("is a valid file except for the two sections left for the person to write", () => {
    const preview = previewAgent(EMPTY_TEMPLATE);
    expect(preview.ok).toBe(false);
    expect(preview.ok ? "" : preview.error).toMatch(/Role/);
  });

  it("names no model, so the person chooses one", () => {
    expect(EMPTY_TEMPLATE).not.toMatch(/^model:/m);
    expect(EMPTY_TEMPLATE).not.toContain("openai");
  });
});

describe("openedFromLink", () => {
  it("is true for a share link and for a ?file= link", () => {
    expect(openedFromLink(openingOf(params(""), "#afm=zzz", undefined))).toBe(true);
    expect(openedFromLink(openingOf(params("file=https://x/y.afm.md"), "", undefined))).toBe(true);
  });

  it("is false for the library, a blank start and a draft", () => {
    expect(openedFromLink(openingOf(params("agentId=a1"), "", undefined))).toBe(false);
    expect(openedFromLink(openingOf(params(""), "", undefined))).toBe(false);
    expect(openedFromLink(openingOf(params("file=https://x/y.afm.md"), "#afm=zzz", "draft text"))).toBe(false);
  });

  it("stays true when a link also names a saved agent, since the agent may be missing and the link's file is what opens", () => {
    expect(openedFromLink(openingOf(params("agentId=a1"), "#afm=zzz", undefined))).toBe(true);
  });

  it("ignores callback parameters", () => {
    expect(openedFromLink(openingOf(params("code=fixture&state=fixture"), "", undefined))).toBe(false);
  });
});

describe("identityFor", () => {
  it("tells one agent from another, so a real change reloads and an edit does not", () => {
    expect(identityFor(openingOf(params(""), "", "abc"))).toBe("draft:abc");
    expect(identityFor(openingOf(params("file=https://x/y.afm.md"), "", undefined))).toBe("file:https://x/y.afm.md");
    expect(identityFor(openingOf(params("agentId=a1"), "", undefined))).toBe("a1");
    expect(identityFor(openingOf(params(""), "#afm=zzz", undefined))).toBe("zzz");
    expect(identityFor(openingOf(params(""), "", undefined))).toBe("blank");
  });

  it("orders identity by draft, remote file, saved id, then inline content", () => {
    const search = params("file=https://example.test/a&agentId=a1");
    expect(identityFor(openingOf(search, "#afm=fragment", ""))).toBe("draft:");
    expect(identityFor(openingOf(search, "#afm=fragment", undefined))).toBe("file:https://example.test/a");
    expect(identityFor(openingOf(params("agentId=a1"), "#afm=fragment", undefined))).toBe("a1");
    expect(identityFor(openingOf(params(""), "#afm=fragment", undefined))).toBe("fragment");
  });

  it("distinguishes an empty id from no id and ignores callback parameters", () => {
    expect(identityFor(openingOf(params("agentId=&code=fixture&state=fixture"), "", undefined))).toBe("");
    expect(identityFor(openingOf(params("code=fixture&state=fixture"), "", undefined))).toBe("blank");
    expect(identityFor(openingOf(params("agentId=a1&agentId=a2&code=fixture&state=fixture"), "", undefined))).toBe(
      "a1",
    );
  });
});

describe("autosaveDue", () => {
  it("is due once typing has settled on text that is not saved yet", () => {
    expect(autosaveDue("new text", "new text", "old text")).toBe(true);
  });

  it("is not due while the settled text is still catching up with what was typed", () => {
    expect(autosaveDue("old text", "new text", "older text")).toBe(false);
  });

  it("is not due when the settled text is already saved", () => {
    expect(autosaveDue("same", "same", "same")).toBe(false);
  });

  it("never saves the previous agent under a new one that was just started", () => {
    expect(autosaveDue("previous agent", EMPTY_TEMPLATE, EMPTY_TEMPLATE)).toBe(false);
  });
});

describe("a link to an agent that is not saved here", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "localStorage",
      storageHolding([
        { id: "a1", name: "Saved", description: "", source: AGENT_SOURCE, createdAt: 1, updatedAt: 1, origin: "blank" },
      ]),
    );
  });

  it("names the id that was not found", () => {
    expect(missingAgentId(openingOf(params("agentId=nope"), "", undefined))).toBe("nope");
    expect(missingAgentId(openingOf(params("agentId="), "", undefined))).toBe("");
  });

  it("finds nothing missing when the agent is saved, or there is no agent id", () => {
    expect(missingAgentId(openingOf(params("agentId=a1"), "", undefined))).toBeNull();
    expect(missingAgentId(openingOf(params(""), "", undefined))).toBeNull();
    expect(missingAgentId(openingOf(params("view=chat"), "", undefined))).toBeNull();
  });

  it("finds nothing missing when the page opens something else", () => {
    const encoded = encodeInlineAfm(AGENT_SOURCE);
    expect(missingAgentId(openingOf(params("agentId=nope"), "", "draft text"))).toBeNull();
    expect(
      missingAgentId(openingOf(params("agentId=nope&file=https%3A%2F%2Fx.test%2Fa.afm.md"), "", undefined)),
    ).toBeNull();
    expect(missingAgentId(openingOf(params("agentId=nope"), `#afm=${encoded}`, undefined))).toBeNull();
  });

  it("still says the agent is missing when the shared text next to it cannot be read", () => {
    expect(missingAgentId(openingOf(params("agentId=nope"), "#afm=!!!not-readable!!!", undefined))).toBe("nope");
  });

  it("says it as a plain statement", () => {
    expect(missingAgentNotice("nope")).toBe("Agent not found `nope`.");
    expect(missingAgentNotice("")).toBe("Agent not found.");
  });
});

describe("shownIcon", () => {
  it("is empty while the agent has not been trusted, so the icon's host is not asked", () => {
    expect(shownIcon(false, "https://icons.example.com/a.png")).toBe("");
  });

  it("is the icon address once the agent is trusted", () => {
    expect(shownIcon(true, "https://icons.example.com/a.png")).toBe("https://icons.example.com/a.png");
  });

  it("is empty when the file names no icon", () => {
    expect(shownIcon(true, undefined)).toBe("");
  });
});

describe("initialConfirmed", () => {
  const saved = (id: string, confirmedTools?: unknown) => ({
    id,
    name: id,
    description: "",
    source: AGENT_SOURCE,
    createdAt: 1,
    updatedAt: 1,
    origin: "blank",
    ...(confirmedTools === undefined ? {} : { confirmedTools }),
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "localStorage",
      storageHolding([saved("mine", null), saved("shared", ["x"]), saved("none-yet", []), saved("unmarked")]),
    );
  });

  it("trusts the tool list of an agent saved as written by the person", () => {
    expect(initialConfirmed(openingOf(params("agentId=mine"), "", undefined))).toBeNull();
  });

  it("confirms only the tools saved for an agent from outside", () => {
    expect(initialConfirmed(openingOf(params("agentId=shared"), "", undefined))).toEqual(["x"]);
    expect(initialConfirmed(openingOf(params("agentId=none-yet"), "", undefined))).toEqual([]);
  });

  it("confirms nothing for a saved agent that carries no mark, because nobody can say who wrote it", () => {
    expect(initialConfirmed(openingOf(params("agentId=unmarked"), "", undefined))).toEqual([]);
  });

  it("confirms nothing for a link or a file, and trusts a blank agent or a draft", () => {
    expect(initialConfirmed(openingOf(params("file=https://x.example/a.afm.md"), "", undefined))).toEqual([]);
    expect(initialConfirmed(openingOf(params(""), "#afm=abc", undefined))).toEqual([]);
    expect(initialConfirmed(openingOf(params(""), "", undefined))).toBeNull();
    expect(initialConfirmed(openingOf(params(""), "", "draft"))).toBeNull();
  });

  it("trusts an agent id that is not in the library, because that opens a blank agent", () => {
    expect(initialConfirmed(openingOf(params("agentId=gone"), "", undefined))).toBeNull();
  });
});

describe("receivedSource and originFor", () => {
  const stored = (origin: string, source = AGENT_SOURCE) => ({
    id: "a1",
    name: "Saved",
    description: "",
    source,
    createdAt: 1,
    updatedAt: 1,
    origin,
    confirmedTools: origin === "import" ? [] : null,
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", storageHolding([stored("import"), { ...stored("blank"), id: "b1" }]));
  });

  it("is the text of a link, as it arrived", () => {
    const text = "---\nname: Linked\n---\n\n# Role\nr\n\n# Instructions\ni\n";
    expect(receivedSource(openingOf(params(""), `#afm=${encodeInlineAfm(text)}`, undefined))).toBe(text);
  });

  it("is nothing for a link that cannot be read, a file that has not arrived yet, a draft or a blank agent", () => {
    expect(receivedSource(openingOf(params(""), "#afm=%%%", undefined))).toBeNull();
    expect(receivedSource(openingOf(params("file=https://x.example/a.afm.md"), "", undefined))).toBeNull();
    expect(receivedSource(openingOf(params(""), "", "draft"))).toBeNull();
    expect(receivedSource(openingOf(params(""), "", undefined))).toBeNull();
  });

  it("is the saved text of a shared agent in the library, and nothing for one the person wrote", () => {
    expect(receivedSource(openingOf(params("agentId=a1"), "", undefined))).toBe(AGENT_SOURCE);
    expect(receivedSource(openingOf(params("agentId=b1"), "", undefined))).toBeNull();
  });

  it("calls an agent shared while its text is as it arrived, and the person's own once it has changed", () => {
    expect(originFor("text", "text")).toBe("import");
    expect(originFor("text", "text, edited")).toBe("blank");
    expect(originFor(null, "text")).toBe("blank");
  });
});

describe("what the workspace does after a save", () => {
  const saved = { id: "new-id" };

  it("takes the id of a new agent that was stored", () => {
    expect(afterSave(null, { saved, persisted: true })).toEqual({ id: "new-id", adopt: true });
  });

  it("keeps the id of an agent that was stored again", () => {
    expect(afterSave("old-id", { saved: { id: "old-id" }, persisted: true })).toEqual({ id: "old-id", adopt: false });
  });

  it("gives a new draft no id when it could not be stored, so its address is not opened as a missing agent", () => {
    expect(afterSave(null, { saved, persisted: false })).toEqual({ id: null, adopt: false });
  });

  it("keeps the id of a stored agent when saving it again failed", () => {
    expect(afterSave("old-id", { saved: { id: "old-id" }, persisted: false })).toEqual({ id: "old-id", adopt: false });
  });
});

describe("an edit that autosave has not saved yet", () => {
  const edit = { buildable: true, content: "new", saved: "old", agentId: "a" };

  it("is saved before another agent replaces it", () => {
    expect(pendingEditToSave(edit, true)).toBe(true);
    expect(pendingEditToSave({ ...edit, agentId: null }, false)).toBe(true);
  });

  it("is not saved when nothing changed", () => {
    expect(pendingEditToSave({ ...edit, content: "old" }, true)).toBe(false);
  });

  it("is not saved when the file cannot be built, as autosave would not save it", () => {
    expect(pendingEditToSave({ ...edit, buildable: false }, true)).toBe(false);
  });

  it("does not bring back an agent that was removed", () => {
    expect(pendingEditToSave(edit, false)).toBe(false);
  });
});
