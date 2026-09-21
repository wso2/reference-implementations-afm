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
import { shortAgo, whenAgo } from "./time";

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("whenAgo", () => {
  it.each([
    [10_000, "just now"],
    [MINUTE, "1 minute ago"],
    [45 * MINUTE, "45 minutes ago"],
    [HOUR, "1 hour ago"],
    [5 * HOUR, "5 hours ago"],
    [DAY, "yesterday"],
    [2 * DAY, "2 days ago"],
    [3 * DAY, "3 days ago"],
    [6 * DAY, "6 days ago"],
    [7 * DAY, "last week"],
    [8 * DAY, "8 days ago"],
    [40 * DAY, "40 days ago"],
  ])("says how long ago %i milliseconds was", (ago, words) => {
    expect(whenAgo(NOW - ago, NOW)).toBe(words);
  });
});

describe("shortAgo", () => {
  it.each([
    [10_000, "now"],
    [MINUTE, "1m"],
    [45 * MINUTE, "45m"],
    [HOUR, "1h"],
    [20 * HOUR, "20h"],
    [DAY - MINUTE, "23h"],
    [DAY, "1d"],
    [2 * DAY + 5 * HOUR, "2d"],
    [37 * DAY, "37d"],
  ])("writes %i milliseconds ago as %s", (ago, text) => {
    expect(shortAgo(NOW - ago, NOW)).toBe(text);
  });

  it("does not go negative when the clock is behind", () => {
    expect(shortAgo(NOW + HOUR, NOW)).toBe("now");
  });
});
