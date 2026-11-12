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

export type StartView = "menu" | "templates" | "prompt" | "import";

export function stageOf(
  view: StartView,
  flow: { writing: boolean; hasDraft: boolean; hasQuestions: boolean },
): StartStage {
  if (view === "import" || view === "templates") return view;
  if (flow.writing) return "writing";
  if (flow.hasDraft) return "draft";
  if (flow.hasQuestions) return "questions";
  return view;
}

type EscapeAction = "close" | "back" | "restart" | "none";

export function escapeAction(stage: StartStage): EscapeAction {
  switch (stage) {
    case "menu":
      return "close";
    case "templates":
    case "prompt":
    case "import":
      return "back";
    case "questions":
    case "draft":
      return "restart";
    case "writing":
      return "none";
  }
}

export function outsideClickAction(stage: StartStage): "close" | "none" {
  return stage === "menu" ? "close" : "none";
}

export function canClose(stage: StartStage): boolean {
  return stage !== "writing";
}

export type StartStage = "menu" | "templates" | "prompt" | "import" | "questions" | "writing" | "draft";

export const START_TITLES: Record<StartStage, string> = {
  menu: "Start a new agent",
  templates: "From a template",
  prompt: "Generate with AI",
  import: "Import a file",
  questions: "A couple of questions first",
  writing: "Writing the file",
  draft: "Here is the file it wrote",
};

export const START_SUBTITLES: Partial<Record<StartStage, string>> = {
  menu: "Pick how you want to begin. You can change everything afterwards.",
  templates: "Opens in the editor, ready to run. Edit anything before you press Run.",
  prompt:
    "Say what it should do and how it should behave. The file appears in the editor for you to read before anything runs.",
  import: "Open an .afm.md you were sent, or paste a link to one.",
  draft:
    "Nothing has been changed yet. Using it puts this in the editor, where you can read it and edit it before pressing Run.",
};

export const START_FOOTERS: Record<StartStage, string> = {
  menu: "Every agent is a plain Markdown file that you can read, edit and share.",
  templates: "Templates are copied into a new agent that you can edit freely.",
  prompt: "The generated file is a draft. You can review and edit it before anything runs.",
  import: "The file opens in the editor first.",
  questions: "Answer briefly, or skip to write the file with what you have already provided.",
  writing: "Writing cannot be stopped once it has started.",
  draft: "AI-generated content can contain mistakes. Review it before you run it.",
};

const NUMBER_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

export function templatesNote(count: number): string {
  const word = NUMBER_WORDS[count] ?? String(count);
  return `Agents that already do something useful. ${word} to choose from.`;
}

export const START_CARDS = {
  blank: "Write the role and instructions yourself, in the editor.",
  generate: "Describe what you want and get a first version to edit. Uses your own API key.",
  import: "Open an .afm.md you were sent, or paste a link to one.",
} as const;
