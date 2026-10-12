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
import {
  NOTHING_OPEN,
  chatCloseAction,
  closePanel,
  openOver,
  openPanel,
  sideTitle,
  togglePanel,
} from "./workspace-view";
import type { SideState } from "./workspace-view";

const chat: SideState = { open: "chat", under: [] };

describe("opening a panel over the chat", () => {
  it("remembers the chat, so closing the panel gives it back", () => {
    const tools = openPanel(chat, "tools");
    expect(tools).toEqual({ open: "tools", under: ["chat"] });
    expect(closePanel(tools)).toEqual(chat);
  });

  it("does the same for every panel a person can open from the chat", () => {
    for (const panel of ["model", "tools", "share", "settings", "info", "setup"] as const) {
      expect(closePanel(openPanel(chat, panel))).toEqual(chat);
    }
  });

  it("keeps the chat when one panel is swapped for another", () => {
    const model = openPanel(openPanel(chat, "tools"), "model");
    expect(model).toEqual({ open: "model", under: ["chat"] });
    expect(closePanel(model)).toEqual(chat);
  });
});

describe("opening a panel over nothing", () => {
  it("closes back to nothing", () => {
    expect(openPanel(NOTHING_OPEN, "tools")).toEqual({ open: "tools", under: [] });
    expect(closePanel(openPanel(NOTHING_OPEN, "tools"))).toEqual(NOTHING_OPEN);
  });

  it("closing with nothing open stays closed", () => {
    expect(closePanel(NOTHING_OPEN)).toEqual(NOTHING_OPEN);
  });
});

describe("opening the chat", () => {
  it("shows it on its own, whatever was open before", () => {
    expect(openPanel(openPanel(chat, "setup"), "chat")).toEqual(chat);
  });

  it("is the same as the chat already showing", () => {
    expect(openPanel(chat, "chat")).toEqual(chat);
  });
});

describe("opening a panel from another panel", () => {
  it("comes back one step at a time: Setup, then the chat it was opened over", () => {
    const setup = openPanel(chat, "setup");
    const configuring = openOver(setup, "tools");
    expect(configuring).toEqual({ open: "tools", under: ["chat", "setup"] });
    const back = closePanel(configuring);
    expect(back).toEqual(setup);
    expect(closePanel(back)).toEqual(chat);
    expect(closePanel(closePanel(back))).toEqual(NOTHING_OPEN);
  });

  it("starts from nothing when nothing was open", () => {
    expect(openOver(NOTHING_OPEN, "tools")).toEqual({ open: "tools", under: [] });
  });
});

describe("the top bar's buttons", () => {
  it("open a panel that is not showing", () => {
    expect(togglePanel(chat, "share")).toEqual({ open: "share", under: ["chat"] });
  });

  it("close the one that is, back to the chat under it", () => {
    expect(togglePanel(togglePanel(chat, "share"), "share")).toEqual(chat);
  });

  it("close the chat itself when it is the one showing", () => {
    expect(togglePanel(chat, "chat")).toEqual(NOTHING_OPEN);
  });
});

describe("sideTitle", () => {
  it("is the panel's own title for most panels", () => {
    expect(sideTitle("model", null)).toBe("Model");
    expect(sideTitle("tools", null)).toBe("Connect tools");
    expect(sideTitle("model", "notion")).toBe("Model");
  });

  it("is the server's name, starting with a capital letter, while a server is being edited", () => {
    expect(sideTitle("tools", "todoist")).toBe("Todoist");
    expect(sideTitle("tools", "githubcopilot")).toBe("Githubcopilot");
  });
});

describe("chatCloseAction", () => {
  it("shrinks the whole-window chat back to the side window instead of closing it", () => {
    expect(chatCloseAction(true, false)).toBe("shrink");
  });

  it("closes the side window chat", () => {
    expect(chatCloseAction(false, false)).toBe("close");
  });

  it("closes the chat on a phone, where there is no separate side window to return to", () => {
    expect(chatCloseAction(true, true)).toBe("close");
    expect(chatCloseAction(false, true)).toBe("close");
  });
});
