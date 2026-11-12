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

import { describe, it, expect } from "vitest";
import { serverMessageFromLoopEvent } from "./protocol";
import type { LoopEvent } from "@afm/runtime";

describe("serverMessageFromLoopEvent", () => {
  it("passes a text-delta through", () => {
    expect(serverMessageFromLoopEvent({ type: "text-delta", text: "hi" })).toEqual({
      type: "text-delta",
      text: "hi",
    });
  });

  it("renames finish to turn-finished", () => {
    expect(serverMessageFromLoopEvent({ type: "finish", reason: "stop" })).toEqual({
      type: "turn-finished",
      reason: "stop",
    });
  });

  it("maps a tool-result", () => {
    const event: LoopEvent = { type: "tool-result", id: "c1", name: "t", ok: true, content: "r" };
    expect(serverMessageFromLoopEvent(event)).toEqual({
      type: "tool-result",
      id: "c1",
      name: "t",
      ok: true,
      content: "r",
    });
  });

  it("passes a usage report through", () => {
    const event: LoopEvent = {
      type: "usage",
      totalTokens: 120,
      inputTokens: 80,
      outputTokens: 40,
      iteration: 1,
      maxIterations: 10,
    };
    expect(serverMessageFromLoopEvent(event)).toEqual({
      type: "usage",
      totalTokens: 120,
      inputTokens: 80,
      outputTokens: 40,
      iteration: 1,
      maxIterations: 10,
    });
  });
});
