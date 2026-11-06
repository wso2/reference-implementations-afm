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
import { ApprovalCard, argsText, destinationOf } from "./ApprovalCard";

function card(request: { name: string; args: unknown; serverId?: string }): string {
  return renderToStaticMarkup(createElement(ApprovalCard, { request: { id: "c1", ...request }, onDecide: () => {} }));
}

describe("the card that asks before a tool runs", () => {
  const html = card({
    name: "docs__search",
    args: { query: "standup notes", limit: 5 },
    serverId: "https://docs.example.com/mcp",
  });

  it("names the tool and the host it will be sent to", () => {
    expect(html).toContain("<code>search</code>");
    expect(html).toContain("docs.example.com");
  });

  it("shows every argument straight away, in a box that can be scrolled with the keyboard", () => {
    expect(html).toContain("&quot;query&quot;: &quot;standup notes&quot;");
    expect(html).toContain("&quot;limit&quot;: 5");
    expect(html).toContain('class="ap-args" tabindex="0"');
    expect(html).not.toContain("Details");
  });

  it("offers exactly Allow, Always allow and Deny, in that order", () => {
    const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
    expect(buttons).toEqual(["Allow", "Always allow", "Deny"]);
    expect(html).not.toContain("Allow once");
    expect(html).not.toContain("in this tab");
  });

  it("has no pop-up frame around it", () => {
    expect(html).not.toContain("overlay");
    expect(html).not.toContain("modal");
  });

  it("leaves the argument box out when the tool takes no arguments", () => {
    expect(card({ name: "docs__whoami", args: {} })).not.toContain("ap-args");
    expect(card({ name: "docs__whoami", args: undefined })).not.toContain("ap-args");
  });
});

describe("where the card says the tool goes", () => {
  it("is the host of the server", () => {
    expect(destinationOf("https://docs.example.com/mcp")).toBe("docs.example.com");
  });

  it("is this tab for a tool without a server", () => {
    expect(destinationOf(undefined)).toBe("this tab");
    expect(destinationOf("")).toBe("this tab");
  });
});

describe("the arguments text", () => {
  it("is indented JSON", () => {
    expect(argsText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("is nothing for no arguments, an empty object or an empty list", () => {
    expect(argsText(undefined)).toBeNull();
    expect(argsText(null)).toBeNull();
    expect(argsText({})).toBeNull();
    expect(argsText([])).toBeNull();
  });
});
