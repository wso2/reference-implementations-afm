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
import { bytesToBase64, bytesToBase64Url } from "./base64";

describe("bytesToBase64", () => {
  it("writes the usual base64", () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe("aGk=");
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });

  it("handles more bytes than one chunk", () => {
    const bytes = new Uint8Array(30_000).fill(65);
    expect(atob(bytesToBase64(bytes))).toBe("A".repeat(30_000));
  });
});

describe("bytesToBase64Url", () => {
  it("uses - and _ and leaves out the = padding", () => {
    expect(bytesToBase64Url(new Uint8Array([251, 255, 254]))).toBe("-__-");
    expect(bytesToBase64Url(new Uint8Array([104, 105]))).toBe("aGk");
  });

  it("gives 22 characters for 16 random bytes, different each time", () => {
    const first = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    expect(first).toHaveLength(22);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))));
  });
});
