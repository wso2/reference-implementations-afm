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


import { type Signature } from "@afm/engine";
import { PassThrough } from "node:stream";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Agent } from "./agent";
import { consoleChat } from "./console-chat";
import { agentFinishing, agentSaying } from "./test-fixtures/agents";

async function chat(agent: Agent, lines: string, signature?: Signature): Promise<string> {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (data: Buffer) => (text += data.toString()));
  const done = consoleChat(agent, input, output, signature);
  input.end(lines);
  await done;
  return text;
}

describe("consoleChat", () => {
  it.each([
    ["length", "the reply reached the model's length limit"],
    ["content-filter", "the model's content filter stopped the reply"],
    ["other", "the model finished with 'other'"],
  ])("says why a reply stopped early: %s", async (reason, text) => {
    expect(await chat(agentFinishing(reason), "hello\nexit\n")).toBe(`> Partial\n[Stopped: ${text}]\n> `);
  });

  it("says when the agent stopped at the max_iterations limit, still asking for another tool", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
        const chunks = [
          { type: "tool-call", toolCallId: "c", toolName: "echo", input: "{}" },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage },
        ];
        return { stream: simulateReadableStream({ chunks }) } as never;
      },
    });
    const echo = tool({ inputSchema: z.object({}), execute: async () => ({ ok: true, content: "echoed" }), toModelOutput: () => ({ type: "text", value: "echoed" }) });
    const agent: Agent = { system: "s", model, tools: { echo }, maxIterations: 2, close: async () => undefined };
    expect(await chat(agent, "hello\nexit\n")).toBe("> \n[Stopped: the agent reached its max_iterations limit]\n> ");
  });

  it("says nothing extra when the reply finished normally", async () => {
    expect(await chat(agentFinishing("stop"), "hello\nexit\n")).toBe("> Partial\n> ");
  });


  it("prints each answer after a prompt, and ends on exit or quit", async () => {
    expect(await chat(agentSaying("Hi", "Again").agent, "hello\nexit\nignored\n")).toBe("> Hi\n> ");
    expect(await chat(agentSaying("Hi").agent, "hello\nquit\n")).toBe("> Hi\n> ");
  });

  it("tells its caller whether the person asked to leave, or the input just ended", async () => {
    const { agent } = agentSaying("Hi");
    const run = async (lines: string): Promise<boolean> => {
      const input = new PassThrough();
      const done = consoleChat(agent, input, new PassThrough());
      input.end(lines);
      return done;
    };
    expect(await run("exit\n")).toBe(true);
    expect(await run("quit\n")).toBe(true);
    expect(await run("")).toBe(false);
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

describe("consoleChat with a structured signature", () => {
  const fenced = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";
  const forecast = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] };
  const weather = { type: "object", properties: { city: { type: "string" } }, required: ["city"] };

  it("prints structured output as indented JSON instead of the text the model wrote", async () => {
    const { agent } = agentSaying(`Sure!\n${fenced({ summary: "sunny" })}`);
    expect(await chat(agent, "weather?\nexit\n", { input: { type: "string" }, output: forecast })).toBe('> {\n  "summary": "sunny"\n}\n> ');
  });

  it("reads each line as JSON when the input is structured, and sends it to the model as JSON", async () => {
    const { agent, model } = agentSaying("fine");
    expect(await chat(agent, '{"city":"Paris"}\nexit\n', { input: weather, output: { type: "string" } })).toBe("> fine\n> ");
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain('{\\"city\\":\\"Paris\\"}');
  });

  it("reports a line that is not JSON, or does not fit the schema, and goes on, without asking the model", async () => {
    const { agent, model } = agentSaying("fine");
    const shown = await chat(agent, 'not json\n{"town":"Rome"}\n{"city":"Paris"}\nexit\n', { input: weather, output: { type: "string" } });
    expect(shown).toContain("[ERROR] The input of this agent must be JSON.");
    expect(shown).toMatch(/\[ERROR\] .*city/);
    expect(shown).toContain("fine");
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("reports an answer that is not the JSON that was asked for, and goes on", async () => {
    const { agent } = agentSaying("I refuse", fenced({ summary: "ok" }));
    const shown = await chat(agent, "one\ntwo\nexit\n", { input: { type: "string" }, output: forecast });
    expect(shown).toContain("[ERROR] Failed to parse response as JSON");
    expect(shown).toContain('"summary": "ok"');
  });

  it("keeps the original input in the conversation, not the text about the schema", async () => {
    const { agent, model } = agentSaying(fenced({ summary: "a" }), fenced({ summary: "b" }));
    await chat(agent, "first\nsecond\nexit\n", { input: { type: "string" }, output: forecast });
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt).match(/The final response MUST conform/g)).toHaveLength(1);
  });
});
