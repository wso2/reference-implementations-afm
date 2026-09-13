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
import {
  canClose,
  escapeAction,
  outsideClickAction,
  stageOf,
  START_CARDS,
  START_FOOTERS,
  START_SUBTITLES,
  START_TITLES,
  type StartStage,
  templatesNote,
} from "./start-flow";

const idle = { writing: false, hasDraft: false, hasQuestions: false };

describe("which Start step is showing", () => {
  it("is the chosen view while nothing is being written", () => {
    expect(stageOf("menu", idle)).toBe("menu");
    expect(stageOf("prompt", idle)).toBe("prompt");
  });

  it("keeps the templates and the import steps in front of everything else", () => {
    expect(stageOf("templates", { ...idle, writing: true })).toBe("templates");
    expect(stageOf("import", { ...idle, hasDraft: true })).toBe("import");
  });

  it("shows the waiting step, then the draft, then the questions", () => {
    expect(stageOf("prompt", { writing: true, hasDraft: true, hasQuestions: true })).toBe("writing");
    expect(stageOf("prompt", { writing: false, hasDraft: true, hasQuestions: true })).toBe("draft");
    expect(stageOf("prompt", { writing: false, hasDraft: false, hasQuestions: true })).toBe("questions");
  });
});

describe("what Escape does", () => {
  it("closes the dialog from the first step, which leaves the empty agent", () => {
    expect(escapeAction("menu")).toBe("close");
  });

  it("goes back to the first step from the steps opened from it", () => {
    for (const stage of ["templates", "prompt", "import"] as const) expect(escapeAction(stage)).toBe("back");
  });

  it("goes back to the description from the questions and the draft", () => {
    expect(escapeAction("questions")).toBe("restart");
    expect(escapeAction("draft")).toBe("restart");
  });

  it("does nothing while the file is being written", () => {
    expect(escapeAction("writing")).toBe("none");
  });
});

describe("what a click outside the dialog does", () => {
  it("closes it from the first step only, so nothing typed is lost by accident", () => {
    expect(outsideClickAction("menu")).toBe("close");
    for (const stage of ["templates", "prompt", "import", "questions", "writing", "draft"] as const) {
      expect(outsideClickAction(stage)).toBe("none");
    }
  });

  it("cannot close the dialog while the file is being written", () => {
    expect(canClose("writing")).toBe(false);
    expect(canClose("prompt")).toBe(true);
  });
});

const STAGES: StartStage[] = ["menu", "templates", "prompt", "import", "questions", "writing", "draft"];

describe("the words of the Start dialog", () => {
  it("gives every step a title and a footer", () => {
    for (const stage of STAGES) {
      expect(START_TITLES[stage]).not.toBe("");
      expect(START_FOOTERS[stage]).not.toBe("");
    }
  });

  it("writes every footer as full sentences that end with a full stop", () => {
    for (const stage of STAGES) expect(START_FOOTERS[stage]).toMatch(/^[A-Z].*\.$/);
  });

  it("keeps footers short enough to sit on two lines", () => {
    for (const stage of STAGES) expect(START_FOOTERS[stage].length).toBeLessThanOrEqual(110);
  });

  it("keeps key hints out of the footers", () => {
    for (const stage of STAGES) expect(START_FOOTERS[stage]).not.toMatch(/\bEsc\b/);
  });

  it("makes no claim about where agents are stored", () => {
    for (const stage of STAGES) expect(START_FOOTERS[stage]).not.toMatch(/stored|saved|this tab|installed/i);
  });

  it("ends every subtitle with a full stop", () => {
    for (const text of Object.values(START_SUBTITLES)) expect(text).toMatch(/\.$/);
  });

  it("names the number of templates in words", () => {
    expect(templatesNote(4)).toBe("Agents that already do something useful. Four to choose from.");
    expect(templatesNote(2)).toBe("Agents that already do something useful. Two to choose from.");
    expect(templatesNote(25)).toBe("Agents that already do something useful. 25 to choose from.");
  });

  it("says Generate with AI uses the person's own key", () => {
    expect(START_CARDS.generate).toContain("Uses your own API key.");
  });
});
