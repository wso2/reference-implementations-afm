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
const h = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[], start: vi.fn(), dispatch: vi.fn() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) => ({ current }),
  useReducer: (_reducer: unknown, state: unknown) => [state, h.dispatch],
  useEffect: (effect: () => void | (() => void)) => {
    h.effects.push(effect);
  },
}));
vi.mock("../core/files/blob-worker", () => ({ startBlobWorker: h.start }));
import { useStandaloneSession } from "./useStandaloneSession";
class FakeWorker {
  posted: ClientMessage[] = [];
  listeners = new Map<string, Set<(event: MessageEvent<ServerMessage>) => void>>();
  terminate = vi.fn();
  postMessage(message: ClientMessage, transfer: Transferable[] = []) {
    this.posted.push(structuredClone(message, { transfer }));
  }
  addEventListener(type: string, listener: (event: MessageEvent<ServerMessage>) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: MessageEvent<ServerMessage>) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(message: ServerMessage) {
    for (const listener of this.listeners.get("message") ?? [])
      listener({ data: message } as MessageEvent<ServerMessage>);
  }
  error() {
    for (const listener of this.listeners.get("error") ?? []) listener({} as MessageEvent<ServerMessage>);
  }
}
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
beforeEach(() => {
  h.effects.length = 0;
  h.start.mockReset();
  h.dispatch.mockReset();
  vi.stubGlobal("window", { setTimeout, clearTimeout });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("session worker readiness and lifecycle", () => {
  it("queues startup messages and sends them only after worker-ready", async () => {
    let release!: (worker: FakeWorker) => void;
    h.start.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const session = useStandaloneSession();
    const cleanup = h.effects[0]!() as () => void;
    session.loadContent("fake-source");
    session.storeSecret("A", "fake-secret");
    const worker = new FakeWorker();
    release(worker);
    await tick();
    expect(worker.posted).toEqual([]);
    worker.emit({ type: "worker-ready" });
    await tick();
    expect(worker.posted.slice(0, 3)).toEqual([
      expect.objectContaining({ type: "load" }),
      { type: "set-secret", name: "A", value: "fake-secret", address: undefined },
      { type: "list-secrets" },
    ]);
    cleanup();
  });
  it("settles a queued check when startup fails", async () => {
    h.start.mockRejectedValue(new Error("could not fetch worker"));
    const session = useStandaloneSession();
    const cleanup = h.effects[0]!() as () => void;
    expect(await session.probeModel(undefined)).toMatchObject({ failure: { kind: "other" } });
    cleanup();
  });
  it("terminates a worker that arrives after the startup deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    let release!: (worker: FakeWorker) => void;
    h.start.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const session = useStandaloneSession();
    const cleanup = h.effects[0]!() as () => void;
    const pending = session.probeModel(undefined);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await pending).toMatchObject({ failure: { kind: "other" } });
    const worker = new FakeWorker();
    release(worker);
    await tick();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    cleanup();
  });
  it("a worker error settles pending checks", async () => {
    const worker = new FakeWorker();
    h.start.mockResolvedValue(worker);
    const session = useStandaloneSession();
    const cleanup = h.effects[0]!() as () => void;
    await tick();
    worker.emit({ type: "worker-ready" });
    const probe = session.probeModel(undefined);
    await tick();
    worker.error();
    expect(await probe).toMatchObject({ failure: { kind: "other" } });
    cleanup();
  });
  it("ordinary agent changes reuse the existing worker, while remount creates a new session", async () => {
    const worker = new FakeWorker();
    h.start.mockResolvedValue(worker);
    const session = useStandaloneSession();
    const cleanup = h.effects[0]!() as () => void;
    await tick();
    worker.emit({ type: "worker-ready" });
    session.loadContent("first");
    session.clearAgent();
    session.loadContent("second");
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(worker.terminate).not.toHaveBeenCalled();
    cleanup();
    h.effects.length = 0;
    const replacement = new FakeWorker();
    h.start.mockResolvedValue(replacement);
    const next = useStandaloneSession();
    const end = h.effects[0]!() as () => void;
    await tick();
    replacement.emit({ type: "worker-ready" });
    const pending = next.probeModel(undefined);
    await tick();
    end();
    expect(await pending).toMatchObject({ failure: { kind: "other" } });
    expect(h.start).toHaveBeenCalledTimes(2);
  });
});

it("tells the chat when the worker fails, and starts a new worker for the next check instead of using the dead one", async () => {
  const worker = new FakeWorker();
  h.start.mockResolvedValue(worker);
  const session = useStandaloneSession();
  const cleanup = h.effects[0]!() as () => void;
  await tick();
  worker.emit({ type: "worker-ready" });
  worker.error();
  expect(h.dispatch).toHaveBeenCalledWith({ type: "server", message: { type: "worker-stopped" } });
  const before = worker.posted.length;

  const fresh = new FakeWorker();
  h.start.mockResolvedValue(fresh);
  const check = session.probeModel(undefined);
  await tick();
  fresh.emit({ type: "worker-ready" });
  const [asked] = fresh.posted.filter((message) => message.type === "probe-model") as { id: string }[];
  fresh.emit({ type: "probe-result", id: asked!.id, failure: { kind: "missing", message: "no key" } });
  expect(await check).toMatchObject({ failure: { kind: "missing" } });
  expect(worker.posted).toHaveLength(before);
  cleanup();
});

it("tells the chat again that the agent stopped when a message is sent to a worker that has already stopped", async () => {
  const worker = new FakeWorker();
  h.start.mockResolvedValue(worker);
  const session = useStandaloneSession();
  const cleanup = h.effects[0]!() as () => void;
  await tick();
  worker.emit({ type: "worker-ready" });
  worker.error();
  h.dispatch.mockClear();
  session.send("hello");
  expect(h.dispatch).toHaveBeenCalledWith({ type: "server", message: { type: "worker-stopped" } });
  expect(worker.posted.some((message) => message.type === "send")).toBe(false);
  cleanup();
});
