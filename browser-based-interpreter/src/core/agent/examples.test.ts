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

import { describe, it, expect } from "vitest";
import { EXAMPLES } from "./examples";
import { previewAgent } from "./agent-validation";

describe("the built-in templates", () => {
  it("offers at least one", () => {
    expect(EXAMPLES.length).toBeGreaterThan(0);
  });

  it.each(EXAMPLES.map((example) => [example.title, example] as const))(
    "%s is a valid agent file that can run in a browser",
    (_title, example) => {
      const preview = previewAgent(example.content);
      expect(preview.ok ? "" : preview.error).toBe("");
      expect(preview.ok && preview.plan.runnable).toBe(true);
    },
  );

  it("gives each template its own name", () => {
    const titles = EXAMPLES.map((example) => example.title);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("the template icons", () => {
  it.each(EXAMPLES.map((example) => [example.title, example.icon] as const))(
    "%s has a line icon, not an emoji",
    (_title, icon) => {
      expect(icon).toMatch(/^M[-\d.,\sMLHVCSQTAZmlhvcsqtaz]+$/);
    },
  );
});
