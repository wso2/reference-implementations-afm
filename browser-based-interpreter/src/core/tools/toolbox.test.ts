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

import { jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createToolGuard, type PermissionBroker } from "./tool-guard";
import { ToolNameError } from "./tool-names";
import { createToolbox, type ToolSource } from "./toolbox";

const allow: PermissionBroker = { request: async () => "allow" };
const anySchema = jsonSchema({ type: "object", properties: {} });

const source = (label: string, names: string[], serverId?: string): ToolSource => ({
  label,
  serverId,
  tools: async () => Object.fromEntries(names.map((name) => [name, createToolGuard(allow)({ name, inputSchema: anySchema, run: async () => name })])),
  close: vi.fn(async () => {}),
});

const failing = (label: string): ToolSource => ({ label, tools: async () => Promise.reject(new Error("down")), close: async () => {} });

describe("the toolbox", () => {
  it("offers the tools of every source, with the server each one belongs to", async () => {
    const box = await createToolbox([source("a", ["a__x"], "https://a.example"), source("b", ["b__y", "read_file"])]).tools();
    expect(box.info.map(({ name, serverId }) => [name, serverId])).toEqual([
      ["a__x", "https://a.example"],
      ["b__y", undefined],
      ["read_file", undefined],
    ]);
    expect(Object.keys(box.tools)).toEqual(["a__x", "b__y", "read_file"]);
  });

  it("refuses two tools with the same name, naming both servers and the tool", async () => {
    const toolbox = createToolbox([source("one", ["s__go"]), source("two", ["s__go"])]);
    const error = await toolbox.tools().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolNameError);
    expect((error as Error).message).toMatch(/'one' and 'two'.*'go'.*'s__go'/);
  });

  it("refuses a server that lists a tool twice, and says so", async () => {
    const dup = source("one", []);
    dup.tools = async () => ({ ...(await source("x", ["s__go"]).tools()) });
    const toolbox = createToolbox([dup, { ...dup, label: "one" }]);
    await expect(toolbox.tools()).rejects.toThrow(/lists the tool 'go' more than once/);
  });

  it("refuses a server tool that takes a built-in tool's name", async () => {
    const toolbox = createToolbox([source("one", ["read_file"]), source("the file tools", ["read_file"])]);
    await expect(toolbox.tools()).rejects.toBeInstanceOf(ToolNameError);
  });

  it("keeps the tools of every source that worked when another is down", async () => {
    const box = await createToolbox([failing("down"), source("up", ["up__x"])]).tools();
    expect(Object.keys(box.tools)).toEqual(["up__x"]);
  });

  it("offers nothing, without failing, when no source could be loaded", async () => {
    expect((await createToolbox([failing("down")]).tools()).info).toEqual([]);
  });

  it("lists the sources once, not on every call", async () => {
    const one = source("one", ["one__x"]);
    const spy = vi.spyOn(one, "tools");
    const toolbox = createToolbox([one]);
    await toolbox.tools();
    await toolbox.tools();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("tries a source that was down again after a wait, without losing the tools already found", async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const flaky: ToolSource = { label: "flaky", tools: async () => (up ? source("flaky", ["flaky__y"]).tools() : Promise.reject(new Error("down"))), close: async () => {} };
      const toolbox = createToolbox([source("good", ["good__x"]), flaky]);
      expect(Object.keys((await toolbox.tools()).tools)).toEqual(["good__x"]);
      up = true;
      vi.advanceTimersByTime(10_000);
      expect(Object.keys((await toolbox.tools()).tools)).toEqual(["good__x"]);
      vi.advanceTimersByTime(25_000);
      expect(Object.keys((await toolbox.tools()).tools)).toEqual(["good__x", "flaky__y"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes every source", async () => {
    const one = source("one", []);
    const two = source("two", []);
    await createToolbox([one, two]).close();
    expect(one.close).toHaveBeenCalledOnce();
    expect(two.close).toHaveBeenCalledOnce();
  });
});

describe("a server that was down", () => {
  it("is tried again later, and a clash found then is reported each time instead of being forgotten", async () => {
    vi.useFakeTimers();
    try {
      let answers = 0;
      const guard = createToolGuard(allow);
      const late: ToolSource = {
        label: "late",
        tools: async () => {
          answers += 1;
          if (answers === 1) throw new Error("down");
          return { s__go: guard({ name: "s__go", inputSchema: anySchema, run: async () => "go" }) };
        },
        close: async () => {},
      };
      const toolbox = createToolbox([late, source("other", ["s__go"])]);
      expect(Object.keys((await toolbox.tools()).tools)).toEqual(["s__go"]);
      vi.advanceTimersByTime(31_000);
      await expect(toolbox.tools()).rejects.toBeInstanceOf(ToolNameError);
      vi.advanceTimersByTime(31_000);
      await expect(toolbox.tools()).rejects.toBeInstanceOf(ToolNameError);
    } finally {
      vi.useRealTimers();
    }
  });
});
