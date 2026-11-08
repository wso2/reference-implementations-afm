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


import { PassThrough } from "node:stream";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { Agent } from "./agent";
import { checkConsoleChat, consoleChat } from "./console-chat";

const metadata = (interfaces?: unknown[]) => ({ interfaces }) as never;

describe("checkConsoleChat", () => {
  it("accepts a file with no interfaces, and one with console chat", () => {
    expect(() => checkConsoleChat(metadata())).not.toThrow();
    expect(() => checkConsoleChat(metadata([{ type: "consolechat", signature: { input: { type: "string" }, output: { type: "string" } } }]))).not.toThrow();
  });

  it.each(["webchat", "webhook", "platformchat"])("refuses the %s interface, saying it is not yet supported", (type) => {
    expect(() => checkConsoleChat(metadata([{ type }]))).toThrow(`The '${type}' interface is not yet supported by this interpreter.`);
  });

  it("refuses structured input or output", () => {
    const structured = { type: "consolechat", signature: { input: { type: "object" }, output: { type: "string" } } };
    expect(() => checkConsoleChat(metadata([structured]))).toThrow(/Structured input or output is not yet supported/);
  });
});

function agentSaying(...replies: (string | Error)[]): { agent: Agent; model: MockLanguageModelV3 } {
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

async function chat(agent: Agent, lines: string): Promise<string> {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (data: Buffer) => (text += data.toString()));
  const done = consoleChat(agent, input, output);
  input.end(lines);
  await done;
  return text;
}

describe("consoleChat", () => {
  it("prints each answer after a prompt, and ends on exit or quit", async () => {
    expect(await chat(agentSaying("Hi", "Again").agent, "hello\nexit\nignored\n")).toBe("> Hi\n> ");
    expect(await chat(agentSaying("Hi").agent, "hello\nquit\n")).toBe("> Hi\n> ");
  });

  it("ignores empty lines and ends at the end of input", async () => {
    const { agent, model } = agentSaying("Only once");
    expect(await chat(agent, "\n  \nhello\n")).toBe("> > > Only once\n> ");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("sends the earlier conversation with each new line", async () => {
    const { agent, model } = agentSaying("one", "two");
    await chat(agent, "first\nsecond\nexit\n");
    const prompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(prompt).toContain("first");
    expect(prompt).toContain("one");
    expect(prompt).toContain("second");
  });

  it("reports an error and carries on with the next line", async () => {
    const { agent } = agentSaying(new Error("model is down"), "back");
    const text = await chat(agent, "a\nb\nexit\n");
    expect(text).toContain("[ERROR] model is down");
    expect(text).toContain("back");
  });
});
