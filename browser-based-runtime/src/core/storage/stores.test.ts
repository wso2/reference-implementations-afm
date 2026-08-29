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

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findAgent,
  type HistoryEntry,
  loadAgents,
  loadJsonArray,
  loadText,
  mergeHistory,
  removeAgent,
  saveAgent,
  saveJson,
  saveText,
  withHistoryEntry,
  withImportedHistory,
  withoutAgentHistory,
} from "./stores";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

const blockedStorage = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
};

describe("local storage helpers", () => {
  beforeEach(() => vi.unstubAllGlobals());

  describe("loadText and saveText", () => {
    it("write a string and read it back", () => {
      vi.stubGlobal("localStorage", memoryStorage());
      expect(saveText("k", "v")).toBe(true);
      expect(loadText("k")).toBe("v");
    });

    it("read nothing for a key that was never written", () => {
      vi.stubGlobal("localStorage", memoryStorage());
      expect(loadText("missing")).toBeNull();
    });

    it("do not throw when the browser blocks site storage", () => {
      vi.stubGlobal("localStorage", blockedStorage);
      expect(loadText("k")).toBeNull();
      expect(saveText("k", "v")).toBe(false);
    });

    it("report a refused write, such as a full quota", () => {
      vi.stubGlobal("localStorage", {
        ...memoryStorage(),
        setItem: () => {
          throw new DOMException("full", "QuotaExceededError");
        },
      });
      expect(saveText("k", "v")).toBe(false);
    });
  });

  describe("loadJsonArray", () => {
    const isNumber = (value: unknown): value is number => typeof value === "number";

    it("reads a stored list", () => {
      vi.stubGlobal("localStorage", memoryStorage({ list: JSON.stringify([1, 2, 3]) }));
      expect(loadJsonArray("list", isNumber)).toEqual([1, 2, 3]);
    });

    it("keeps only the entries that have the expected shape", () => {
      vi.stubGlobal("localStorage", memoryStorage({ list: JSON.stringify([1, null, "2", 3, { a: 1 }]) }));
      expect(loadJsonArray("list", isNumber)).toEqual([1, 3]);
    });

    it.each([
      ["nothing stored", {}],
      ["corrupt text", { list: "{not json" }],
      ["something that is not a list", { list: JSON.stringify({ a: 1 }) }],
    ])("counts %s as empty", (_label, stored) => {
      vi.stubGlobal("localStorage", memoryStorage(stored));
      expect(loadJsonArray("list", isNumber)).toEqual([]);
    });

    it("counts blocked storage as empty", () => {
      vi.stubGlobal("localStorage", blockedStorage);
      expect(loadJsonArray("list", isNumber)).toEqual([]);
    });
  });

  describe("saveJson", () => {
    it("stores the value as JSON and says it landed", () => {
      const storage = memoryStorage();
      vi.stubGlobal("localStorage", storage);
      expect(saveJson("list", [{ a: 1 }])).toBe(true);
      expect(storage.map.get("list")).toBe('[{"a":1}]');
    });

    it("says so when the write is refused", () => {
      vi.stubGlobal("localStorage", blockedStorage);
      expect(saveJson("list", [1])).toBe(false);
    });

    it("says so for a value that cannot be written as JSON", () => {
      vi.stubGlobal("localStorage", memoryStorage());
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(saveJson("list", circular)).toBe(false);
    });
  });
});

const draft = (name: string, source = "---\nname: x\n---") => ({
  name,
  description: `${name} agent`,
  source,
  origin: "blank" as const,
  confirmedTools: null,
});

