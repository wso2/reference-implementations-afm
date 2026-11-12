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
import { type AgentOrigin } from "../../core/storage/stores";
import { agentSections } from "./AgentPicker";

describe("agentSections", () => {
  const agent = (name: string, origin: AgentOrigin) => ({ name, origin });

  it("puts the agents the person wrote under Your agents and the ones from outside under Shared agents, keeping the order", () => {
    const mine = [agent("a", "blank"), agent("c", "blank")];
    const shared = [agent("b", "import"), agent("d", "import")];
    expect(agentSections([mine[0]!, shared[0]!, mine[1]!, shared[1]!])).toEqual([
      { label: "Your agents", agents: mine },
      { label: "Shared agents", agents: shared },
    ]);
  });

  it("leaves out a section with nothing in it", () => {
    expect(agentSections([agent("a", "blank")]).map((section) => section.label)).toEqual(["Your agents"]);
    expect(agentSections([agent("a", "import")]).map((section) => section.label)).toEqual(["Shared agents"]);
    expect(agentSections([])).toEqual([]);
  });
});
