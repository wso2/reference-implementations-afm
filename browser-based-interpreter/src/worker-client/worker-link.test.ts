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


import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "../core/runtime/protocol";

const start = vi.hoisted(() => vi.fn());
vi.mock("../core/files/blob-worker", () => ({ startBlobWorker: start }));
import { WorkerLink } from "./worker-link";

class FakeWorker {
  posted: ClientMessage[] = [];
  listeners = new Map<string, Set<(event: MessageEvent<ServerMessage>) => void>>();
  terminate = vi.fn();
  postMessage(message: ClientMessage) {
    this.posted.push(structuredClone(message));
  }
  addEventListener(type: string, listener: (event: MessageEvent<ServerMessage>) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: MessageEvent<ServerMessage>) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(message: ServerMessage) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: message } as MessageEvent<ServerMessage>);
  }
  crash() {
    for (const listener of this.listeners.get("error") ?? []) listener({} as MessageEvent<ServerMessage>);
  }
}

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

function later<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  start.mockReset();
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function startedLink() {
  const worker = new FakeWorker();
  start.mockResolvedValue(worker);
  const seen: ServerMessage[] = [];
  const link = new WorkerLink((message) => seen.push(message));
  link.start();
  return { link, worker, seen };
}

describe("a link to the agent worker", () => {
  it("holds messages until the worker says it is ready, then sends them in order and asks for the secret names", async () => {
    const { link, worker } = startedLink();
    link.post({ type: "cancel" });
    link.post({ type: "reset-chat" });
    await settle();
    expect(worker.posted).toEqual([]);
    worker.emit({ type: "worker-ready" });
    expect(worker.posted).toEqual([{ type: "cancel" }, { type: "reset-chat" }, { type: "list-secrets" }]);
    link.post({ type: "continue" });
    expect(worker.posted.at(-1)).toEqual({ type: "continue" });
  });

  it("hands every other message to the page", async () => {
    const { link, worker, seen } = startedLink();
    await settle();
    worker.emit({ type: "worker-ready" });
    worker.emit({ type: "text-delta", text: "hi" });
    expect(seen).toEqual([{ type: "text-delta", text: "hi" }]);
    link.stop();
  });

  it("gives a check its own answer, and not another check's", async () => {
    const { link, worker } = startedLink();
    await settle();
    worker.emit({ type: "worker-ready" });
    const first = link.probe((id) => ({ type: "probe-model", id, model: undefined }));
    const second = link.probe((id) => ({ type: "probe-model", id, model: undefined }));
    const [one, two] = worker.posted.filter((m) => m.type === "probe-model") as { id: string }[];
    worker.emit({ type: "probe-result", id: two!.id, tools: [{ name: "b" }] });
    worker.emit({ type: "probe-result", id: one!.id, failure: { kind: "slow", message: "m" } });
    expect(await second).toEqual({ tools: [{ name: "b" }], failure: undefined });
    expect(await first).toEqual({ tools: undefined, failure: { kind: "slow", message: "m" } });
  });

  it("gives up on a check that nothing answers after 30 seconds", async () => {
    const { link, worker } = startedLink();
    await settle();
    worker.emit({ type: "worker-ready" });
    const check = link.probe((id) => ({ type: "probe-model", id, model: undefined }));
    vi.advanceTimersByTime(30_000);
    expect(await check).toMatchObject({ failure: { kind: "slow" } });
  });
});

