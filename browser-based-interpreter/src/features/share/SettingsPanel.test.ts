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
import { describe, expect, it, vi } from "vitest";
import { type useStandaloneSession } from "../../worker-client/useStandaloneSession";
import { ForgetButton, SettingsPanel } from "./SettingsPanel";

vi.mock("../../app/contexts", () => ({ useThemeContext: () => ({ setting: "auto", setTheme: () => {} }) }));

function panel(savedSecrets: string[]): string {
  const session = { state: { savedSecrets } } as unknown as ReturnType<typeof useStandaloneSession>;
  return renderToStaticMarkup(
    createElement(SettingsPanel, { session, metadata: null, trusted: null, onTrustedChange: () => {} }),
  );
}

const count = (html: string, text: string) => html.split(`>${text}</button>`).length - 1;

describe("the keys in Settings", () => {
  it("says there is no key yet when nothing is saved", () => {
    expect(panel([])).toContain("No key yet.");
  });

  it("lists a key typed this session and offers to forget it", () => {
    const html = panel(["OPENAI_API_KEY"]);
    expect(html).toContain("OPENAI_API_KEY");
    expect(count(html, "Forget")).toBe(1);
  });

  it("keeps sign-ins out of the list of keys", () => {
    expect(panel(['afm.oauth.["a"].refresh'])).toContain("No key yet.");
  });
});

describe("the Permissions row in Settings", () => {
  const html = panel([]);

  it("is one button named Permissions that opens a window, with no sentence beside it", () => {
    expect(html).toContain('class="u-navrow"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toMatch(/<\/svg>Permissions<svg/);
    expect(html).not.toContain("run without asking");
  });

  it("sits between the keys and Appearance, and opens no window until it is pressed", () => {
    expect(html.indexOf("Your keys")).toBeLessThan(html.indexOf("u-navrow"));
    expect(html.indexOf("u-navrow")).toBeLessThan(html.indexOf("Appearance"));
    expect(html).not.toContain('role="dialog"');
  });
});

describe("the Forget button beside a saved key", () => {
  const html = renderToStaticMarkup(createElement(ForgetButton, { name: "OPENAI_API_KEY", onForget: () => {} }));

  it("starts as one quiet button that names the key and says it opens a question", () => {
    expect(html).toContain(">Forget<");
    expect(html).toContain('aria-label="Forget OPENAI_API_KEY"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("shows no question until it is pressed", () => {
    expect(html).not.toContain("u-confirm");
    expect(html).not.toContain("Forget this key?");
  });
});
