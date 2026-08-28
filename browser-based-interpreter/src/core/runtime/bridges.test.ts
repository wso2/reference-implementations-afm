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
import { createPermissionBridge } from "./bridges";
import type { ToolCall } from "@afm/engine";

describe("createPermissionBridge", () => {
  const call: ToolCall = { id: "c1", name: "lookup", args: {} };
  const denied = { allow: false, remember: false };
  const stillWaiting = () => new Promise((resolve) => setTimeout(() => resolve("still waiting"), 20));

  it("fires a request and resolves when the person decides", async () => {
    const requested: string[] = [];
    const bridge = createPermissionBridge((asked) => requested.push(asked.id));
    const answer = bridge.ask(call);
    expect(requested).toEqual(["c1"]);
    bridge.resolve("c1", { allow: true, remember: true });
    expect(await answer).toEqual({ allow: true, remember: true });
  });

  it("denies the question when the run is stopped while it is open", async () => {
    const controller = new AbortController();
    const bridge = createPermissionBridge(() => {});
    const answer = bridge.ask(call, controller.signal);
    controller.abort();
    expect(await Promise.race([answer, stillWaiting()])).toEqual(denied);
  });

  it("forgets the question once stopped, so a late answer does nothing", async () => {
    const controller = new AbortController();
    const bridge = createPermissionBridge(() => {});
    const answer = bridge.ask(call, controller.signal);
    controller.abort();
    await Promise.race([answer, stillWaiting()]);
    expect(() => bridge.resolve("c1", { allow: true, remember: true })).not.toThrow();
    expect(await answer).toEqual(denied);
  });

  it("denies at once when the run was already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    const bridge = createPermissionBridge(() => {});
    expect(await Promise.race([bridge.ask(call, controller.signal), stillWaiting()])).toEqual(denied);
  });

  it("keeps an answer that came before the stop, and stops listening for it", async () => {
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    const bridge = createPermissionBridge(() => {});
    const answer = bridge.ask(call, controller.signal);
    bridge.resolve("c1", { allow: true, remember: false });
    controller.abort();
    expect(await answer).toEqual({ allow: true, remember: false });
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
