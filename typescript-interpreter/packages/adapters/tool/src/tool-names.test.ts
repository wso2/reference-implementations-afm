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

import { describe, expect, it, vi } from "vitest";
import type { ToolCall, ToolDescriptor, ToolPort } from "@afm/engine";
import {
  MAX_TOOL_NAME_LENGTH,
  ToolNameError,
  displayToolName,
  namespacedToolName,
  namespacedToolPort,
  serverToolId,
} from "./tool-names";

const signal = () => new AbortController().signal;

function server(names: string[], extra: Partial<ToolDescriptor> = {}) {
  const executed: ToolCall[] = [];
  const dispose = vi.fn(async () => {});
  const port: ToolPort = {
    list: async () => names.map((name) => ({ name, description: `the ${name} tool`, inputSchema: { type: "object" }, serverId: "https://docs.example/mcp", ...extra })),
    execute: async (call) => {
      executed.push(call);
      return { ok: true, content: `ran ${call.name}` };
    },
    dispose,
  };
  return { port, executed, dispose };
}

describe("serverToolId", () => {
  it.each([
    ["docs", "docs"],
    ["my-docs", "my-docs"],
    ["My Docs", "My-Docs"],
    ["my_docs", "my-docs"],
    ["a.b/c", "a-b-c"],
    ["--docs--", "docs"],
    ["docs!!2", "docs-2"],
    ["", "server"],
    ["***", "server"],
  ])("turns %j into %j, with no underscore, so the first double underscore always ends it", (name, id) => {
    expect(serverToolId(name)).toBe(id);
  });
});

describe("namespacedToolName and displayToolName", () => {
  it("joins the server's id and the tool's own name with a double underscore", () => {
    expect(namespacedToolName("docs", "search_docs")).toBe("docs__search_docs");
    expect(namespacedToolName("My Docs", "get")).toBe("My-Docs__get");
  });

  it("gives back the tool's own name", () => {
    expect(displayToolName("docs__search_docs")).toBe("search_docs");
    expect(displayToolName("docs__a__b")).toBe("a__b");
  });

  it("leaves a built-in tool's name alone", () => {
    for (const name of ["list_files", "read_file", "search_files", "plain"]) expect(displayToolName(name)).toBe(name);
  });

  it("gives two different servers' tools different names even when the tools share a name", () => {
    expect(namespacedToolName("first", "search")).not.toBe(namespacedToolName("second", "search"));
  });

  it("never gives a different pair the same name", () => {
    const pairs = [["a", "b__c"], ["a-b", "c"], ["a", "_b"], ["a_", "b"], ["a", "b"]] as const;
    const names = pairs.map(([serverName, tool]) => namespacedToolName(serverName, tool));
    expect(new Set(names).size).toBe(pairs.length - 1);
  });
});

describe("namespacedToolPort", () => {
  it("offers each of the server's tools under its prefixed name, keeping everything else about it", async () => {
    const { port } = server(["search_docs"]);
    expect(await namespacedToolPort(port, "docs").list()).toEqual([
      {
        name: "docs__search_docs",
        description: "the search_docs tool",
        inputSchema: { type: "object" },
        serverId: "https://docs.example/mcp",
        serverName: "docs",
      },
    ]);
  });

  it("runs a call under the server's own name for the tool", async () => {
    const { port, executed } = server(["search_docs"]);
    const result = await namespacedToolPort(port, "docs").execute({ id: "1", name: "docs__search_docs", args: { q: "x" }, serverId: "https://docs.example/mcp" }, signal());
    expect(result).toEqual({ ok: true, content: "ran search_docs" });
    expect(executed).toEqual([{ id: "1", name: "search_docs", args: { q: "x" }, serverId: "https://docs.example/mcp" }]);
  });

  it("does not run a call for another server's name, or for no prefix at all", async () => {
    const { port, executed } = server(["search_docs"]);
    const wrapped = namespacedToolPort(port, "docs");
    for (const name of ["other__search_docs", "search_docs"]) {
      const result = await wrapped.execute({ id: "1", name, args: {} }, signal());
      expect(result).toEqual({ ok: false, content: `Unknown tool: ${name}` });
    }
    expect(executed).toEqual([]);
  });

  it("passes dispose on", async () => {
    const { port, dispose } = server([]);
    await namespacedToolPort(port, "docs").dispose?.();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("accepts a name of exactly the longest the providers allow", async () => {
    const tool = "t".repeat(MAX_TOOL_NAME_LENGTH - "docs__".length);
    const { port } = server([tool]);
    const [listed] = await namespacedToolPort(port, "docs").list();
    expect(listed?.name).toHaveLength(MAX_TOOL_NAME_LENGTH);
  });

  it("refuses a name one character too long, saying which server and tool, and does not shorten it", async () => {
    expect(MAX_TOOL_NAME_LENGTH).toBe(64);
    const tool = "t".repeat(MAX_TOOL_NAME_LENGTH - "docs__".length + 1);
    const { port } = server([tool]);
    const refusal = namespacedToolPort(port, "docs").list();
    await expect(refusal).rejects.toBeInstanceOf(ToolNameError);
    await expect(refusal).rejects.toThrow(new RegExp(`'${tool}'.*'docs'.*longer than the 64 characters`));
  });
});
