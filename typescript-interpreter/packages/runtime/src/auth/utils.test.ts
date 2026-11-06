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
import { isHttpsUrl, randomString } from "./utils";

describe("randomString", () => {
  it("is URL-safe and different each time", () => {
    expect(randomString()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomString()).not.toBe(randomString());
  });

  it("gives the requested number of random bytes", () => {
    expect(randomString(16)).toHaveLength(22);
  });
});

describe("isHttpsUrl", () => {
  it("is true only for an https address", () => {
    expect(isHttpsUrl("https://auth.example.com/token")).toBe(true);
  });

  it.each([["http://auth.example.com/token"], ["javascript:alert(1)"], ["not a url"], [""], [undefined], [null], [5]])("is false for %j", (value) => {
    expect(isHttpsUrl(value)).toBe(false);
  });
});
