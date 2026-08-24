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
import type { ToolCall, ToolPort } from "@afm/engine";
import { dropEmptyArgs } from "./tool-args";

function recordingPort(): { port: ToolPort; sent: unknown[]; dispose: ReturnType<typeof vi.fn> } {
  const sent: unknown[] = [];
  const dispose = vi.fn(async () => {});
  const port: ToolPort = {
    list: async () => [
      {
        name: "find-activity",
        inputSchema: { type: "object", properties: { cursor: { type: "string" } }, required: ["cursor"] },
      },
    ],
    execute: async (call) => {
      sent.push(call.args);
      return { ok: true, content: "done" };
    },
    dispose,
  };
  return { port, sent, dispose };
}

function call(args: unknown): ToolCall {
  return { id: "call-1", name: "find-activity", args };
}

const signal = new AbortController().signal;

describe("dropEmptyArgs", () => {
  it("leaves out every field the model sent as an empty string, even one the server lists as required", async () => {
    const { port, sent } = recordingPort();
    await dropEmptyArgs(port).execute(call({ objectType: "task", objectId: "", cursor: "" }), signal);
    expect(sent).toEqual([{ objectType: "task" }]);
  });

  it("keeps values that are not empty strings, such as 0, false, null and spaces", async () => {
    const { port, sent } = recordingPort();
    const args = { searchText: " ", cursor: null, limit: 0, archived: false, tasks: [{ content: "" }] };
    await dropEmptyArgs(port).execute(call(args), signal);
    expect(sent).toEqual([args]);
  });

  it("passes arguments that are not an object on unchanged", async () => {
    const { port, sent } = recordingPort();
    const wrapped = dropEmptyArgs(port);
    await wrapped.execute(call(["", "x"]), signal);
    await wrapped.execute(call(null), signal);
    expect(sent).toEqual([["", "x"], null]);
  });

  it("does not change the call it was given", async () => {
    const { port } = recordingPort();
    const args = { objectType: "task", cursor: "" };
    await dropEmptyArgs(port).execute(call(args), signal);
    expect(args).toEqual({ objectType: "task", cursor: "" });
  });

  it("lists the same tools and closes the inner port", async () => {
    const { port, dispose } = recordingPort();
    const wrapped = dropEmptyArgs(port);
    expect(await wrapped.list()).toEqual(await port.list());
    await wrapped.dispose?.();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
