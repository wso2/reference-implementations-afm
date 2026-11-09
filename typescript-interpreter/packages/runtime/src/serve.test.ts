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

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDetails } from "@afm/engine";
import type { Agent } from "./agent";
import { chooseInterfaces } from "./interfaces";
import { serve, type Serving } from "./serve";
import { agentSaying } from "./test-fixtures/agents";

const text = { input: { type: "string" }, output: { type: "string" } };
const webchat = (path = "/chat") => ({ type: "webchat", signature: text, exposure: { http: { path } } });

const running: Serving[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(running.splice(0).map((serving) => serving.close()));
});

async function start(agent: Agent, interfaces: unknown[], details: Partial<AgentDetails> = {}): Promise<string> {
  const serving = await serve(agent, { name: "Demo", description: "", version: "0.0.0", ...details }, chooseInterfaces({ interfaces } as never), { host: "127.0.0.1", port: 0 });
  running.push(serving);
  return `http://127.0.0.1:${serving.port}`;
}

const post = (url: string, body: string | Uint8Array, headers: Record<string, string> = {}) => fetch(url, { method: "POST", body, headers });

describe("the web chat endpoint", () => {
  it("answers a plain text message with plain text", async () => {
    const base = await start(agentSaying("Hello back").agent, [webchat()]);
    const response = await post(`${base}/chat`, "hello", { "Content-Type": "text/plain" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("Hello back");
  });

  it("also takes a JSON string, and a body with no content type", async () => {
    const base = await start(agentSaying("one", "two").agent, [webchat()]);
    expect(await (await post(`${base}/chat`, JSON.stringify("hi"), { "Content-Type": "application/json" })).text()).toBe("one");
    expect(await (await post(`${base}/chat`, new Uint8Array([104, 105]))).text()).toBe("two");
  });

  it("takes a session id with a space, and treats an empty one as the shared conversation", async () => {
    const base = await start(agentSaying("one", "two", "three").agent, [webchat()]);
    expect(await (await post(`${base}/chat`, "a", { "X-Session-Id": "my chat" })).text()).toBe("one");
    expect(await (await post(`${base}/chat`, "b", { "X-Session-Id": "" })).text()).toBe("two");
    expect(await (await post(`${base}/chat`, "c")).text()).toBe("three");
  });

  it("keeps one conversation per X-Session-Id, and a shared one when there is no header", async () => {
    const { agent, model } = agentSaying("a1", "b1", "a2", "d1");
    const base = await start(agent, [webchat()]);
    const say = (message: string, session?: string) => post(`${base}/chat`, message, session === undefined ? {} : { "X-Session-Id": session });
    await say("from-a-first", "a");
    await say("from-b-first", "b");
    await say("from-a-second", "a");
    await say("from-default");
    const prompt = (call: number) => JSON.stringify(model.doStreamCalls[call]!.prompt);
    expect(prompt(2)).toContain("from-a-first");
    expect(prompt(2)).not.toContain("from-b-first");
    expect(prompt(1)).not.toContain("from-a-first");
    expect(prompt(3)).not.toContain("from-a-first");
  });

  it("answers two requests of one session one after the other, so the second one sees the first", async () => {
    const { agent, model } = agentSaying("r1", "r2");
    const base = await start(agent, [webchat()]);
    await Promise.all([post(`${base}/chat`, "message-one", { "X-Session-Id": "s" }), post(`${base}/chat`, "message-two", { "X-Session-Id": "s" })]);
    const later = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(later).toContain("message-one");
    expect(later).toContain("message-two");
  });

  it.each([
    ["an empty message", "  ", { "Content-Type": "text/plain" }, "Message body must be a non-empty string"],
    ["a content type it does not take", "x", { "Content-Type": "application/xml" }, "Unsupported Content-Type for string input"],
    ["JSON that is not a string", "{}", { "Content-Type": "application/json" }, "Expected JSON string for string input"],
    ["JSON that is broken", "{", { "Content-Type": "application/json" }, "Invalid JSON in request body"],
    ["a session id that is too long", "hi", { "X-Session-Id": "x".repeat(257) }, "Invalid X-Session-Id header"],
  ])("refuses %s with a 400", async (_what, body, headers, detail) => {
    const base = await start(agentSaying("never").agent, [webchat()]);
    const response = await post(`${base}/chat`, body, headers);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ detail });
  });

  it("refuses text that is not UTF-8, and a body over 1 MB", async () => {
    const base = await start(agentSaying("never").agent, [webchat()]);
    const bad = await post(`${base}/chat`, new Uint8Array([0xff, 0xfe, 0xfd]));
    expect([bad.status, ((await bad.json()) as { detail: string }).detail]).toEqual([400, "Request body must be valid UTF-8"]);
    const big = await post(`${base}/chat`, "x".repeat(1024 * 1024 + 1), { "Content-Type": "text/plain" }).catch(() => undefined);
    if (big !== undefined) expect(big.status).toBe(413);
  });

  it("answers 500 without details when the agent fails, and keeps serving", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const base = await start(agentSaying(new Error("secret reason"), "fine").agent, [webchat()]);
    const failed = await post(`${base}/chat`, "hello");
    expect([failed.status, await failed.json()]).toEqual([500, { detail: "Internal server error" }]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("secret reason"));
    expect(await (await post(`${base}/chat`, "again", { "X-Session-Id": "other" })).text()).toBe("fine");
  });

  it("uses the path from the file", async () => {
    const base = await start(agentSaying("ok").agent, [webchat("/math-tutor")]);
    expect(await (await post(`${base}/math-tutor`, "hi")).text()).toBe("ok");
    expect((await post(`${base}/chat`, "hi")).status).toBe(404);
  });
});

