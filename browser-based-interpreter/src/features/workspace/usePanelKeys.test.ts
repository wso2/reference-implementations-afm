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
import { focusMove, openerAfter, type PanelsOpen, panelToClose } from "./usePanelKeys";

const open = (patch: Partial<PanelsOpen>): PanelsOpen => ({ left: false, side: false, over: false, ...patch });

describe("which panel Esc closes", () => {
  it("closes the panel that holds the focus", () => {
    expect(panelToClose("left", open({ left: true, side: true }))).toBe("left");
    expect(panelToClose("side", open({ left: true, side: true }))).toBe("chat");
  });

  it("closes the panel over the chat before the chat", () => {
    expect(panelToClose("side", open({ side: true, over: true }))).toBe("over");
    expect(panelToClose("other", open({ side: true, over: true }))).toBe("over");
  });

  it("closes the right side before the left when the focus is elsewhere on the page", () => {
    expect(panelToClose("other", open({ left: true, side: true }))).toBe("chat");
    expect(panelToClose("other", open({ left: true }))).toBe("left");
  });

  it("does nothing while a person types in the editor or clears a search", () => {
    expect(panelToClose("typing", open({ left: true, side: true, over: true }))).toBeNull();
  });

  it("does nothing when no panel is open", () => {
    expect(panelToClose("other", open({}))).toBeNull();
    expect(panelToClose("left", open({ side: true }))).toBeNull();
    expect(panelToClose("side", open({ left: true }))).toBeNull();
  });
});

describe("how the focus moves when a panel opens or closes", () => {
  it("moves in when a panel opens, and when one panel is swapped for another", () => {
    expect(focusMove({ top: null, depth: 0 }, { top: "chat", depth: 1 })).toBe("enter");
    expect(focusMove({ top: "chat", depth: 1 }, { top: "settings", depth: 2 })).toBe("enter");
    expect(focusMove({ top: "model", depth: 2 }, { top: "tools", depth: 2 })).toBe("swap");
  });

  it("goes back to the opener when a panel closes", () => {
    expect(focusMove({ top: "settings", depth: 2 }, { top: "chat", depth: 1 })).toBe("leave");
    expect(focusMove({ top: "chat", depth: 1 }, { top: null, depth: 0 })).toBe("leave");
  });

  it("leaves the focus alone when nothing changed", () => {
    expect(focusMove({ top: "chat", depth: 1 }, { top: "chat", depth: 1 })).toBe("none");
  });
});

describe("which control gets the focus back", () => {
  it("is the control that opened the panel", () => {
    expect(openerAfter("enter", "old", "new")).toBe("new");
    expect(openerAfter("swap", "old", "new")).toBe("new");
  });

  it("stays the stored one when a swap finds no new opener, so the first button is not forgotten", () => {
    expect(openerAfter("swap", "old", null)).toBe("old");
  });

  it("is nothing when a panel opens with no focused control", () => {
    expect(openerAfter("enter", "old", null)).toBeNull();
    expect(openerAfter("enter", null, null)).toBeNull();
  });
});
