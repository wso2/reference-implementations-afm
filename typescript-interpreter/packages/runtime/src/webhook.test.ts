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

import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "./agent";
import { chooseInterfaces } from "./interfaces";
import { serve, type Serving } from "./serve";
import { agentSaying } from "./test-fixtures/agents";
import { verifySignature, WebSub } from "./webhook";

const sign = (body: string, secret: string, algorithm = "sha256"): string => createHmac(algorithm, secret).update(body).digest("hex");
const SECRET = "s3cret";

const running: Serving[] = [];
const hubs: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(running.splice(0).map((serving) => serving.close()));
  await Promise.all(hubs.splice(0).map((hub) => new Promise((done) => hub.close(done))));
});

async function start(agent: Agent, webhook: object = {}): Promise<string> {
  const interfaces = [{ type: "webhook", exposure: { http: { path: "/webhook" } }, ...webhook }];
  const serving = await serve(agent, { name: "Hook", description: "", version: "0.0.0" }, chooseInterfaces({ interfaces } as never), { host: "127.0.0.1", port: 0 });
  running.push(serving);
  return `http://127.0.0.1:${serving.port}`;
}

const signed = { subscription: { protocol: "websub", secret: SECRET } };
const send = (base: string, payload: string, headers: Record<string, string> = {}) => fetch(`${base}/webhook`, { method: "POST", body: payload, headers });
const sent = (model: MockLanguageModelV3, call: number): string => JSON.stringify(model.doStreamCalls[call]!.prompt);
const settled = (model: MockLanguageModelV3, calls: number) => vi.waitFor(() => expect(model.doStreamCalls).toHaveLength(calls));

describe("verifySignature", () => {
  const body = Buffer.from('{"a":1}');

  it("accepts the right signature, with or without the algorithm in front, in any case", () => {
    const good = sign('{"a":1}', SECRET);
    expect(verifySignature(body, `sha256=${good}`, SECRET)).toBe(true);
    expect(verifySignature(body, good, SECRET)).toBe(true);
    expect(verifySignature(body, `SHA256=${good.toUpperCase()}`, SECRET)).toBe(true);
  });

  it("also takes sha1 and sha512, named in the header", () => {
    expect(verifySignature(body, `sha1=${sign('{"a":1}', SECRET, "sha1")}`, SECRET)).toBe(true);
    expect(verifySignature(body, `sha512=${sign('{"a":1}', SECRET, "sha512")}`, SECRET)).toBe(true);
  });

  it("refuses a wrong secret, a changed body, a missing header and one of the wrong length", () => {
    const good = sign('{"a":1}', SECRET);
    expect(verifySignature(body, good, "other")).toBe(false);
    expect(verifySignature(Buffer.from('{"a":2}'), good, SECRET)).toBe(false);
    expect(verifySignature(body, undefined, SECRET)).toBe(false);
    expect(verifySignature(body, "", SECRET)).toBe(false);
    expect(verifySignature(body, "sha256=abc", SECRET)).toBe(false);
    expect(verifySignature(body, `sha256=${good}00`, SECRET)).toBe(false);
  });
});

