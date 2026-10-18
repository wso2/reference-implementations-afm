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

import { describe, it, expect, vi } from "vitest";
import { compositeToolPort, inPageToolPort, filteredToolPort } from "./tool-ports";
import { ToolNameError } from "./tool-names";
import type { ToolPort, ToolCall, ToolDescriptor, ToolResult } from "@afm/engine";
import type { InPageTool } from "./tool-ports";

const call = (name: string, args: unknown = {}): ToolCall => ({ id: "c1", name, args });
const signal = () => new AbortController().signal;

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
