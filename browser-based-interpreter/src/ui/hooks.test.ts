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

import { describe, expect, it } from "vitest";
import { createRunTracker, createSerialQueue, grownHeight } from "./hooks";

const MAX_COMPOSER_HEIGHT = 180;

describe("sizing the message box", () => {
  it("takes the content height while it fits", () => {
    expect(grownHeight(600, 26, MAX_COMPOSER_HEIGHT)).toBe(26);
    expect(grownHeight(600, 90, MAX_COMPOSER_HEIGHT)).toBe(90);
  });

  it("stops at the cap and lets the box scroll instead", () => {
    expect(grownHeight(600, 4000, MAX_COMPOSER_HEIGHT)).toBe(MAX_COMPOSER_HEIGHT);
  });

  it("stops at a cap of its own for a box that is not the message box", () => {
    expect(grownHeight(300, 90, 200)).toBe(90);
    expect(grownHeight(300, 4000, 200)).toBe(200);
  });

  it("refuses to answer for a box that is not on screen", () => {
    expect(grownHeight(0, 4000, MAX_COMPOSER_HEIGHT)).toBeNull();
    expect(grownHeight(0, 26, MAX_COMPOSER_HEIGHT)).toBeNull();
  });

  it("treats a negative width the same as none", () => {
    expect(grownHeight(-10, 26, MAX_COMPOSER_HEIGHT)).toBeNull();
  });
});

describe("keeping only the newest of overlapping runs", () => {
  it("treats an older run as stale once a newer one has begun for the same key", () => {
    const runs = createRunTracker();
    const first = runs.begin("model");
    const second = runs.begin("model");
    expect(runs.isCurrent("model", first)).toBe(false);
    expect(runs.isCurrent("model", second)).toBe(true);
  });

  it("keeps different keys apart", () => {
    const runs = createRunTracker();
    const model = runs.begin("model");
    runs.begin("server");
    expect(runs.isCurrent("model", model)).toBe(true);
  });

  it("makes every run so far stale on reset", () => {
    const runs = createRunTracker();
    const run = runs.begin("model");
    runs.reset();
    expect(runs.isCurrent("model", run)).toBe(false);
  });
});

describe("a queue that runs one task after another", () => {
  it("starts a task only when the one before it has finished", async () => {
    const enqueue = createSerialQueue();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    enqueue(async () => {
      events.push("first starts");
      await gate;
      events.push("first ends");
    });
    enqueue(async () => {
      events.push("second starts");
    });
    await Promise.resolve();
    expect(events).toEqual(["first starts"]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first starts", "first ends", "second starts"]);
  });

  it("keeps going after a task that fails", async () => {
    const enqueue = createSerialQueue();
    const events: string[] = [];
    enqueue(async () => {
      throw new Error("no");
    });
    enqueue(async () => {
      events.push("ran");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["ran"]);
  });
});
