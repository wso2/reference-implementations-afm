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
import { agentFilename } from "./download-agent-file";

describe("agentFilename", () => {
  it("names the file after the agent", () => {
    expect(agentFilename("---\nname: Trip Planner\n---\n")).toBe("trip-planner.afm.md");
  });

  it("falls back to a plain name when the agent has none, or only symbols", () => {
    expect(agentFilename("---\ndescription: x\n---\n")).toBe("agent.afm.md");
    expect(agentFilename('---\nname: "!!!"\n---\n')).toBe("agent.afm.md");
    expect(agentFilename("no front matter")).toBe("agent.afm.md");
  });
});
