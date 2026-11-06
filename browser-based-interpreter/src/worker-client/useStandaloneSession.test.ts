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
const extract = vi.hoisted(() => vi.fn());
vi.mock("../core/files/attachments", () => ({ MAX_TOTAL_BYTES: 100, extractFiles: extract }));
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

it("requests made after worker failure settle without queuing messages or opening sign-in", async () => {
  const worker = new FakeWorker();
  h.start.mockResolvedValue(worker);
  const session = useStandaloneSession();
  const cleanup = h.effects[0]!() as () => void;
  await tick();
  worker.emit({ type: "worker-ready" });
  worker.error();
  const before = worker.posted.length;
  expect(await session.probeModel(undefined)).toMatchObject({ failure: { kind: "other" } });
  expect(
    await session.startOAuthSignIn({
      authorizeUrl: "https://fake.example/a",
      tokenUrl: "https://fake.example/t",
      clientId: "fake",
      resource: "https://fake.example/mcp",
    }),
  ).toMatchObject({ status: "failed" });
  expect(worker.posted).toHaveLength(before);
  cleanup();
});

it("drops attachment cards when an earlier conversation is resumed, because the worker no longer holds the files", async () => {
  const worker = new FakeWorker();
  h.start.mockResolvedValue(worker);
  const session = useStandaloneSession();
  const cleanup = h.effects[0]!() as () => void;
  await tick();
  worker.emit({ type: "worker-ready" });
  session.loadContent("agent", [
    { kind: "user", id: 1, text: "read it" },
    { kind: "attachment", id: 2, files: [{ name: "notes.md" }] },
    { kind: "assistant", id: 3, text: "done" },
  ]);
  expect(h.dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "restore-session",
      messages: [
        { kind: "user", id: 1, text: "read it" },
        { kind: "assistant", id: 3, text: "done" },
      ],
    }),
  );
  cleanup();
});

it("takes files one drop at a time, so two quick drops cannot together pass the size limit", async () => {
  const worker = new FakeWorker();
  h.start.mockResolvedValue(worker);
  const session = useStandaloneSession();
  const cleanup = h.effects[0]!() as () => void;
  await tick();
  worker.emit({ type: "worker-ready" });
  const remaining: number[] = [];
  extract.mockImplementation(async (_files: unknown, left: number) => {
    remaining.push(left);
    await tick();
    return { attached: [], skipped: [], sizes: new Map([["a.md", 60]]) };
  });
  await Promise.all([session.attachFiles([]), session.attachFiles([])]);
  expect(remaining).toEqual([100, 40]);
  cleanup();
});
