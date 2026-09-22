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
import { iconUrlError, markColour } from "./Marks";

describe("markColour", () => {
  it("gives the same colour to the same name every time", () => {
    expect(markColour("gitlab")).toBe(markColour("gitlab"));
  });

  it("returns a colour for any name, including an empty one", () => {
    for (const name of ["", "a", "a much longer server name", "ünïcode"]) {
      expect(markColour(name)).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("tells at least some different names apart", () => {
    const colours = new Set(["linear", "gitlab", "notion", "deepwiki", "context7", "sentry"].map(markColour));
    expect(colours.size).toBeGreaterThan(1);
  });
});

describe("iconUrlError", () => {
  it("accepts an https link, with or without surrounding spaces", () => {
    expect(iconUrlError("https://example.com/icon.png")).toBeNull();
    expect(iconUrlError("  https://example.com/icon.png  ")).toBeNull();
  });

  it("asks for https when the link is plain http or another kind", () => {
    for (const bad of [
      "http://example.com/i.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "ftp://example.com/i.png",
    ]) {
      expect(iconUrlError(bad)).toBe("Use a link that starts with https://");
    }
  });

  it("asks for a full link when it is not one", () => {
    for (const bad of ["", "example.com/icon.png", "icon.png", "${env:ICON}"]) {
      expect(iconUrlError(bad)).toBe("Paste a full link that starts with https://");
    }
  });
});
