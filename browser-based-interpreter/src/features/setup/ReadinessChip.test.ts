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

import { type AgentMetadata } from "@afm/engine";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { needsToRun } from "../../core/setup/readiness";
import { StageFoot } from "../../ui/StageFoot";
import { LEAVE_MS } from "../../ui/hooks";
import {
  chipAnnouncement,
  type ChipPhase,
  CONFIRM_MS,
  phaseOnStatus,
  ReadinessChip,
  SHOW_DELAY_MS,
} from "./ReadinessChip";

const MODEL = { name: "A", model: { provider: "openai", name: "gpt-4o" } } as AgentMetadata;
const needs = (role: string, instructions: string) => needsToRun({ role, instructions, metadata: MODEL })!;

function chip(role: string, instructions: string, phase: ChipPhase): string {
  return renderToStaticMarkup(
    createElement(ReadinessChip, { needs: needs(role, instructions), phase, onHold: () => {} }),
  );
}

describe("the readiness chip", () => {
  it("counts what is ready and ticks it", () => {
    const html = chip("a", "", "missing");
    expect(html).toContain("Ready: </span>2/3");
    expect(html.match(/u-need-item done/g)).toHaveLength(2);
    expect(html.match(/u-need-item todo/g)).toHaveLength(1);
  });

  it("lets the word Ready: drop away on a very small phone", () => {
    expect(chip("", "", "missing")).toContain('<span class="u-need-word">Ready: </span>');
  });

  it("names the three in order", () => {
    const html = chip("", "", "missing");
    expect(html.indexOf("Role")).toBeLessThan(html.indexOf("Instructions"));
    expect(html.indexOf("Instructions")).toBeLessThan(html.indexOf("Model"));
    expect(html).toContain("Ready: </span>1/3");
  });

  it("opens from a small circle that fills as the agent gets ready", () => {
    const html = chip("a", "", "missing");
    expect(html).toContain("u-need-dot");
    expect(html).toContain("stroke-dasharray:37.69911184307752 56.548667764616276");
    expect(chip("", "", "missing")).toContain("stroke-dasharray:18.84955592153876 56.548667764616276");
  });

  it("turns green and ticks all three while it says Ready to run", () => {
    const html = chip("a", "b", "confirm");
    expect(html).toContain("Ready to run");
    expect(html).toContain("u-need ready");
    expect(html).not.toContain("todo");
    expect(html).toContain("stroke-dasharray:56.548667764616276 56.548667764616276");
  });

  it("fades while it leaves", () => {
    expect(chip("a", "b", "leaving")).toContain("is-leaving");
  });

  it("is not there once hidden", () => {
    expect(chip("a", "b", "hidden")).toBe("");
  });
});

describe("what a screen reader is told", () => {
  it("says how many are ready and what is missing", () => {
    expect(chipAnnouncement(needs("a", ""), "missing")).toBe("2 of 3 ready. Instructions missing.");
    expect(chipAnnouncement(needs("", ""), "missing")).toBe("1 of 3 ready. Role and Instructions missing.");
  });

  it("says when it is ready to run", () => {
    expect(chipAnnouncement(needs("a", "b"), "confirm")).toBe("Ready to run");
  });

  it("says nothing when the chip goes away", () => {
    expect(chipAnnouncement(needs("a", "b"), "hidden")).toBe("");
    expect(chipAnnouncement(needs("a", "b"), "leaving")).toBe("");
  });
});

describe("the line under the editor", () => {
  const foot = (chipOn: boolean) =>
    renderToStaticMarkup(
      createElement(StageFoot, {
        state: { tone: "bad", lead: "Needs a role before it can run", chip: chipOn },
        onFix: () => {},
      }),
    );

  it("goes quiet when the chip says the same thing, but keeps its space", () => {
    const html = foot(true);
    expect(html).toContain("u-stage-foot is-covered");
    expect(html).toContain("Needs a role before it can run");
  });

  it("keeps speaking when the chip does not cover it", () => {
    expect(foot(false)).not.toContain("is-covered");
  });
});

describe("the readiness chip over the editor", () => {
  it("shows at once while the person is typing and something is missing", () => {
    expect(phaseOnStatus("hidden", "ready", "missing", true)).toBe("missing");
  });

  it("waits when an agent is opened with something missing", () => {
    expect(phaseOnStatus("hidden", "missing", "missing", false)).toBe("hidden");
    expect(phaseOnStatus("hidden", "ready", "missing", false)).toBe("hidden");
  });

  it("stays up once it is showing", () => {
    expect(phaseOnStatus("missing", "missing", "missing", false)).toBe("missing");
  });

  it("turns green when the last thing is typed in", () => {
    expect(phaseOnStatus("missing", "missing", "ready", true)).toBe("confirm");
  });

  it("stays hidden when an agent that is already complete is opened", () => {
    expect(phaseOnStatus("missing", "missing", "ready", false)).toBe("hidden");
    expect(phaseOnStatus("hidden", "ready", "ready", false)).toBe("hidden");
  });

  it("comes back at once when something goes missing, even while it is green", () => {
    expect(phaseOnStatus("confirm", "ready", "missing", false)).toBe("missing");
    expect(phaseOnStatus("leaving", "ready", "missing", false)).toBe("missing");
  });

  it("shows nothing when the file cannot be read", () => {
    expect(phaseOnStatus("missing", "missing", "none", true)).toBe("hidden");
    expect(phaseOnStatus("confirm", "ready", "none", false)).toBe("hidden");
  });

  it("keeps the green state or the fade it is in", () => {
    expect(phaseOnStatus("confirm", "ready", "ready", false)).toBe("confirm");
    expect(phaseOnStatus("leaving", "ready", "ready", false)).toBe("leaving");
  });

  it("opens after three seconds, stays green for three, then plays its closing animation", () => {
    expect(SHOW_DELAY_MS).toBe(3000);
    expect(CONFIRM_MS).toBe(3000);
    expect(LEAVE_MS).toBe(560);
  });
});