describe("the agents library", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", memoryStorage());
  });

  it("skips stored entries that are not agents instead of failing, and keeps an older saved agent", () => {
    const older = { id: "a0", name: "Old", source: "---\nname: old\n---", updatedAt: 1 };
    const valid = {
      id: "a1",
      name: "Scribe",
      description: "",
      source: "---\nname: x\n---",
      origin: "blank",
      confirmedTools: null,
      createdAt: 1,
      updatedAt: 2,
    };
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ "afm.agents.v1": JSON.stringify([null, 7, "text", { id: 1 }, valid, older]) }),
    );
    expect(loadAgents()).toEqual([valid, { ...older, origin: "import", confirmedTools: [] }]);
    expect(() => saveAgent(draft("Next"))).not.toThrow();
    expect(findAgent("a1")).toEqual(valid);
  });

  it("starts empty", () => {
    expect(loadAgents()).toEqual([]);
  });

  it("saves a new agent under a fresh id and reports that it landed", () => {
    const result = saveAgent(draft("Scribe"));
    expect(result.persisted).toBe(true);
    expect(result.saved).toMatchObject({ name: "Scribe", origin: "blank" });
    expect(result.saved.id).not.toBe("");
    expect(loadAgents()).toEqual([result.saved]);
  });

  it("keeps an agent from someone else marked as such, even with no tools confirmed, and marks one the person wrote as theirs", () => {
    const { id } = saveAgent({ ...draft("Shared"), confirmedTools: [] }).saved;
    expect(findAgent(id)?.confirmedTools).toEqual([]);
    expect(findAgent(saveAgent(draft("Mine")).saved.id)?.confirmedTools).toBeNull();
  });

  it("keeps the newest agent first", () => {
    saveAgent(draft("First"));
    const second = saveAgent(draft("Second")).saved;
    expect(loadAgents()[0]).toEqual(second);
    expect(loadAgents().map((agent) => agent.name)).toEqual(["Second", "First"]);
  });

  it("updates in place when an id is given, keeping what is not being changed", () => {
    const created = saveAgent(draft("Scribe")).saved;
    const updated = saveAgent({ ...draft("Scribe v2"), id: created.id }).saved;

    expect(loadAgents()).toHaveLength(1);
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe("Scribe v2");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it("finds an agent by id, and reports one that is gone", () => {
    const saved = saveAgent(draft("Scribe")).saved;
    expect(findAgent(saved.id)).toEqual(saved);
    expect(findAgent("missing")).toBeNull();
  });

  it("removes one agent and leaves the rest", () => {
    const keep = saveAgent(draft("Keep")).saved;
    const drop = saveAgent(draft("Drop")).saved;
    expect(removeAgent(drop.id)).toEqual([keep]);
    expect(loadAgents()).toEqual([keep]);
  });

  it("leaves an empty library when its last agent is removed", () => {
    const saved = saveAgent(draft("One")).saved;
    expect(removeAgent(saved.id)).toEqual([]);
    expect(loadAgents()).toEqual([]);
  });

  it("says so when the browser refuses the write, instead of pretending it was saved", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });
    expect(saveAgent(draft("Scribe")).persisted).toBe(false);
  });
});

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "h1",
    agentId: null,
    agentName: "Test",
    agentSource: "",
    messages: [],
    tokenCount: 0,
    startedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("mergeHistory", () => {
  it("sorts the merged result by recency descending", () => {
    const merged = mergeHistory(
      [entry({ id: "old", updatedAt: 100 })],
      [entry({ id: "new", updatedAt: 300 }), entry({ id: "mid", updatedAt: 200 })],
    );
    expect(merged.map((e) => e.id)).toEqual(["new", "mid", "old"]);
  });

  it("keeps the newer of two colliding entries by id", () => {
    const merged = mergeHistory(
      [entry({ id: "h1", tokenCount: 5, updatedAt: 100 })],
      [entry({ id: "h1", tokenCount: 99, updatedAt: 200 })],
    );
    expect(merged).toEqual([entry({ id: "h1", tokenCount: 99, updatedAt: 200 })]);
  });

  it("does not roll a newer conversation back during Undo", () => {
    const newer = entry({ updatedAt: 200, tokenCount: 99 });
    expect(mergeHistory([newer], [entry({ updatedAt: 100 })])).toEqual([newer]);
  });

  it("takes the imported entry on an equal timestamp", () => {
    const imported = entry({ tokenCount: 99 });
    expect(mergeHistory([entry()], [imported])).toEqual([imported]);
  });
});

