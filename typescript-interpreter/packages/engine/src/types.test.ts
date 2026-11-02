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
import { asMapping, asRecord, stringField } from "./types";

describe("asRecord", () => {
  it("accepts any object, arrays included", () => {
    const object = { a: 1 };
    const list = [1, 2];
    expect(asRecord(object)).toBe(object);
    expect(asRecord(list)).toBe(list);
  });

  it.each([[null], [undefined], ["text"], [5], [true]])("refuses %j", (value) => {
    expect(asRecord(value)).toBeNull();
  });
});

describe("asMapping", () => {
  it("accepts a plain object", () => {
    const object = { a: 1 };
    expect(asMapping(object)).toBe(object);
  });

  it.each([[[1, 2]], [null], [undefined], ["text"], [5]])("refuses %j", (value) => {
    expect(asMapping(value)).toBeNull();
  });
});

describe("stringField", () => {
  it("reads a string value", () => {
    expect(stringField({ name: "demo" }, "name")).toBe("demo");
  });

  it.each([[{ name: 5 }], [{ name: null }], [{ name: ["a"] }], [{}]])("gives an empty string for %j", (record) => {
    expect(stringField(record, "name")).toBe("");
  });
});
