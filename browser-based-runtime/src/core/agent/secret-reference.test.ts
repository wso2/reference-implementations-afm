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
import { secretNameOf, secretReference } from "./secret-reference";

describe("secretNameOf", () => {
  it("reads the name from a reference, with or without the env prefix", () => {
    expect(secretNameOf("${env:MY_KEY}")).toBe("MY_KEY");
    expect(secretNameOf("${MY_KEY}")).toBe("MY_KEY");
    expect(secretNameOf("  ${env: MY_KEY }  ")).toBe("MY_KEY");
  });

  it("gives nothing for a literal value, for another kind of reference, or for text around a reference", () => {
    expect(secretNameOf("sk-literal-key")).toBe("");
    expect(secretNameOf("${file:secret.txt}")).toBe("");
    expect(secretNameOf("Bearer ${env:MY_KEY}")).toBe("");
    expect(secretNameOf("")).toBe("");
  });
});

describe("secretReference", () => {
  it("writes the reference that secretNameOf reads back", () => {
    expect(secretReference("MY_KEY")).toBe("${env:MY_KEY}");
    expect(secretNameOf(secretReference("MY_KEY"))).toBe("MY_KEY");
  });
});
