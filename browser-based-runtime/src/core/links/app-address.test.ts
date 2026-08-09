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
import { appAddress } from "./app-address";

describe("the address AFM is served from", () => {
  it("is the origin followed by a slash when the site is served from the root", () => {
    expect(appAddress("https://afm.example.com", "/")).toBe("https://afm.example.com/");
  });

  it("includes the folder the site is served from, so a project site does not point at its owner's root", () => {
    expect(appAddress("https://wso2.github.io", "/reference-implementations-afm/")).toBe(
      "https://wso2.github.io/reference-implementations-afm/",
    );
  });

  it("reads a relative base as the root", () => {
    expect(appAddress("http://localhost:5173", "./")).toBe("http://localhost:5173/");
  });
});
