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

import { describe, expect, it } from "vitest";
import type { Tool } from "ai";
import { createToolGuard } from "../core/tools/tool-guard";
import { inPageToolPort, sourceOf } from "./test-ports";

describe("a fake tool port as a tool source", () => {
  it("offers a tool under the server's name and still runs it by its own name", async () => {
    const port = inPageToolPort([{ name: "echo", inputSchema: { type: "object" }, run: () => "hi" }]);
    const tools = await sourceOf(port, createToolGuard({ request: async () => "allow" }), "docs").tools();
    expect(Object.keys(tools)).toEqual(["docs__echo"]);
    const result = await (tools["docs__echo"] as Tool).execute?.({}, { toolCallId: "c1", messages: [], abortSignal: new AbortController().signal });
    expect(result).toEqual({ ok: true, content: "hi" });
  });
});
