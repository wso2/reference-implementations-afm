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

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SidePane } from "./SideWindow";

const pane = (props: Partial<Parameters<typeof SidePane>[0]> = {}) =>
  renderToStaticMarkup(createElement(SidePane, { title: "Chat", onClose: () => {}, children: "x", ...props }));

describe("a side pane", () => {
  it("can be reached by default", () => {
    expect(pane()).not.toContain("inert");
  });

  it("is taken out of the tab order and the reading order while another panel covers it", () => {
    expect(pane({ covered: true })).toContain('inert=""');
  });

  it("can ask for a steady height, so its content does not move the sheet", () => {
    expect(pane({ over: true, tall: true })).toContain("is-tall");
    expect(pane({ over: true })).not.toContain("is-tall");
  });
});
