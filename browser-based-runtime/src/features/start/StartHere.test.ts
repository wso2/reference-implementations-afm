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
import { EXAMPLES } from "../../core/agent/examples";
import { type ChatState, initialChatState } from "../../core/chat/chat-state";
import { StartHere } from "./StartHere";
import { START_FOOTERS, type StartView, templatesNote } from "./start-flow";

interface Options {
  dialog?: boolean;
  view?: StartView;
  state?: Partial<ChatState>;
}

function render({ dialog = true, view = "menu", state = {} }: Options = {}): string {
  return renderToStaticMarkup(
    createElement(StartHere, {
      state: { ...initialChatState, ...state },
      dialog,
      initialView: view,
      onUseSource: () => {},
      onGenerate: () => {},
      onDismissDraft: () => {},
      onSaveKey: () => {},
      onBlank: () => {},
    }),
  );
}

const decode = (html: string) => html.replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

describe("Start as a dialog", () => {
  it("asks how to begin with four cards, the first one marked", () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain("Start a new agent");
    for (const name of ["Blank", "Generate with AI", "From a template", "Import a file"]) expect(html).toContain(name);
    expect(html.match(/u-dlg-card/g)).toHaveLength(4);
    expect(html).toMatch(/class="u-dlg-card on"[^>]*data-autofocus/);
  });

  it("says the Generate card uses the person's own key, and counts the templates", () => {
    const html = render();
    expect(html).toContain("Uses your own API key.");
    expect(html).toContain(templatesNote(EXAMPLES.length));
  });

  it("can be closed from the first step", () => {
    expect(render()).toContain('aria-label="Close"');
  });

  it("shows the footer of the step that is showing", () => {
    expect(render()).toContain(START_FOOTERS.menu);
    expect(render({ view: "templates" })).toContain(START_FOOTERS.templates);
    expect(render({ view: "prompt" })).toContain(START_FOOTERS.prompt);
    expect(render({ view: "import" })).toContain(START_FOOTERS.import);
    expect(render({ state: { generatedDraft: "---\nname: A\n---" } })).toContain(START_FOOTERS.draft);
    expect(render({ state: { clarifyQuestions: ["Who is it for?"] } })).toContain(START_FOOTERS.questions);
  });

  it("lists every template as a card, with a way back", () => {
    const html = render({ view: "templates" });
    expect(html).toContain("From a template");
    for (const example of EXAMPLES) expect(html).toContain(example.title);
    expect(html.match(/u-dlg-card row/g)).toHaveLength(EXAMPLES.length);
    expect(html).toContain("u-dlg-back");
  });

  it("opens the description form with no provider or model chosen, and a way back", () => {
    const html = decode(render({ view: "prompt" }));
    expect(html).toContain("Generate with AI");
    expect(html).toContain("Model that writes the file");
    expect(html).not.toContain("Written by your own model");
    expect(html).toContain("Choose a provider");
    expect(html).toContain("Choose a model");
    expect(html).not.toContain("API usage will be used to write this file.");
    expect(html).not.toContain("OPENAI_API_KEY");
    expect(html).toContain("u-dlg-back");
  });

  it("keeps the invisible file box out of the Tab order and away from screen readers", () => {
    const input = render({ view: "import" }).match(/<input[^>]*type="file"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('tabindex="-1"');
    expect(input).toContain('aria-hidden="true"');
  });

  it("makes the import step narrow", () => {
    const html = render({ view: "import" });
    expect(html).toContain('class="u-dlg narrow"');
    expect(html).toContain("Or paste a link to one");
  });

  it("shows the questions and the draft without a Back link, since Escape returns to the description", () => {
    const questions = render({ state: { clarifyQuestions: ["Who is it for?"] } });
    expect(questions).toContain("Who is it for?");
    expect(questions).not.toContain("u-dlg-back");
    const draft = render({ state: { generatedDraft: "---\nname: A\n---" } });
    expect(draft).toContain("Use this file");
    expect(draft).toContain("Write it again");
    expect(draft).not.toContain("u-dlg-back");
  });

  it("puts the draft's own explanation in the subtitle", () => {
    expect(decode(render({ state: { generatedDraft: "x" } }))).toContain("Nothing has been changed yet.");
  });
});

describe("Start as the phone sheet", () => {
  it("keeps the list and its own introduction, with no dialog around it", () => {
    const html = render({ dialog: false });
    expect(html).not.toContain("u-dlg");
    expect(html).toContain("u-start-opt");
    expect(html).toContain("The empty agent is already beside you.");
  });

  it("keeps its own titles on the other steps", () => {
    expect(render({ dialog: false, view: "templates" })).toContain("Pick a starting point");
    expect(render({ dialog: false, view: "prompt" })).toContain("Describe the agent you want");
    expect(render({ dialog: false, view: "import" })).toContain("Import a file");
  });
});
