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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceBar } from "./WorkspaceBar";

function bar(state: {
  canRun: boolean;
  running: boolean;
  agentsOpen?: boolean;
  runTip?: string;
  compact?: boolean;
  canAct?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(WorkspaceBar, {
      agentName: "Demo",
      saveFailed: false,
      canAct: true,
      open: null,
      onToggle: () => {},
      agentsOpen: false,
      onToggleAgents: () => {},
      onRun: () => {},
      runTip: "Start the agent with this file",
      onToggleTheme: () => {},
      dark: false,
      ...state,
    }),
  );
}

describe("the Run button", () => {
  it("offers Run before the agent has started", () => {
    const html = bar({ canRun: true, running: false });
    expect(html).toContain("u-play");
    expect(html).not.toContain("Re-run");
    expect(html).not.toContain('disabled=""');
  });

  it("offers Re-run once the file differs from the running agent", () => {
    const html = bar({ canRun: true, running: true });
    expect(html).toContain("Re-run");
    expect(html).not.toContain('disabled=""');
  });

  it("is gone while the running agent already matches the file", () => {
    const html = bar({ canRun: false, running: true });
    expect(html).not.toContain("u-play");
    expect(html).not.toContain("Re-run");
  });

  it("stays, as an outline button, while the file cannot run yet", () => {
    const html = bar({ canRun: false, running: false });
    expect(html).toContain("u-play");
    expect(html).toContain("is-blocked");
    expect(html).toContain('aria-disabled="true"');
  });

  it("can still be reached with the keyboard while blocked, so its reason can be heard", () => {
    expect(bar({ canRun: false, running: false })).not.toContain('disabled=""');
  });

  it("says why it is blocked on hover and focus", () => {
    const html = bar({ canRun: false, running: false, runTip: "Add instructions to run. Role is done." });
    expect(html).toContain('data-tip="Add instructions to run. Role is done."');
  });

  it("is not marked blocked when it can run", () => {
    const html = bar({ canRun: true, running: false });
    expect(html).not.toContain("is-blocked");
    expect(html).not.toContain("aria-disabled");
    expect(html).toContain('data-tip="Start the agent with this file"');
  });
});

describe("the agent name", () => {
  it("reads as collapsed while the agents list is closed", () => {
    expect(bar({ canRun: true, running: false })).toContain('aria-expanded="false"');
  });

  it("reads as expanded while the agents list is open", () => {
    expect(bar({ canRun: true, running: false, agentsOpen: true })).toContain('aria-expanded="true"');
  });
});

describe("the header on a narrow window", () => {
  it("keeps Share, About and the theme switch on a wide window", () => {
    const html = bar({ canRun: true, running: false });
    expect(html).toContain("Share this agent");
    expect(html).toContain("About this agent");
    expect(html).toContain("Switch to dark");
  });

  it("keeps only Run, Chat and Settings when narrow (Share and About move beside Build / Raw)", () => {
    const html = bar({ canRun: true, running: false, compact: true });
    expect(html).toContain("u-play");
    expect(html).toContain('aria-label="Chat"');
    expect(html).toContain('aria-label="Settings"');
    expect(html).not.toContain("Share this agent");
    expect(html).not.toContain("About this agent");
    expect(html).not.toContain("Switch to dark");
  });

  it("lets a long agent name shrink without losing the arrow", () => {
    expect(bar({ canRun: true, running: false })).toContain('class="u-agentname-text"');
  });
});

describe("the Share button", () => {
  it("is ready to use once the agent is built", () => {
    const html = bar({ canRun: true, running: false, canAct: true });
    expect(html).toContain('data-tip="Share this agent"');
    expect(html).not.toContain("Build the agent before sharing");
  });

  it("says why it cannot be used while the agent is not built yet", () => {
    const html = bar({ canRun: false, running: false, canAct: false });
    expect(html).toContain('data-tip="Build the agent before sharing"');
    expect(html).toContain('aria-label="Share this agent"');
  });
});
