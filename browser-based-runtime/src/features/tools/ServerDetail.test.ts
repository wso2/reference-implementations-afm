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
import { ServerDetail } from "./ServerDetail";
import { DIRECTORY_ENTRIES } from "../../core/mcp/mcp-directory";

function detail(id: string): string {
  const entry = DIRECTORY_ENTRIES.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`${id} is not in the directory`);
  return renderToStaticMarkup(createElement(ServerDetail, { entry, onBack: () => {}, onConnect: () => {} }));
}

describe("a server's detail", () => {
  it("names the publisher and the address it connects to", () => {
    const html = detail("linear");
    expect(html).toContain("<b>linear.app</b>");
    expect(html).toContain("https://mcp.linear.app/mcp");
  });

  it("marks the server as official", () => {
    expect(detail("linear")).toContain("Official");
  });

  it("links the page where the publisher documents the address, safely", () => {
    const html = detail("linear");
    expect(html).toContain('href="https://linear.app/docs/mcp"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('target="_blank"');
  });

  it("says who you will sign in with", () => {
    const html = detail("notion");
    expect(html).toContain("You will sign in with Notion.");
    expect(html).not.toContain("Needs a key");
  });

  it("says a server that needs no sign-in answers without one", () => {
    const html = detail("context7");
    expect(html).toContain("None. This server answers without signing in.");
    expect(html).not.toContain("Needs a key");
  });

  it("says what a keyed server asks for, and that it is kept as a secret", () => {
    const html = detail("github");
    expect(html).toContain("Needs a key");
    expect(html).toContain("Authorization");
    expect(html).toContain("stored as a secret");
    expect(html).toContain("A GitHub personal access token.");
  });

  it("offers Back and Connect", () => {
    const html = detail("notion");
    expect(html).toContain("← Back to directory");
    expect(html).toContain(">Connect</button>");
  });
});