describe("the conversations kept in memory", () => {
  it("adds a conversation", () => {
    expect(withHistoryEntry([], entry({ id: "c1", agentName: "Writer" })).map((e) => e.agentName)).toEqual(["Writer"]);
  });

  it("lists conversations newest first", () => {
    let entries: HistoryEntry[] = [];
    entries = withHistoryEntry(entries, entry({ id: "old", updatedAt: 100 }));
    entries = withHistoryEntry(entries, entry({ id: "new", updatedAt: 300 }));
    entries = withHistoryEntry(entries, entry({ id: "mid", updatedAt: 200 }));
    expect(entries.map((e) => e.id)).toEqual(["new", "mid", "old"]);
  });

  it("replaces a conversation rather than duplicating it", () => {
    const after = withHistoryEntry(
      [entry({ id: "c1", tokenCount: 1, updatedAt: 100 })],
      entry({ id: "c1", tokenCount: 2, updatedAt: 200 }),
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.tokenCount).toBe(2);
  });

  it("does not change the list it was given", () => {
    const before = [entry({ id: "c1" })];
    withHistoryEntry(before, entry({ id: "c2" }));
    withoutAgentHistory(before, "A");
    withImportedHistory(before, [entry({ id: "c3" })]);
    expect(before.map((e) => e.id)).toEqual(["c1"]);
  });

  it("removes every conversation of one agent and leaves the rest alone", () => {
    const keep = [entry({ id: "unassociated" }), entry({ id: "other", agentId: "B" })];
    const all = [...keep, entry({ id: "a1", agentId: "A" }), entry({ id: "a2", agentId: "A" })];
    expect(withoutAgentHistory(all, "A")).toEqual(keep);
    expect(withoutAgentHistory(keep, "missing")).toEqual(keep);
  });

  it("keeps only the newest 200 when saving", () => {
    const entries = Array.from({ length: 200 }, (_, index) => entry({ id: `c${index}`, updatedAt: index }));
    const saved = withHistoryEntry(entries, entry({ id: "latest", updatedAt: 500 }));
    expect(saved).toHaveLength(200);
    expect(saved[0]?.id).toBe("latest");
    expect(saved.some((e) => e.id === "c0")).toBe(false);
  });

  it("keeps only the newest 200 when restoring", () => {
    const imported = Array.from({ length: 201 }, (_, index) => entry({ id: `c${index}`, updatedAt: index }));
    const restored = withImportedHistory([], imported);
    expect(restored).toHaveLength(200);
    expect(restored[0]?.id).toBe("c200");
  });

  it("restores deleted conversations without disturbing the ones still there", () => {
    const still = entry({ id: "still", updatedAt: 300 });
    const restored = withImportedHistory([still], [entry({ id: "back", updatedAt: 100 })]);
    expect(restored.map((e) => e.id)).toEqual(["still", "back"]);
  });

  it("keeps a message's attached image", () => {
    const withImage = entry({
      id: "c1",
      messages: [
        { kind: "user", id: 1, text: "look", images: [{ name: "shot.png", mediaType: "image/png", data: "AAAA" }] },
      ],
    });
    expect(withHistoryEntry([], withImage)[0]?.messages[0]).toMatchObject({
      images: [{ name: "shot.png", data: "AAAA" }],
    });
  });

  it("never touches the browser's storage", () => {
    const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(), key: vi.fn(), length: 0 };
    const database = { open: vi.fn(), deleteDatabase: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("indexedDB", database);
    try {
      withImportedHistory(withoutAgentHistory(withHistoryEntry([], entry()), "A"), [entry({ id: "c2" })]);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(database.open).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("saved agents with a damaged list of confirmed tools", () => {
  const agent = (confirmedTools: unknown) => ({
    id: "a",
    name: "A",
    description: "",
    source: "x",
    createdAt: 1,
    updatedAt: 2,
    origin: "blank",
    confirmedTools,
  });

  beforeEach(() => vi.unstubAllGlobals());

  it("keep the agent and confirm nothing when the list is not a list", () => {
    vi.stubGlobal(
      "localStorage",
      memoryStorage({ "afm.agents.v1": JSON.stringify([agent("abc"), { ...agent(5), id: "b" }]) }),
    );
    expect(loadAgents().map((saved) => [saved.id, saved.confirmedTools])).toEqual([
      ["a", []],
      ["b", []],
    ]);
  });

  it("keep only the entries that are text", () => {
    vi.stubGlobal("localStorage", memoryStorage({ "afm.agents.v1": JSON.stringify([agent(["x", 1, null, "y"])]) }));
    expect(loadAgents()[0]?.confirmedTools).toEqual(["x", "y"]);
  });

  it("treat an agent saved with no mark at all as one from outside with nothing confirmed, because nobody can say who wrote it", () => {
    const { confirmedTools: _omitted, ...unmarked } = agent(undefined);
    vi.stubGlobal("localStorage", memoryStorage({ "afm.agents.v1": JSON.stringify([unmarked]) }));
    expect(loadAgents()[0]?.confirmedTools).toEqual([]);
    expect(loadAgents()[0]?.origin).toBe("import");
  });

  it("keep an agent marked as written by the person as theirs", () => {
    vi.stubGlobal("localStorage", memoryStorage({ "afm.agents.v1": JSON.stringify([agent(null)]) }));
    expect(loadAgents()[0]?.confirmedTools).toBeNull();
    expect(loadAgents()[0]?.origin).toBe("blank");
  });
});

describe("the mark saved with an agent", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("is written out for an agent the person wrote, so it is never mistaken for a missing one", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    saveAgent(draft("Mine"));
    expect(JSON.parse(storage.map.get("afm.agents.v1") ?? "[]")[0]).toHaveProperty("confirmedTools", null);
    expect(loadAgents()[0]?.confirmedTools).toBeNull();
  });

  it("is the list of confirmed tools for an agent from outside, even when it is empty", () => {
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    saveAgent({ ...draft("Shared"), confirmedTools: [] });
    saveAgent({ ...draft("Shared two"), confirmedTools: ["a"] });
    expect(loadAgents().map((saved) => saved.confirmedTools)).toEqual([["a"], []]);
  });

  it("changes from the person's own to a list, and back, only when the caller says so", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    const first = saveAgent(draft("A")).saved;
    expect(first.confirmedTools).toBeNull();
    saveAgent({ ...draft("A"), id: first.id, confirmedTools: ["x"] });
    expect(findAgent(first.id)?.confirmedTools).toEqual(["x"]);
  });
});
