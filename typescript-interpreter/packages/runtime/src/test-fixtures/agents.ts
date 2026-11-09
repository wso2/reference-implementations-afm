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


import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { Agent } from "../agent";

export function agentSaying(...replies: (string | Error)[]): { agent: Agent; model: MockLanguageModelV3 } {
  let next = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const reply = replies[next++]!;
      if (reply instanceof Error) throw reply;
      const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
      const chunks = [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: reply },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
      ];
      return { stream: simulateReadableStream({ chunks }) } as never;
    },
  });
  return { agent: { system: "s", model, tools: {}, close: async () => undefined }, model };
}

export function agentFinishing(unified: string, tools = {}): Agent {
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
      const chunks = [
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Partial" },
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified, raw: unified }, usage },
      ];
      return { stream: simulateReadableStream({ chunks }) } as never;
    },
  });
  return { system: "s", model, tools, close: async () => undefined };
}