describe("receiving an event", () => {
  it("answers 202 at once and then runs the agent with the payload as the prompt", async () => {
    const { agent, model } = agentSaying("done");
    const base = await start(agent);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await send(base, '{"event":"push"}');
    expect([response.status, await response.json()]).toEqual([202, { status: "accepted" }]);
    await settled(model, 1);
    expect(sent(model, 0)).toContain(JSON.stringify(JSON.stringify({ event: "push" }, null, 2)).slice(1, -1));
  });

  it("builds the prompt from the template, using the payload and the headers", async () => {
    const { agent, model } = agentSaying("done");
    const base = await start(agent, { prompt: "${http:payload.event} by ${http:payload.sender.name} via ${http:header.X-Source}" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await send(base, '{"event":"push","sender":{"name":"ada"}}', { "X-Source": "ci" });
    await settled(model, 1);
    expect(sent(model, 0)).toContain("push by ada via ci");
  });

  it("answers 400 when the template cannot be filled, without running the agent", async () => {
    const { agent, model } = agentSaying("never");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = await start(agent, { prompt: "${http:payload.missing}" });
    const response = await send(base, "{}");
    expect([response.status, await response.json()]).toEqual([400, { detail: "Failed to evaluate prompt template" }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Template evaluation error"));
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("answers 400 for a body that is not JSON", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = await start(agentSaying("never").agent);
    const response = await send(base, "not json");
    expect([response.status, await response.json()]).toEqual([400, { detail: "Invalid JSON payload" }]);
  });

  it("runs all events in one conversation, one after the other, like the Python and Ballerina interpreters", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { agent, model } = agentSaying("a", "b");
    const base = await start(agent, { prompt: "${http:payload.n}" });
    await send(base, '{"n":"first-event"}');
    await settled(model, 1);
    await send(base, '{"n":"second-event"}');
    await settled(model, 2);
    expect(sent(model, 1)).toContain("first-event");
    expect(sent(model, 1)).toContain("second-event");
  });

  it("shares that conversation with web chat requests that name no session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { agent, model } = agentSaying("chat reply", "event reply");
    const text = { input: { type: "string" }, output: { type: "string" } };
    const interfaces = [{ type: "webchat", signature: text, exposure: { http: { path: "/chat" } } }, { type: "webhook", exposure: { http: { path: "/webhook" } }, prompt: "${http:payload.n}" }];
    const serving = await serve(agent, { name: "Both", description: "", version: "0.0.0" }, chooseInterfaces({ interfaces } as never), { host: "127.0.0.1", port: 0 });
    running.push(serving);
    const base = `http://127.0.0.1:${serving.port}`;
    await fetch(`${base}/chat`, { method: "POST", body: "said-in-the-chat" });
    await send(base, '{"n":"event-after-chat"}');
    await settled(model, 2);
    expect(sent(model, 1)).toContain("said-in-the-chat");
  });

  it("logs, and does not crash, when the agent fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { agent, model } = agentSaying(new Error("model down"), "fine");
    const base = await start(agent);
    await send(base, "{}");
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("model down")));
    await send(base, "{}");
    await settled(model, 2);
  });

  it("takes on at most ten events at a time and asks for the rest to be sent again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    const model = new MockLanguageModelV3({
      doStream: async () => {
        await gate;
        const chunks = [{ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } }];
        return { stream: simulateReadableStream({ chunks }) } as never;
      },
    });
    const base = await start({ system: "s", model, tools: {}, close: async () => undefined });
    const statuses: number[] = [];
    for (let event = 0; event < 11; event += 1) statuses.push((await send(base, "{}")).status);
    expect(statuses).toEqual([...Array(10).fill(202), 503]);
    release();
    await settled(model, 10);
    await vi.waitFor(async () => expect((await send(base, "{}")).status).toBe(202));
  });
});

describe("the secret", () => {
  it("lets a correctly signed event through, from either signature header", async () => {
    const { agent, model } = agentSaying("a", "b");
    const base = await start(agent, signed);
    const body = '{"x":1}';
    expect((await send(base, body, { "X-Hub-Signature-256": `sha256=${sign(body, SECRET)}` })).status).toBe(202);
    expect((await send(base, body, { "X-Hub-Signature": `sha1=${sign(body, SECRET, "sha1")}` })).status).toBe(202);
    await settled(model, 2);
  });

  it("answers 401 for a missing or wrong signature, and runs nothing", async () => {
    const { agent, model } = agentSaying("never");
    const base = await start(agent, signed);
    const attempts: Record<string, string>[] = [{}, { "X-Hub-Signature-256": "sha256=bad" }, { "X-Hub-Signature-256": `sha256=${sign("{}", "other")}` }];
    for (const headers of attempts) {
      const response = await send(base, "{}", headers);
      expect([response.status, await response.json()]).toEqual([401, { detail: "Invalid signature" }]);
    }
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("warns at start when there is no secret, and accepts unsigned events", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { agent, model } = agentSaying("ok");
    const base = await start(agent);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not signature-verified"));
    expect((await send(base, "{}")).status).toBe(202);
    await settled(model, 1);
  });
});

describe("the hub's check of a subscription", () => {
  const subscribed = { subscription: { protocol: "websub", hub: "http://127.0.0.1:1/hub", topic: "https://example.com/topic" } };
  const verify = (base: string, mode: string, topic: string) => fetch(`${base}/webhook?hub.mode=${mode}&hub.topic=${encodeURIComponent(topic)}&hub.challenge=abc123`);

  it("gets the challenge back for the topic the agent asked for", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = await start(agentSaying("x").agent, subscribed);
    const response = await verify(base, "subscribe", "https://example.com/topic");
    expect([response.status, await response.text()]).toEqual([200, "abc123"]);
  });

  it("is refused for another topic, and for a mode it does not know", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = await start(agentSaying("x").agent, subscribed);
    expect((await verify(base, "subscribe", "https://example.com/other")).status).toBe(404);
    expect((await verify(base, "denied", "https://example.com/topic")).status).toBe(404);
    expect((await fetch(`${base}/webhook?hub.mode=subscribe`)).status).toBe(400);
  });

  it("gets the challenge back for any topic when the subscription was made by hand", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = await start(agentSaying("x").agent);
    expect(await (await verify(base, "subscribe", "anything")).text()).toBe("abc123");
  });
});