describe("when the worker does not start", () => {
  it("tells the page, stops the worker and answers waiting checks, if it is not ready within 30 seconds", async () => {
    const { link, worker, seen } = startedLink();
    await settle();
    const check = link.probe((id) => ({ type: "probe-model", id, model: undefined }));
    vi.advanceTimersByTime(30_000);
    expect(seen).toEqual([{ type: "worker-stopped" }]);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(await check).toMatchObject({ failure: { kind: "other", message: "The agent worker stopped." } });
    link.post({ type: "cancel" });
    expect(worker.posted).toEqual([]);
    expect(start).toHaveBeenCalledOnce();
  });

  it("starts a new worker when the agent is run again, and delivers what was asked once it is ready", async () => {
    const { link, worker, seen } = startedLink();
    await settle();
    worker.crash();
    expect(seen).toEqual([{ type: "worker-stopped" }]);

    const fresh = new FakeWorker();
    start.mockResolvedValue(fresh);
    link.post({ type: "load", content: "agent" });
    await settle();
    expect(start).toHaveBeenCalledTimes(2);
    expect(fresh.posted).toEqual([]);
    fresh.emit({ type: "worker-ready" });
    expect(fresh.posted).toEqual([{ type: "load", content: "agent" }, { type: "list-secrets" }]);
    expect(seen).toEqual([{ type: "worker-stopped" }]);
  });

  it("tells the page again that the agent stopped when a draft is asked for after the crash", async () => {
    const { link, worker, seen } = startedLink();
    await settle();
    worker.crash();
    expect(seen).toEqual([{ type: "worker-stopped" }]);
    link.post({ type: "generate-draft", id: "r1", prompt: "a helper", model: { provider: "openai", name: "gpt" } as never });
    expect(seen).toEqual([{ type: "worker-stopped" }, { type: "worker-stopped" }]);
  });

  it("starts a new worker for a key typed after the crash, so the key is not lost", async () => {
    const { link, worker } = startedLink();
    await settle();
    worker.crash();
    const fresh = new FakeWorker();
    start.mockResolvedValue(fresh);
    link.post({ type: "set-secret", name: "KEY", value: "sk-new", provider: "openai" });
    await settle();
    expect(start).toHaveBeenCalledTimes(2);
    fresh.emit({ type: "worker-ready" });
    expect(fresh.posted).toEqual([
      { type: "set-secret", name: "KEY", value: "sk-new", provider: "openai" },
      { type: "list-secrets" },
    ]);
  });

  it("starts a new worker for a check or a sign-in as well, so Retry works", async () => {
    const { link, worker } = startedLink();
    await settle();
    worker.crash();
    const fresh = new FakeWorker();
    start.mockResolvedValue(fresh);
    const check = link.probe((id) => ({ type: "probe-model", id, model: undefined }));
    await settle();
    expect(start).toHaveBeenCalledTimes(2);
    fresh.emit({ type: "worker-ready" });
    const [sent] = fresh.posted.filter((m) => m.type === "probe-model") as { id: string }[];
    fresh.emit({ type: "probe-result", id: sent!.id });
    expect(await check).toEqual({ tools: undefined, failure: undefined });
  });

  it("does not start a worker again once the page has stopped using the link", async () => {
    const { link } = startedLink();
    await settle();
    link.stop();
    link.post({ type: "load", content: "agent" });
    expect(await link.probe((id) => ({ type: "probe-model", id, model: undefined }))).toMatchObject({ failure: { kind: "other" } });
    expect(start).toHaveBeenCalledOnce();
  });

  it("fails the same way when the worker script cannot be loaded or the worker crashes", async () => {
    start.mockRejectedValue(new Error("could not fetch worker"));
    const seen: ServerMessage[] = [];
    const link = new WorkerLink((message) => seen.push(message));
    link.start();
    await settle();
    expect(seen).toEqual([{ type: "worker-stopped" }]);

    const { link: other, worker, seen: otherSeen } = startedLink();
    await settle();
    worker.emit({ type: "worker-ready" });
    worker.crash();
    expect(otherSeen).toEqual([{ type: "worker-stopped" }]);
    other.stop();
  });

  it("says so once, however many times it fails", async () => {
    const { worker, seen } = startedLink();
    await settle();
    worker.crash();
    worker.crash();
    vi.advanceTimersByTime(60_000);
    expect(seen).toHaveLength(1);
  });
});

describe("when the page stops using the link", () => {
  it("answers waiting checks, stops the worker and ignores what it says after that", async () => {
    const { link, worker, seen } = startedLink();
    await settle();
    worker.emit({ type: "worker-ready" });
    const check = link.probe((id) => ({ type: "probe-model", id, model: undefined }));
    link.stop();
    expect(await check).toMatchObject({ failure: { message: "The agent session ended." } });
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.emit({ type: "text-delta", text: "late" });
    link.post({ type: "cancel" });
    expect(seen).toEqual([]);
    expect(worker.posted.filter((m) => m.type === "cancel")).toEqual([]);
  });

  it("stops a worker that only arrives after the link was stopped", async () => {
    const pending = later<FakeWorker>();
    start.mockReturnValue(pending.promise);
    const link = new WorkerLink(() => {});
    link.start();
    link.stop();
    const worker = new FakeWorker();
    pending.resolve(worker);
    await settle();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.listeners.size).toBe(0);
  });

  it("can start again, and only the newest worker counts (React starts, stops and starts again in development)", async () => {
    const first = later<FakeWorker>();
    const second = later<FakeWorker>();
    start.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const seen: ServerMessage[] = [];
    const link = new WorkerLink((message) => seen.push(message));
    link.start();
    link.stop();
    link.start();

    const oldWorker = new FakeWorker();
    const newWorker = new FakeWorker();
    second.resolve(newWorker);
    await settle();
    first.resolve(oldWorker);
    await settle();

    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    expect(newWorker.terminate).not.toHaveBeenCalled();
    newWorker.emit({ type: "worker-ready" });
    link.post({ type: "cancel" });
    expect(newWorker.posted).toEqual([{ type: "list-secrets" }, { type: "cancel" }]);
    expect(oldWorker.posted).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("is not failed by an earlier start whose worker could not load", async () => {
    const first = later<FakeWorker>();
    const second = later<FakeWorker>();
    start.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const seen: ServerMessage[] = [];
    const link = new WorkerLink((message) => seen.push(message));
    link.start();
    link.stop();
    link.start();
    first.reject(new Error("too late to matter"));
    await settle();
    const worker = new FakeWorker();
    second.resolve(worker);
    await settle();
    worker.emit({ type: "worker-ready" });
    expect(seen).toEqual([]);
    expect(worker.terminate).not.toHaveBeenCalled();
  });
});
