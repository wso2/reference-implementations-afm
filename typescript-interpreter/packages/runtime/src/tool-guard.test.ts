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

import { jsonSchema, type Tool, type ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";
import type { ToolOutput } from "./run";
import { createToolGuard, MAX_TOOL_RESULT_CHARS, type PermissionBroker, type ToolCall } from "./tool-guard";

const allow: PermissionBroker = { request: async () => "allow" };
const anySchema = jsonSchema({ type: "object", properties: {} });

async function execute(tools: ToolSet, name: string, args: unknown = {}, signal = new AbortController().signal): Promise<ToolOutput> {
  const found = tools[name] as Tool | undefined;
  return (await found?.execute?.(args, { toolCallId: "c1", messages: [], abortSignal: signal })) as ToolOutput;
}

function guardedTool(run: (input: unknown) => Promise<string | ToolOutput>, permission: PermissionBroker = allow, serverId?: string) {
  return { fn: { name: "t", serverId, inputSchema: anySchema, run }, guard: createToolGuard(permission) };
}

describe("the tool guard", () => {
  it("asks first, with the call id, the tool name, the arguments and the server that owns the tool", async () => {
    const request = vi.fn(async () => "allow" as const);
    const { fn, guard } = guardedTool(async () => "done", { request }, "https://server.example/mcp");
    const result = await execute({ t: guard(fn) }, "t", { a: 1 });
    expect(request).toHaveBeenCalledWith(
      { id: "c1", name: "t", args: { a: 1 }, serverId: "https://server.example/mcp" },
      expect.any(AbortSignal),
    );
    expect(result).toEqual({ ok: true, content: "done" });
  });

  it("leaves the server out for a built-in tool", async () => {
    const request = vi.fn(async (_call: ToolCall) => "allow" as const);
    const { fn, guard } = guardedTool(async () => "done", { request });
    await execute({ t: guard(fn) }, "t");
    expect(request.mock.calls[0]?.[0]).toMatchObject({ serverId: undefined });
  });

  it("does not run a tool the user denies, and says so", async () => {
    const run = vi.fn(async () => "ran");
    const { fn, guard } = guardedTool(run, { request: async () => "deny" });
    expect(await execute({ t: guard(fn) }, "t")).toEqual({ ok: false, content: "Tool call was denied by the user." });
    expect(run).not.toHaveBeenCalled();
  });

  it("turns a thrown error into a failed result", async () => {
    const { fn, guard } = guardedTool(async () => {
      throw new Error("boom");
    });
    expect(await execute({ t: guard(fn) }, "t")).toEqual({ ok: false, content: "Tool 't' failed: boom" });
  });

  it("carries a failed result from the tool through unchanged", async () => {
    const { fn, guard } = guardedTool(async () => ({ ok: false, content: "server said no" }));
    expect(await execute({ t: guard(fn) }, "t")).toEqual({ ok: false, content: "server said no" });
  });

  it("does not run a call that is allowed after the run was stopped, and records it as cancelled", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => "ran");
    const { fn, guard } = guardedTool(run, {
      request: async () => {
        controller.abort();
        return "allow";
      },
    });
    const result = await execute({ t: guard(fn) }, "t", {}, controller.signal);
    expect(result.content).toBe("Tool call was cancelled - the user stopped the run.");
    expect(run).not.toHaveBeenCalled();
  });

  it("lets a permission question end when the run is stopped, as cancelled and not as denied", async () => {
    const controller = new AbortController();
    const run = vi.fn(async () => "ran");
    const { fn, guard } = guardedTool(run, {
      request: (_call, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve("deny"), { once: true })),
    });
    const pending = execute({ t: guard(fn) }, "t", {}, controller.signal);
    controller.abort();
    expect((await pending).content).toBe("Tool call was cancelled - the user stopped the run.");
    expect(run).not.toHaveBeenCalled();
  });

  it("records a tool that fails because the run was stopped as cancelled, not as a failure of the tool", async () => {
    const controller = new AbortController();
    const { fn, guard } = guardedTool(async () => {
      controller.abort();
      throw new Error("aborted");
    });
    expect((await execute({ t: guard(fn) }, "t", {}, controller.signal)).content).toBe(
      "Tool call was cancelled - the user stopped the run.",
    );
  });

  it("does nothing at all for a call that arrives after the run was stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(async () => "allow" as const);
    const { fn, guard } = guardedTool(async () => "ran", { request });
    await execute({ t: guard(fn) }, "t", {}, controller.signal);
    expect(request).not.toHaveBeenCalled();
  });

  it("handles calls one at a time, in the order they arrived, even when the model asks for several at once", async () => {
    const order: string[] = [];
    const guard = createToolGuard({
      request: async (call) => {
        order.push(`ask ${call.args as string}`);
        await new Promise((resolve) => setTimeout(resolve, call.args === "first" ? 20 : 1));
        return "allow";
      },
    });
    const tools = {
      t: guard({
        name: "t",
        inputSchema: anySchema,
        run: async (input) => {
          order.push(`run ${input as string}`);
          return "ok";
        },
      }),
    };
    await Promise.all([execute(tools, "t", "first"), execute(tools, "t", "second")]);
    expect(order).toEqual(["ask first", "run first", "ask second", "run second"]);
  });

  describe("a large result", () => {
    const result = (content: string) => {
      const { fn, guard } = guardedTool(async () => content);
      return execute({ t: guard(fn) }, "t");
    };

    it("is cut with a note giving both lengths", async () => {
      const long = "x".repeat(MAX_TOOL_RESULT_CHARS + 500);
      const output = await result(long);
      expect(output.content.startsWith("x".repeat(MAX_TOOL_RESULT_CHARS))).toBe(true);
      expect(output.content).toContain(`only the first ${MAX_TOOL_RESULT_CHARS} of ${long.length} characters are shown`);
    });

    it("is left untouched at exactly the limit", async () => {
      const exact = "y".repeat(MAX_TOOL_RESULT_CHARS);
      expect((await result(exact)).content).toBe(exact);
    });

    it("does not split a surrogate pair sitting right on the cut", async () => {
      const text = `${"a".repeat(MAX_TOOL_RESULT_CHARS - 1)}\u{1F600}tail`;
      const { content } = await result(text);
      expect(content).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
      expect(content).toContain(`only the first ${MAX_TOOL_RESULT_CHARS - 1} of ${text.length}`);
    });
  });
});
