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

import { describe, it, expect, vi, afterEach } from "vitest";
import type { ServerMessage } from "../runtime/protocol";
import { createWorkerSecretStore } from "./worker-secret-store";

function setup() {
  const messages: ServerMessage[] = [];
  const store = createWorkerSecretStore((message) => void messages.push(message));
  const lastNames = () =>
    (messages.filter((m) => m.type === "secrets-list").at(-1) as { names: string[] } | undefined)?.names;
  return { store, messages, lastNames };
}

describe("the worker secret store", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("values held in memory", () => {
    it("returns what was set, and only that", () => {
      const { store } = setup();
      store.set("API_KEY", "sk-1");
      expect(store.valueOf("API_KEY")).toBe("sk-1");
      expect(store.valueOf("OTHER")).toBeUndefined();
    });

    it("ignores an empty value", () => {
      const { store } = setup();
      store.set("API_KEY", "");
      expect(store.valueOf("API_KEY")).toBeUndefined();
    });

    it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
      "does not mistake the built-in name %s for a saved secret",
      (name) => {
        const { store } = setup();
        expect(store.valueOf(name)).toBeUndefined();
        expect(store.refreshStore.get(name)).toBeNull();
        expect(store.approvedFor(name, "x.example")).toBe(false);
      },
    );

    it("tells the main thread which names it holds, never their values", () => {
      const { store, lastNames, messages } = setup();
      store.set("A", "secret-a");
      store.set("B", "secret-b");
      expect(lastNames()).toEqual(["A", "B"]);
      store.remove("A");
      expect(lastNames()).toEqual(["B"]);
      expect(JSON.stringify(messages)).not.toContain("secret-");
    });

    it("backs an OAuth refresh token through the same store", () => {
      const { store, lastNames } = setup();
      store.refreshStore.set("afm.oauth.x.refresh", "rt-1");
      expect(store.refreshStore.get("afm.oauth.x.refresh")).toBe("rt-1");
      expect(lastNames()).toEqual(["afm.oauth.x.refresh"]);
      store.refreshStore.remove("afm.oauth.x.refresh");
      expect(store.refreshStore.get("afm.oauth.x.refresh")).toBeNull();
    });
  });

  describe("memory only", () => {
    it("never touches browser storage, so a reload or a closed tab loses every value", () => {
      const refuse = () => {
        throw new Error("browser storage must not be used");
      };
      vi.stubGlobal("indexedDB", { open: refuse });
      vi.stubGlobal("localStorage", { getItem: refuse, setItem: refuse, removeItem: refuse });
      const { store } = setup();
      store.set("API_KEY", "sk-1", "https://api.example/mcp");
      store.refreshStore.set("afm.oauth.x.refresh", "rt-1");
      expect(store.valueOf("API_KEY")).toBe("sk-1");
      expect(store.refreshStore.get("afm.oauth.x.refresh")).toBe("rt-1");
      expect(setup().store.refreshStore.get("afm.oauth.x.refresh")).toBeNull();
    });
  });

  describe("the addresses a value was entered for", () => {
    it("approves a value only for the address it was entered for", () => {
      const { store } = setup();
      store.set("HF_TOKEN", "hf_1", "https://huggingface.co/mcp");
      expect(store.approvedFor("HF_TOKEN", "https://huggingface.co/mcp")).toBe(true);
      expect(store.approvedFor("HF_TOKEN", "https://huggingface.co/other")).toBe(false);
      expect(store.approvedFor("HF_TOKEN", "https://attacker.example/mcp")).toBe(false);
      expect(store.approvedFor("HF_TOKEN", undefined)).toBe(false);
    });

    it("approves no address for a value entered without one, such as the model key", () => {
      const { store } = setup();
      store.set("OPENAI_API_KEY", "sk-1");
      expect(store.approvedFor("OPENAI_API_KEY", "https://huggingface.co/mcp")).toBe(false);
    });

    it("forgets the old addresses when the value is entered again for another", () => {
      const { store } = setup();
      store.set("TOKEN", "one", "https://a.example/mcp");
      store.set("TOKEN", "two", "https://b.example/mcp");
      expect(store.approvedFor("TOKEN", "https://a.example/mcp")).toBe(false);
      expect(store.approvedFor("TOKEN", "https://b.example/mcp")).toBe(true);
    });

    it("forgets them when the value is removed", () => {
      const { store } = setup();
      store.set("TOKEN", "one", "https://a.example/mcp");
      store.remove("TOKEN");
      expect(store.approvedFor("TOKEN", "https://a.example/mcp")).toBe(false);
    });
  });

  describe("keys entered for the model", () => {
    it("counts only a value entered without an address as a model key", () => {
      const { store } = setup();
      store.set("OPENAI_API_KEY", "sk-1", undefined, "openai");
      store.set("TOOL_TOKEN", "t-1", "https://docs.example/mcp");
      store.refreshStore.set("afm.oauth.x.refresh", "rt-1");
      expect(store.enteredForModel("OPENAI_API_KEY", "openai")).toBe(true);
      expect(store.enteredForModel("TOOL_TOKEN", "openai")).toBe(false);
      expect(store.enteredForModel("afm.oauth.x.refresh", "openai")).toBe(false);
      expect(store.enteredForModel("MISSING", "openai")).toBe(false);
    });

    it("belongs to the provider it was entered for, and to no other", () => {
      const { store } = setup();
      store.set("OPENAI_API_KEY", "sk-1", undefined, "openai");
      expect(store.enteredForModel("OPENAI_API_KEY", "anthropic")).toBe(false);
    });

    it("is not a model key when it was entered without saying which provider it is for", () => {
      const { store } = setup();
      store.set("KEY", "sk-1");
      expect(store.enteredForModel("KEY", "openai")).toBe(false);
    });

    it("forgets the provider when the same name is entered again for a tool server or removed", () => {
      const { store } = setup();
      store.set("KEY", "sk-1", undefined, "openai");
      store.set("KEY", "t-1", "https://docs.example/mcp");
      expect(store.enteredForModel("KEY", "openai")).toBe(false);
      store.set("KEY", "sk-2", undefined, "openai");
      store.remove("KEY");
      expect(store.enteredForModel("KEY", "openai")).toBe(false);
    });
  });
});
