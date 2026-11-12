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
import { AuthFields, ServerTools, SIGN_IN_FAILED, SignInSection } from "./server-panel-sections";

const tools = (found: { name: string; description?: string }[] | null) =>
  renderToStaticMarkup(
    createElement(ServerTools, {
      url: "https://mcp.example.com/mcp",
      probing: false,
      found,
      error: null,
      allowed: ["search"],
      waiting: "Check again to list this server's tools.",
      onToggle: () => {},
      onToggleAll: () => {},
      onCheckAgain: () => {},
      checkable: true,
      showTip: () => {},
      hideTip: () => {},
    }),
  );

describe("a server's tool list", () => {
  it("lists the tools with a tick box each and no line about running without asking", () => {
    const html = tools([{ name: "search" }, { name: "delete" }]);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).not.toContain("run without asking");
    expect(html).not.toContain("Choose which run");
    expect(html).not.toContain("set separately");
  });

  it("says nothing about asking before there are any tools to tick", () => {
    expect(tools(null)).not.toContain("run without asking");
    expect(tools([])).not.toContain("run without asking");
  });
});

const token = { key: "token", name: "token", required: true, placeholder: "${env:MY_TOKEN}" };
const header = { key: "api_key", name: "api key", required: false, placeholder: "${env:MY_API_KEY}" };

const fields = (saved: (key: string) => boolean, rejected = false) =>
  renderToStaticMarkup(
    createElement(AuthFields, {
      fields: [token, header],
      values: {},
      secretEdits: {},
      saved,
      rejected,
      onValue: () => {},
      onSecretEdit: () => {},
      onSecretBlur: () => {},
    }),
  );

describe("the status beside a server's secret fields", () => {
  it("starts every status with a capital letter", () => {
    const none = fields(() => false);
    expect(none).toContain(">Required<");
    expect(none).toContain(">Optional<");
    expect(fields((key) => key === "token")).toContain("Saved");
    expect(fields(() => true, true)).toContain("Not accepted");
  });

  it("uses no lower-case status", () => {
    for (const html of [fields(() => false), fields(() => true), fields(() => true, true)]) {
      expect(html).not.toMatch(/>(required|optional|saved|not accepted)</);
    }
  });
});

describe("the box for a server's secret", () => {
  it("asks password managers not to offer to save it", () => {
    const html = fields(() => false);
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('data-1p-ignore="true"');
    expect(html).toContain('data-form-type="other"');
  });
});

describe("a tool's description", () => {
  const html = tools([{ name: "search", description: "Finds pages" }, { name: "delete" }]);

  it("is read out with its tick box, not only shown with the mouse", () => {
    const described = html.match(/aria-describedby="([^"]+)"/g) ?? [];
    expect(described).toHaveLength(1);
    const id = /aria-describedby="([^"]+)"/.exec(html)![1]!;
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain(">Finds pages<");
  });

  it("is not promised for a tool that has none", () => {
    expect(html.match(/aria-describedby/g)).toHaveLength(1);
  });
});

describe("how a server signs in", () => {
  const section = (note: unknown, method = "oauth2") =>
    renderToStaticMarkup(
      createElement(SignInSection, {
        method,
        onMethod: () => {},
        signedIn: false,
        incomplete: false,
        signIn: {
          formOpen: false,
          openForm: () => {},
          asking: false,
          waiting: false,
          ask: () => {},
          cancelAsk: () => {},
          question: { title: "Open the sign-in window?", text: "" },
          note,
          clearNote: () => {},
          noteRef: { current: null },
          signIn: () => {},
        } as never,
        onSignOut: () => {},
        fields: [],
        values: {},
        secretEdits: {},
        saved: () => false,
        rejected: false,
        onValue: () => {},
        onSecretEdit: () => {},
        onSecretBlur: () => {},
      }),
    );

  it("says which method is chosen to a screen reader", () => {
    const html = section(null, "oauth2");
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Provider sign-in</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>None</);
  });

  it("shows a failure that came without a reason", () => {
    expect(section({ status: "failed" })).toContain(SIGN_IN_FAILED);
  });

  it("shows the reason when there is one, in a few words", () => {
    const html = section({ status: "failed", reason: "Failed to fetch" });
    expect(html).toContain("Can&#x27;t be reached");
    expect(html).not.toContain(SIGN_IN_FAILED);
  });

  it("shows no failure when none happened", () => {
    expect(section(null)).not.toContain(SIGN_IN_FAILED);
  });
});
