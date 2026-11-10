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
import { describe, expect, it } from "vitest";
import { Sessions } from "./sessions";
import { agentSaying } from "./test-fixtures/agents";

const calls = (model: { doStreamCalls: { prompt: unknown }[] }, call: number): string => JSON.stringify(model.doStreamCalls[call]!.prompt);

describe("Sessions", () => {
  it("answers, and remembers the conversation under the name it was given", async () => {
    const { agent, model } = agentSaying("one", "two", "three");
    const sessions = new Sessions(agent);
    expect(await sessions.ask("a", "from-a")).toBe("one");
    expect(await sessions.ask("a", "again-a")).toBe("two");
    expect(await sessions.ask("b", "from-b")).toBe("three");
    expect(calls(model, 1)).toContain("from-a");
    expect(calls(model, 2)).not.toContain("from-a");
  });

  it("goes on with the next question after a failed one, and does not keep the failed one", async () => {
    const { agent, model } = agentSaying(new Error("down"), "fine");
    const sessions = new Sessions(agent);
    await expect(sessions.ask("a", "lost-question")).rejects.toThrow("down");
    expect(await sessions.ask("a", "next")).toBe("fine");
    expect(calls(model, 1)).not.toContain("lost-question");
  });

  it("drops the oldest conversation when more than 1,000 are open", async () => {
    const { agent, model } = agentSaying(...Array.from({ length: 1003 }, () => "ok"));
    const sessions = new Sessions(agent);
    for (let id = 0; id < 1001; id += 1) await sessions.ask(`s${id}`, `first-of-${id}-end`);
    await sessions.ask("s0", "second-of-0");
    await sessions.ask("s1000", "second-of-1000");
    expect(calls(model, 1001)).not.toContain("first-of-0-end");
    expect(calls(model, 1002)).toContain("first-of-1000-end");
  }, 60_000);

  it("returns the value of a structured answer, and remembers the original input and not the schema text", async () => {
    const reply = (value: string) => "```json\n" + value + "\n```";
    const { agent, model } = agentSaying(reply('{"summary":"sunny"}'), reply('{"summary":"rain"}'));
    const signature = { input: { type: "object" }, output: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } };
    const sessions = new Sessions(agent);
    expect(await sessions.ask("a", { city: "Paris" }, { signature })).toEqual({ summary: "sunny" });
    expect(await sessions.ask("a", { city: "Rome" }, { signature })).toEqual({ summary: "rain" });
    const second = calls(model, 1);
    expect(second).toContain('{\\"city\\":\\"Paris\\"}');
    expect(second.match(/The final response MUST conform/g)).toHaveLength(1);
  });

  it("does not remember a turn whose answer did not fit the schema", async () => {
    const { agent, model } = agentSaying("not json", "```json\n{}\n```");
    const sessions = new Sessions(agent);
    const signature = { input: { type: "string" }, output: { type: "object" } };
    await expect(sessions.ask("a", "lost-question", { signature })).rejects.toThrow(/Failed to parse response as JSON/);
    await sessions.ask("a", "next", { signature });
    expect(calls(model, 1)).not.toContain("lost-question");
  });
});

describe("Sessions, after a turn is over", () => {
  const tailsOf = (sessions: Sessions): Map<string, unknown> => (sessions as unknown as { tails: Map<string, unknown> }).tails;

  const scripted = (slow: string) => {
    const events: string[] = [];
    let release = (): void => undefined;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const marker = JSON.stringify(prompt).match(/turn-\w+/g)!.at(-1)!;
        if (marker === slow || marker === "turn-second") events.push(`start ${marker}`);
        if (marker === slow) await new Promise<void>((resolve) => (release = resolve));
        if (marker === slow || marker === "turn-second") events.push(`end ${marker}`);
        const usage = { inputTokens: { total: 1 }, outputTokens: { total: 1 } };
        const chunks = [
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "ok" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
        ];
        return { stream: simulateReadableStream({ chunks }) } as never;
      },
    });
    return { agent: { system: "s", model, tools: {}, close: async () => undefined }, events, release: () => release() };
  };

  it("keeps nothing about a session whose turns all failed", async () => {
    const { agent } = agentSaying(...Array.from({ length: 5 }, () => new Error("down")));
    const sessions = new Sessions(agent);
    for (let id = 0; id < 5; id += 1) await expect(sessions.ask(`s${id}`, "question")).rejects.toThrow("down");
    expect(tailsOf(sessions).size).toBe(0);
  });

  it("keeps nothing about a session whose turn went well", async () => {
    const { agent } = agentSaying("one");
    const sessions = new Sessions(agent);
    await sessions.ask("a", "question");
    expect(tailsOf(sessions).size).toBe(0);
  });

  it("still holds the queue of a session while its turns are waiting, and then lets it go", async () => {
    const { agent, release } = scripted("turn-first");
    const sessions = new Sessions(agent);
    const first = sessions.ask("a", "turn-first");
    const second = sessions.ask("a", "turn-second");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tailsOf(sessions).size).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(tailsOf(sessions).size).toBe(0);
  });

  it("keeps the order of a session whose old conversation was dropped while its turn was running", async () => {
    const { agent, events, release } = scripted("turn-slow");
    const sessions = new Sessions(agent);
    for (let id = 0; id < 1000; id += 1) await sessions.ask(`s${id}`, `turn-q${id}`);
    const slow = sessions.ask("s0", "turn-slow");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await sessions.ask("newcomer", "turn-newcomer");
    const second = sessions.ask("s0", "turn-second");
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await Promise.all([slow, second]);
    expect(events).toEqual(["start turn-slow", "end turn-slow", "start turn-second", "end turn-second"]);
  }, 60_000);
});
