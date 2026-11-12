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
import { useSettled } from "./hooks";

type Cell = { value: unknown };
let cells: Cell[] = [];
let cursor = 0;
let rerender: () => void = () => {};
const effects: { deps: unknown[]; cleanup: (() => void) | void }[] = [];

vi.mock("react", () => ({
  useState<T>(initial: T): [T, (next: T) => void] {
    const index = cursor++;
    cells[index] ??= { value: initial };
    const cell = cells[index];
    return [
      cell.value as T,
      (next: T) => {
        if (Object.is(cell.value, next)) return;
        cell.value = next;
        rerender();
      },
    ];
  },
  useEffect(fn: () => (() => void) | void, deps: unknown[]) {
    const index = cursor++;
    const previous = effects[index];
    const changed = previous === undefined || deps.some((dep, i) => !Object.is(dep, previous.deps[i]));
    if (!changed) return;
    previous?.cleanup?.();
    effects[index] = { deps, cleanup: fn() };
  },
}));

function render<T>(value: T, delayMs?: number): T {
  let out!: T;
  rerender = () => {
    cursor = 0;
    out = useSettled(value, delayMs);
  };
  rerender();
  return out;
}

beforeEach(() => {
  cells = [];
  cursor = 0;
  effects.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("useSettled", () => {
  it("returns the first value immediately", () => {
    expect(render(true)).toBe(true);
  });

  it("holds the previous value until the new one stops changing", () => {
    render(true);
    expect(render(false)).toBe(true);
    vi.advanceTimersByTime(299);
    expect(render(false)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(render(false)).toBe(false);
  });

  it("does not settle on a value that was only passed through mid-edit", () => {
    render(true);
    render(false);
    vi.advanceTimersByTime(200);
    render(true);
    vi.advanceTimersByTime(200);
    expect(render(true)).toBe(true);
  });
});
