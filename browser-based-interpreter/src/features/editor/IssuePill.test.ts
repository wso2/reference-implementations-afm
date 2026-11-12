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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AfmIssue } from "../../core/agent/agent-validation";
import { FileCheckPanel } from "../../ui/FileCheckPanel";
import { IssuePill, issueAnnouncement, mostSevereFirst } from "./IssuePill";

const error = (message: string, line: number | null = null): AfmIssue => ({
  severity: "error",
  message,
  field: "x",
  line,
});
const warning = (message: string): AfmIssue => ({ severity: "warning", message, field: "y", line: 9 });

describe("which problem comes first", () => {
  it("puts errors before warnings and keeps the order inside each", () => {
    const ordered = mostSevereFirst([warning("w1"), error("e1"), warning("w2"), error("e2")]);
    expect(ordered.map((issue) => issue.message)).toEqual(["e1", "e2", "w1", "w2"]);
  });
});

describe("what a screen reader hears", () => {
  it("names the count, the line and the first problem", () => {
    expect(issueAnnouncement([error("Unknown field 'a'.", 2)])).toBe("1 problem. Line 2. Unknown field 'a'.");
  });

  it("leaves the line out when there is none", () => {
    expect(issueAnnouncement([error("Broken.")])).toBe("1 problem. Broken.");
  });

  it("says nothing for no problems", () => {
    expect(issueAnnouncement([])).toBe("");
  });
});

describe("the list of problems", () => {
  it("shows a word between backticks as code", () => {
    const html = renderToStaticMarkup(
      createElement(FileCheckPanel, { issues: [error("`model.name` is required.", 3)] }),
    );
    expect(html).toContain("<code>model.name</code> is required.");
    expect(html).not.toContain("`");
  });
});

describe("reading a message that does not fit", () => {
  it("makes the message itself the button that opens the full text", () => {
    const html = renderToStaticMarkup(createElement(IssuePill, { issues: [error("A long message.", 4)] }));
    expect(html).toMatch(
      /<button class="u-pill-msg" title="A long message\." aria-expanded="false">A long message\.<\/button>/,
    );
    expect(html).not.toContain("u-pill-more");
  });
});