describe("the other routes", () => {
  it("tells who the agent is, and that it is healthy", async () => {
    const base = await start(agentSaying("x").agent, [webchat()], { name: "Demo", description: "Helps", version: "1.2.3" });
    expect(await (await fetch(`${base}/`)).json()).toEqual({ name: "Demo", description: "Helps", version: "1.2.3", interfaces: { webchat: "/chat", webhook: null } });
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: "ok" });
  });

  it("answers 404 for an unknown path and 405 with the allowed methods for a wrong one", async () => {
    const base = await start(agentSaying("x").agent, [webchat()]);
    const missing = await fetch(`${base}/nothing`);
    expect([missing.status, await missing.json()]).toEqual([404, { detail: "Not Found" }]);
    const wrong = await fetch(`${base}/chat`);
    expect([wrong.status, wrong.headers.get("allow")]).toEqual([405, "POST"]);
    expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/__proto__`)).status).toBe(404);
  });

  it("sends no caching and no sniffing headers", async () => {
    const base = await start(agentSaying("x").agent, [webchat()]);
    const response = await fetch(`${base}/health`);
    expect([response.headers.get("cache-control"), response.headers.get("x-content-type-options")]).toEqual(["no-store", "nosniff"]);
  });
});

describe("the chat page", () => {
  it("is served at /chat/ui with a strict content security policy", async () => {
    const base = await start(agentSaying("x").agent, [webchat()], { name: "Demo", description: "Helps", version: "1.2.3" });
    const response = await fetch(`${base}/chat/ui`);
    const page = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page).toContain("<title>Demo</title>");
    expect(page).toContain("<small>1.2.3</small>");
    expect(page).toContain('const chatPath = "/chat";');
  });

  it("escapes what the agent file says about itself", async () => {
    const base = await start(agentSaying("x").agent, [webchat()], { name: "<b>x</b>", description: '"quoted" & <i>', iconUrl: 'https://example.com/a.png"onerror="alert(1)' });
    const page = await (await fetch(`${base}/chat/ui`)).text();
    expect(page).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(page).toContain("&quot;quoted&quot; &amp; &lt;i&gt;");
    expect(page).not.toContain("<b>x</b>");
    expect(page).toContain('src="https://example.com/a.png&quot;onerror=&quot;alert(1)"');
  });

  it("shows an icon only when it is an https address, and keeps a path from closing the script", async () => {
    const base = await start(agentSaying("x").agent, [webchat("/a</script>b")], { name: "Demo", iconUrl: "http://example.com/a.png" });
    const page = await (await fetch(`${base}/chat/ui`)).text();
    expect(page).not.toContain("<img");
    expect(page).toContain('const chatPath = "/a\\u003c/script>b";');
    expect(page.match(/<\/script>/g)).toHaveLength(1);
  });

  it("is not there without a web chat interface", async () => {
    const base = await start(agentSaying("x").agent, [{ type: "webhook", exposure: { http: { path: "/hook" } } }]);
    expect((await fetch(`${base}/chat/ui`)).status).toBe(404);
  });
});

describe("the web chat endpoint with a structured signature", () => {
  const fenced = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";
  const weather = { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false };
  const forecast = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] };
  const chat = (input: unknown, output: unknown) => ({ type: "webchat", signature: { input, output }, exposure: { http: { path: "/chat" } } });
  const json = (value: unknown) => ({ method: "POST", body: JSON.stringify(value), headers: { "Content-Type": "application/json" } });

  it("takes a JSON object, asks the model for JSON that fits, and answers with the JSON", async () => {
    const { agent, model } = agentSaying(fenced({ summary: "sunny" }));
    const base = await start(agent, [chat(weather, forecast)]);
    const response = await fetch(`${base}/chat`, json({ city: "Paris" }));
    expect([response.status, await response.json()]).toEqual([200, { summary: "sunny" }]);
    const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
    expect(prompt).toContain('{\\"city\\":\\"Paris\\"}');
    expect(prompt).toContain("The final response MUST conform to the following JSON schema");
  });

  it("wraps text output in a response field, and takes a JSON string when the input is text", async () => {
    const { agent } = agentSaying("plain words");
    const base = await start(agent, [chat(weather, { type: "string" })]);
    expect(await (await fetch(`${base}/chat`, json({ city: "Paris" }))).json()).toEqual({ response: "plain words" });
    const { agent: other } = agentSaying(fenced({ summary: "ok" }));
    const second = await start(other, [chat({ type: "string" }, forecast)]);
    expect(await (await fetch(`${second}/chat`, json("what is the weather"))).json()).toEqual({ summary: "ok" });
    const wrong = await fetch(`${second}/chat`, json({ city: "x" }));
    expect([wrong.status, await wrong.json()]).toEqual([400, { detail: "Expected JSON string for string input" }]);
  });

  it("wraps an answer that is not an object in a response field", async () => {
    const { agent } = agentSaying("```json\n[1,2,3]\n```");
    const base = await start(agent, [chat(weather, { type: "array", items: { type: "number" } })]);
    expect(await (await fetch(`${base}/chat`, json({ city: "Paris" }))).json()).toEqual({ response: [1, 2, 3] });
  });

  it("answers 400 for input that does not fit the schema, without asking the model", async () => {
    const { agent, model } = agentSaying(fenced({ summary: "never" }));
    const base = await start(agent, [chat(weather, forecast)]);
    const response = await fetch(`${base}/chat`, json({ town: "Paris" }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { detail: string }).detail).toMatch(/city|Unrecognized/);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("answers 400 for a body that is not JSON, or has another content type", async () => {
    const base = await start(agentSaying("never").agent, [chat(weather, forecast)]);
    const broken = await fetch(`${base}/chat`, { method: "POST", body: "{", headers: { "Content-Type": "application/json" } });
    expect([broken.status, await broken.json()]).toEqual([400, { detail: "Invalid JSON in request body" }]);
    const other = await fetch(`${base}/chat`, { method: "POST", body: "{}", headers: { "Content-Type": "text/plain" } });
    expect([other.status, await other.json()]).toEqual([400, { detail: "Content-Type must be application/json" }]);
  });

  it("answers 500, without showing what the model said, when its answer does not fit", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { agent } = agentSaying("my secret thoughts", fenced({ summary: 5 }));
    const base = await start(agent, [chat(weather, forecast)]);
    const first = await fetch(`${base}/chat`, json({ city: "Paris" }));
    expect([first.status, await first.json()]).toEqual([500, { detail: "The agent's answer did not fit the output schema" }]);
    const second = await fetch(`${base}/chat`, json({ city: "Paris" }));
    expect(second.status).toBe(500);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Failed to parse response as JSON"));
  });
});