function fakeHub(statuses: number[] = [202]): Promise<{ url: string; posts: URLSearchParams[]; headers: IncomingHttpHeaders[] }> {
  const posts: URLSearchParams[] = [];
  const headers: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      posts.push(new URLSearchParams(body));
      headers.push(req.headers);
      res.writeHead(statuses[Math.min(posts.length, statuses.length) - 1]!).end();
    });
  });
  hubs.push(server);
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hub`, posts, headers })));
}

describe("subscribing at a hub", () => {
  it("subscribes at start with the topic, the callback and the secret, and unsubscribes at the end", async () => {
    const hub = await fakeHub();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = await start(agentSaying("x").agent, { subscription: { protocol: "websub", hub: hub.url, topic: "https://example.com/t", secret: SECRET } });
    await vi.waitFor(() => expect(hub.posts).toHaveLength(1));
    expect(Object.fromEntries(hub.posts[0]!)).toEqual({
      "hub.mode": "subscribe",
      "hub.topic": "https://example.com/t",
      "hub.callback": `${base}/webhook`,
      "hub.lease_seconds": "86400",
      "hub.secret": SECRET,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${base}/webhook`));
    await fetch(`${base}/webhook?hub.mode=subscribe&hub.topic=${encodeURIComponent("https://example.com/t")}&hub.challenge=c`);
    await running.pop()!.close();
    expect(Object.fromEntries(hub.posts[1]!)).toEqual({ "hub.mode": "unsubscribe", "hub.topic": "https://example.com/t", "hub.callback": `${base}/webhook` });
  });

  it("sends the subscription's authentication to the hub, when subscribing and when unsubscribing", async () => {
    const hub = await fakeHub();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = await start(agentSaying("x").agent, { subscription: { protocol: "websub", hub: hub.url, topic: "https://example.com/t", authentication: { type: "bearer", token: "hub-token" } } });
    await vi.waitFor(() => expect(hub.posts).toHaveLength(1));
    expect(hub.headers[0]!.authorization).toBe("Bearer hub-token");
    await fetch(`${base}/webhook?hub.mode=subscribe&hub.topic=${encodeURIComponent("https://example.com/t")}&hub.challenge=c`);
    await running.pop()!.close();
    expect(hub.headers[1]!.authorization).toBe("Bearer hub-token");
  });

  it("sends no authorization header when the subscription has no authentication", async () => {
    const hub = await fakeHub();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await start(agentSaying("x").agent, { subscription: { protocol: "websub", hub: hub.url, topic: "t" } });
    await vi.waitFor(() => expect(hub.posts).toHaveLength(1));
    expect(hub.headers[0]!.authorization).toBeUndefined();
  });

  it("subscribes again before the lease the hub granted runs out, and stops doing so when closed", async () => {
    const hub = await fakeHub();
    const websub = new WebSub(hub.url, "t", undefined);
    await websub.start("https://agent.example.com/hook", 1, 1);
    expect(hub.posts).toHaveLength(1);
    websub.confirm("subscribe", "t", "c", 1);
    await vi.waitFor(() => expect(hub.posts).toHaveLength(2), { timeout: 3000 });
    expect(hub.posts[1]!.get("hub.mode")).toBe("subscribe");
    websub.confirm("subscribe", "t", "c", 1);
    await websub.stop();
    const after = hub.posts.length;
    await new Promise((done) => setTimeout(done, 1300));
    expect(hub.posts).toHaveLength(after);
  });

  it("takes the lease from the hub's check of the subscription", async () => {
    const hub = await fakeHub();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const base = await start(agentSaying("x").agent, { subscription: { protocol: "websub", hub: hub.url, topic: "t" } });
    await vi.waitFor(() => expect(hub.posts).toHaveLength(1));
    await fetch(`${base}/webhook?hub.mode=subscribe&hub.topic=t&hub.challenge=c&hub.lease_seconds=1`);
    await vi.waitFor(() => expect(hub.posts).toHaveLength(2), { timeout: 3000 });
  });

  it("uses the callback from the file, and does not unsubscribe when the hub never checked it", async () => {
    const hub = await fakeHub();
    const base = await start(agentSaying("x").agent, { subscription: { protocol: "websub", hub: hub.url, topic: "t", callback: "https://agent.example.com/hook", secret: SECRET } });
    await vi.waitFor(() => expect(hub.posts).toHaveLength(1));
    expect(hub.posts[0]!.get("hub.callback")).toBe("https://agent.example.com/hook");
    await running.pop()!.close();
    expect(hub.posts).toHaveLength(1);
    expect(base).toContain("127.0.0.1");
  });

  it("tries again when the hub refuses, and gives up after three tries", async () => {
    const hub = await fakeHub([500, 500, 202]);
    const websub = new WebSub(hub.url, "t", undefined);
    await websub.start("https://agent.example.com/hook", 3, 5);
    expect(hub.posts).toHaveLength(3);
    const never = await fakeHub([500]);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await new WebSub(never.url, "t", undefined).start("https://agent.example.com/hook", 3, 5);
    expect(never.posts).toHaveLength(3);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("after 3 attempts"));
  });

  it("stops trying as soon as it is closed", async () => {
    const hub = await fakeHub([500]);
    const websub = new WebSub(hub.url, "t", undefined);
    const started = websub.start("https://agent.example.com/hook", 3, 60_000);
    await vi.waitFor(() => expect(hub.posts).toHaveLength(1));
    await websub.stop();
    await started;
    expect(hub.posts).toHaveLength(1);
  });

  it("does not follow a redirect from the hub", async () => {
    const redirecting = createServer((_req, res) => res.writeHead(307, { Location: "http://127.0.0.1:1/" }).end());
    hubs.push(redirecting);
    await new Promise<void>((done) => redirecting.listen(0, "127.0.0.1", done));
    const websub = new WebSub(`http://127.0.0.1:${(redirecting.address() as AddressInfo).port}/`, "t", SECRET);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await websub.start("https://agent.example.com/hook", 1, 1);
    expect(websub.verified).toBe(false);
  });
});

