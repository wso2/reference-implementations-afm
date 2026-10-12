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

import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PermissionRequestModal } from "./PermissionRequestModal";

function dialog(request: { name: string; args: unknown; serverId?: string }): string {
  return renderToStaticMarkup(
    createElement(PermissionRequestModal, { request: { id: "c1", ...request }, onDecide: () => {} }),
  );
}

describe("the window that asks before a tool runs", () => {
  const html = dialog({
    name: "docs__search",
    args: { query: "standup notes", limit: 5 },
    serverId: "https://docs.example.com/mcp",
  });

  it("names the tool and the host it will be sent to", () => {
    expect(html).toContain("<code>search</code>");
    expect(html).toContain("<strong>docs.example.com</strong>");
  });

  it("shows every argument as it will be sent", () => {
    expect(html).toContain("&quot;query&quot;: &quot;standup notes&quot;");
    expect(html).toContain("&quot;limit&quot;: 5");
  });

  it("offers to deny, allow once or always allow in this tab, and says nothing runs before the answer", () => {
    expect(html).toContain("Deny");
    expect(html).toContain("Allow once");
    expect(html).toContain("Always allow in this tab");
    expect(html).toContain("Nothing runs until you decide.");
  });

  it("says a tool without a server runs inside the tab", () => {
    expect(dialog({ name: "read_file", args: {} })).toContain("nothing leaves the browser");
  });
});

function buttonsOf(node: ReactNode): ReactElement<{ autoFocus?: boolean; children?: ReactNode }>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return Array.isArray(node) ? node.flatMap(buttonsOf) : [];
  return [
    ...(node.type === "button" ? [node as ReactElement<{ autoFocus?: boolean }>] : []),
    ...buttonsOf(node.props.children),
  ];
}

describe("where the cursor starts in the window that asks before a tool runs", () => {
  const tree = PermissionRequestModal({ request: { id: "c1", name: "docs__search", args: {} }, onDecide: () => {} });
  const focused = buttonsOf(tree).filter((button) => button.props.autoFocus === true);

  it("is on Deny, so a stray Enter while typing turns the call down instead of approving it", () => {
    expect(focused).toHaveLength(1);
    expect(focused[0]?.props.children).toBe("Deny");
  });
});
