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

import type { ToolCall, ToolDescriptor, ToolPort, ToolResult } from "@afm/engine";
import { describe, expect, it, vi } from "vitest";
import {
  compositeToolPort,
  displayToolName,
  filteredToolPort,
  type InPageTool,
  inPageToolPort,
  lazy,
  MAX_TOOL_NAME_LENGTH,
  namespacedToolName,
  namespacedToolPort,
  serverToolId,
  ToolNameError,
} from "./tool-ports";

describe("lazy", () => {
  it("loads nothing until the first get", () => {
    const load = vi.fn(async () => "value");
    lazy(load);
    expect(load).not.toHaveBeenCalled();
  });

  it("loads once and hands every caller the same result", async () => {
    const load = vi.fn(async () => ({}));
    const held = lazy(load);
    const [first, second] = await Promise.all([held.get(), held.get()]);
    expect(first).toBe(second);
    expect(await held.get()).toBe(first);
    expect(load).toHaveBeenCalledOnce();
  });

  it("forgets a failed load, so the next get tries again", async () => {
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("down")).mockResolvedValue("up");
    const held = lazy(load);
    await expect(held.get()).rejects.toThrow("down");
    expect(await held.get()).toBe("up");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("gives back what it held when discarded, and loads afresh afterwards", async () => {
    let count = 0;
    const held = lazy(async () => ++count);
    expect(await held.get()).toBe(1);
    expect(await held.discard()).toBe(1);
    expect(await held.get()).toBe(2);
  });

  it("has nothing to give back when nothing was loaded", () => {
    expect(lazy(async () => 1).discard()).toBeNull();
  });

  it("does not let a discarded load that fails forget the newer one", async () => {
    let rejectFirst = (_error: Error): void => {};
    const loads = [new Promise<string>((_resolve, reject) => (rejectFirst = reject)), Promise.resolve("second")];
    const held = lazy(() => loads.shift()!);
    const first = held.get();
    first.catch(() => undefined);
    held.discard();
    expect(await held.get()).toBe("second");
    rejectFirst(new Error("late"));
    await expect(first).rejects.toThrow("late");
    expect(await held.get()).toBe("second");
  });
});

const signal = () => new AbortController().signal;

function server(names: string[], extra: Partial<ToolDescriptor> = {}) {
  const executed: ToolCall[] = [];
  const dispose = vi.fn(async () => {});
  const port: ToolPort = {
    list: async () =>
      names.map((name) => ({
        name,
        description: `the ${name} tool`,
        inputSchema: { type: "object" },
        serverId: "https://docs.example/mcp",
        ...extra,
      })),
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
    const call = { id: "1", name: "docs__search_docs", args: { q: "x" }, serverId: "https://docs.example/mcp" };
    const result = await namespacedToolPort(port, "docs").execute(call, signal());
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

  it("leaves out a tool whose name the providers would reject, and keeps the server's other tools", async () => {
    const { port } = server(["search_docs", "files.read", "a/b", "with space", "naïve", "keep-this_one", "UPPER9"]);
    const listed = await namespacedToolPort(port, "docs").list();
    expect(listed.map((tool) => tool.name)).toEqual(["docs__search_docs", "docs__keep-this_one", "docs__UPPER9"]);
  });

  it("still refuses a name that is too long, even when it also has an unusable character", async () => {
    const { port } = server(["x.".repeat(MAX_TOOL_NAME_LENGTH)]);
    await expect(namespacedToolPort(port, "docs").list()).rejects.toThrow(ToolNameError);
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

const call = (name: string, args: unknown = {}): ToolCall => ({ id: "c1", name, args });

function fakePort(label: string, names: string[]): ToolPort {
  const descriptors: ToolDescriptor[] = names.map((name) => ({ name, inputSchema: {} }));
  return {
    list: () => Promise.resolve(descriptors),
    execute: (c: ToolCall): Promise<ToolResult> =>
      Promise.resolve({ ok: true, content: `${label}:${c.name}` }),
  };
}

describe("compositeToolPort", () => {
  it("concatenates the tool lists of every child", async () => {
    const port = compositeToolPort([fakePort("a", ["add"]), fakePort("b", ["search"])]);
    const names = (await port.list()).map((t) => t.name);
    expect(names).toEqual(["add", "search"]);
  });

  it("routes execute() to the child that owns the tool name", async () => {
    const port = compositeToolPort([fakePort("a", ["add"]), fakePort("b", ["search"])]);
    expect(await port.execute(call("search"), signal())).toEqual({ ok: true, content: "b:search" });
  });

  describe("two tools with the same name", () => {
    const named = (serverName: string, name: string): ToolPort => ({
      list: () => Promise.resolve([{ name, inputSchema: {}, serverName, serverId: `https://${serverName}.example/mcp` }]),
      execute: () => Promise.resolve({ ok: true, content: serverName }),
    });

    it("are refused, naming both servers and the tool", async () => {
      const port = compositeToolPort([named("a_b", "x__search"), named("a-b", "x__search")]);
      const refusal = port.list();
      await expect(refusal).rejects.toBeInstanceOf(ToolNameError);
      await expect(refusal).rejects.toThrow(/'a_b' and 'a-b'.*'search'.*'x__search'/);
    });

    it("are refused even when another source could not be loaded", async () => {
      const broken: ToolPort = { list: () => Promise.reject(new Error("unreachable")), execute: () => Promise.resolve({ ok: false, content: "" }) };
      const port = compositeToolPort([broken, named("a", "dup"), named("b", "dup")]);
      await expect(port.list()).rejects.toBeInstanceOf(ToolNameError);
    });

    it("are refused when one server lists a tool twice, saying so", async () => {
      const twice: ToolPort = {
        list: () => Promise.resolve([{ name: "x__a", inputSchema: {}, serverName: "x" }, { name: "x__a", inputSchema: {}, serverName: "x" }]),
        execute: () => Promise.resolve({ ok: true, content: "" }),
      };
      await expect(compositeToolPort([twice]).list()).rejects.toThrow(/'x'.*'a'.*more than once/);
    });

    it("are refused when a server's tool takes a built-in tool's name", async () => {
      const port = compositeToolPort([named("evil", "read_file"), named("files", "read_file")]);
      await expect(port.list()).rejects.toBeInstanceOf(ToolNameError);
    });
  });

  it("returns a failed result for a tool no child owns", async () => {
    const port = compositeToolPort([fakePort("a", ["add"])]);
    const res = await port.execute(call("nope"), signal());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/Unknown tool/);
  });

  it("an empty set of ports lists nothing", async () => {
    expect(await compositeToolPort([]).list()).toEqual([]);
  });

  it("caches listing across calls (children listed once)", async () => {
    const child = fakePort("a", ["add"]);
    const listSpy = vi.spyOn(child, "list");
    const port = compositeToolPort([child]);
    await port.list();
    await port.execute(call("add"), signal());
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it("dispose() disposes every child that has a dispose method", async () => {
    const disposed: string[] = [];
    const child = (label: string): ToolPort => ({
      list: () => Promise.resolve([]),
      execute: () => Promise.resolve({ ok: true, content: "" }),
      dispose: () => Promise.resolve(void disposed.push(label)),
    });
    await compositeToolPort([child("a"), child("b"), fakePort("c", ["x"])]).dispose?.();
    expect(disposed.sort()).toEqual(["a", "b"]);
  });

  it("does not cache a failed listing (retries next call)", async () => {
    let attempt = 0;
    const flaky: ToolPort = {
      list: () => {
        attempt += 1;
        return attempt === 1 ? Promise.reject(new Error("server down")) : Promise.resolve([]);
      },
      execute: () => Promise.resolve({ ok: true, content: "" }),
    };
    const port = compositeToolPort([flaky]);
    await expect(port.list()).rejects.toThrow("server down");
    await expect(port.list()).resolves.toEqual([]);
    expect(attempt).toBe(2);
  });
});

describe("a composite port that is disposed while its tools are being listed", () => {
  function gatedPort(label: string, names: string[]) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const inner = fakePort(label, names);
    const listed = vi.fn(async () => {
      await gate;
      return inner.list();
    });
    return { port: { ...inner, list: listed } as ToolPort, release, listed };
  }

  it("does not ask the sources after the one it was waiting for", async () => {
    const first = gatedPort("first", ["a"]);
    const second = fakePort("second", ["b"]);
    const secondList = vi.spyOn(second, "list");
    const composite = compositeToolPort([first.port, second]);
    const listing = composite.list();
    await vi.waitFor(() => expect(first.listed).toHaveBeenCalled());
    await composite.dispose?.();
    first.release();
    await listing;
    expect(secondList).not.toHaveBeenCalled();
  });

  it("lists every source again when it is used after being disposed", async () => {
    const first = fakePort("first", ["a"]);
    const second = fakePort("second", ["b"]);
    const composite = compositeToolPort([first, second]);
    await composite.list();
    await composite.dispose?.();
    expect(await names(composite)).toEqual(["a", "b"]);
  });
});

describe("a tool source that fails", () => {
  const failing: ToolPort = {
    async list() {
      throw new Error("server unreachable");
    },
    async execute() {
      return { ok: false, content: "never" };
    },
  };

  it("keeps the tools from every source that did work", async () => {
    const working = inPageToolPort([
      { name: "alpha", inputSchema: { type: "object" }, run: () => "a" },
    ]);
    const port = compositeToolPort([failing, working]);

    expect((await port.list()).map((tool) => tool.name)).toEqual(["alpha"]);
    expect(await port.execute({ id: "1", name: "alpha", args: {} }, new AbortController().signal)).toEqual({
      ok: true,
      content: "a",
    });
  });

  it("still reports the reason when nothing at all could be loaded", async () => {
    const port = compositeToolPort([failing]);
    await expect(port.list()).rejects.toThrow(/server unreachable/);
  });
});

function mathPort(): ToolPort {
  const tools: ToolDescriptor[] = ["add", "multiply", "power"].map((name) => ({ name, inputSchema: {} }));
  return {
    list: () => Promise.resolve(tools),
    execute: (c: ToolCall): Promise<ToolResult> => Promise.resolve({ ok: true, content: `ran:${c.name}` }),
  };
}

const names = async (p: ToolPort) => (await p.list()).map((t) => t.name);

describe("filteredToolPort", () => {
  it("allow = whitelist (only listed tools, intersected with what exists)", async () => {
    const p = filteredToolPort(mathPort(), { allow: ["add", "multiply", "nonexistent"] });
    expect(await names(p)).toEqual(["add", "multiply"]);
  });

  it("deny removes the named tools", async () => {
    const p = filteredToolPort(mathPort(), { deny: ["power"] });
    expect(await names(p)).toEqual(["add", "multiply"]);
  });

  it("deny wins over allow on overlap", async () => {
    const p = filteredToolPort(mathPort(), { allow: ["add", "power"], deny: ["power"] });
    expect(await names(p)).toEqual(["add"]);
  });

  it("no allow/deny => all tools", async () => {
    expect(await names(filteredToolPort(mathPort(), {}))).toEqual(["add", "multiply", "power"]);
  });

  it("empty allow => no tools", async () => {
    expect(await names(filteredToolPort(mathPort(), { allow: [] }))).toEqual([]);
  });

  it("refuses to execute a filtered-out tool (without reaching the server)", async () => {
    const p = filteredToolPort(mathPort(), { allow: ["add"] });
    const res = await p.execute(call("power"), signal());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/not allowed/);
  });

  it("executes an allowed tool normally", async () => {
    const p = filteredToolPort(mathPort(), { allow: ["add"] });
    expect(await p.execute(call("add"), signal())).toEqual({ ok: true, content: "ran:add" });
  });

  it("dispose() delegates to the inner port", async () => {
    let disposed = false;
    const inner: ToolPort = {
      list: () => Promise.resolve([]),
      execute: () => Promise.resolve({ ok: true, content: "" }),
      dispose: () => Promise.resolve(void (disposed = true)),
    };
    await filteredToolPort(inner, {}).dispose?.();
    expect(disposed).toBe(true);
  });
});

const echo: InPageTool = {
  name: "echo",
  description: "echoes its message",
  inputSchema: { type: "object", properties: { message: { type: "string" } } },
  run: (args) => `echo: ${(args as { message?: string }).message ?? ""}`,
};

describe("inPageToolPort", () => {
  it("lists tool descriptors", async () => {
    const list = await inPageToolPort([echo]).list();
    expect(list).toEqual([
      { name: "echo", description: "echoes its message", inputSchema: echo.inputSchema },
    ]);
  });

  it("executes a tool and returns its output", async () => {
    const port = inPageToolPort([echo]);
    expect(await port.execute(call("echo", { message: "hi" }), signal())).toEqual({
      ok: true,
      content: "echo: hi",
    });
  });

  it("returns a failed result for an unknown tool", async () => {
    const res = await inPageToolPort([echo]).execute(call("nope"), signal());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/Unknown tool/);
  });

  it("turns a thrown error into a failed result", async () => {
    const boom: InPageTool = {
      name: "boom",
      inputSchema: {},
      run: () => {
        throw new Error("kaboom");
      },
    };
    const res = await inPageToolPort([boom]).execute(call("boom"), signal());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/kaboom/);
  });

  it("supports async tools", async () => {
    const slow: InPageTool = { name: "slow", inputSchema: {}, run: async () => "done" };
    expect(await inPageToolPort([slow]).execute(call("slow"), signal())).toEqual({
      ok: true,
      content: "done",
    });
  });

  describe("two tools sharing a name", () => {
    const first: InPageTool = { name: "dup", inputSchema: {}, run: () => "first" };
    const second: InPageTool = { name: "dup", inputSchema: {}, run: () => "second" };

    it("lists the name once", async () => {
      const list = await inPageToolPort([first, second]).list();
      expect(list.map((t) => t.name)).toEqual(["dup"]);
    });

    it("lists the same definition it will run", async () => {
      const port = inPageToolPort([first, second]);
      expect(await port.list()).toHaveLength(1);
      expect(await port.execute(call("dup"), signal())).toEqual({ ok: true, content: "second" });
    });
  });
});