describe("a webhook that is set up wrongly", () => {
  const fails = (webhook: object, message: RegExp) =>
    expect(start(agentSaying("x").agent, webhook)).rejects.toThrow(message);

  it("is refused at start", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await fails({ prompt: "${http:payload.}" }, /The webhook prompt is not valid: Invalid http variable format/);
    await fails({ subscription: { protocol: "websub", hub: "not a url", topic: "t" } }, /not a valid address/);
    await fails({ subscription: { protocol: "websub", hub: "ftp://hub.example.com", topic: "t" } }, /http or https address/);
    await fails({ subscription: { protocol: "other", hub: "https://hub.example.com", topic: "t" } }, /protocol 'other' is not yet supported/);
    await fails({ subscription: { protocol: "websub", hub: "http://hub.example.com", topic: "t", secret: SECRET } }, /secret was not sent to hub.example.com because it uses plain http/);
    await fails({ subscription: { protocol: "websub", hub: "http://hub.example.com", topic: "t", authentication: { type: "bearer", token: "x" } } }, /Credentials were not sent to hub.example.com because it uses plain http/);
    await fails({ subscription: { protocol: "websub", hub: "https://hub.example.com", topic: "t", authentication: { type: "oauth2" } } }, /'oauth2' authentication is not yet supported/);
    await fails({ subscription: { protocol: "websub", hub: "https://hub.example.com", topic: "t", authentication: { type: "bearer" } } }, /bearer authentication requires a 'token' field/);
  });

  it("may use a plain http hub when it sends no secret, or when the hub is on this machine", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await start(agentSaying("x").agent, { subscription: { protocol: "websub", hub: "http://127.0.0.1:1/hub", topic: "t", secret: SECRET } });
    await start(agentSaying("x").agent, { subscription: { protocol: "websub", hub: "http://127.0.0.1:1/hub", topic: "t" } });
    await start(agentSaying("x").agent, { subscription: { protocol: "websub", hub: "http://127.0.0.1:1/hub", topic: "t", authentication: { type: "bearer", token: "x" } } });
  });
});
