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
import { ModelPanel } from "./ModelPanel";

const CONTENT = `---
name: Tester
model:
  provider: openai
  name: gpt-4o
  authentication:
    type: api-key
    api_key: \${env:OPENAI_API_KEY}
---

# Role
r
`;

function panel(savedSecrets: string[]): string {
  return renderToStaticMarkup(
    createElement(ModelPanel, {
      content: CONTENT,
      savedSecrets,
      issue: null,
      onApply: () => {},
      onSaveKey: () => {},
      onClose: () => {},
    }),
  );
}

describe("a file with no model yet", () => {
  const html = renderToStaticMarkup(
    createElement(ModelPanel, {
      content: "---\nname: Tester\n---\n\n# Role\nr\n",
      savedSecrets: [],
      issue: null,
      onApply: () => {},
      onSaveKey: () => {},
      onClose: () => {},
    }),
  );

  it("offers the providers and none of the models until one is chosen", () => {
    expect(html).toContain("OpenAI");
    expect(html).not.toContain("u-row");
    expect(html).not.toContain("u-radio");
  });

  it("tells the person what to do first", () => {
    expect(html).toContain("Select a provider to see its models.");
    expect(html).not.toContain("Select a model");
  });

  it("keeps Save off", () => {
    expect(html).toMatch(/<button class="u-btn primary" disabled="">Save<\/button>/);
  });
});

describe("a provider with no model yet", () => {
  const html = renderToStaticMarkup(
    createElement(ModelPanel, {
      content: "---\nname: Tester\nmodel:\n  provider: openai\n---\n\n# Role\nr\n",
      savedSecrets: [],
      issue: null,
      onApply: () => {},
      onSaveKey: () => {},
      onClose: () => {},
    }),
  );

  it("lists the models and says to select one", () => {
    expect(html).toContain("GPT-6.1 Sol");
    expect(html).toContain("Select a model to enable Save.");
    expect(html).not.toContain("Select a provider");
  });
});

describe("the key box in the Model window", () => {
  it("asks password managers not to offer to save the key", () => {
    const html = panel([]);
    expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('data-1p-ignore="true"');
    expect(html).toContain('data-lpignore="true"');
    expect(html).toContain('data-bwignore="true"');
    expect(html).toContain('data-form-type="other"');
    expect(html).toContain('spellCheck="false"');
  });
});

describe("the model panel's key", () => {
  it("says no key has been entered yet", () => {
    expect(panel([])).toContain("Not entered yet");
  });

  it("says a key typed in this session is only kept for the session", () => {
    expect(panel(["OPENAI_API_KEY"])).toContain("Entered");
  });

  it("ignores a key saved for another provider", () => {
    expect(panel(["ANTHROPIC_API_KEY"])).toContain("Not entered yet");
  });
});

describe("the status words in the Model window", () => {
  it("uses no lower-case status", () => {
    for (const html of [panel([]), panel(["OPENAI_API_KEY"])]) {
      expect(html).not.toMatch(/>(not entered yet|entered this session|not accepted)</);
    }
  });

  it("gives the Model window its own spacing", () => {
    expect(panel([])).toContain("u-panel-body is-model");
  });
});
