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

import { type ReactNode, useEffect, useRef, useState } from "react";
import { type ChatState } from "../../core/chat/chat-state";
import { type AgentModelRef } from "../../core/runtime/protocol";
import { DialogFrame } from "../../ui/DialogFrame";
import {
  BackLink,
  DialogMenu,
  DraftView,
  ImportView,
  PanelMenu,
  PromptView,
  QuestionsView,
  SetupColumn,
  TemplatesView,
  useImport,
  useWriter,
} from "./StartViews";
import {
  canClose,
  escapeAction,
  outsideClickAction,
  stageOf,
  START_FOOTERS,
  START_SUBTITLES,
  START_TITLES,
  type StartStage,
  type StartView,
} from "./start-flow";

interface Props {
  state: ChatState;
  dialog?: boolean;
  initialView?: StartView;
  notice?: string;
  onUseSource: (source: string, fromOutside?: boolean) => void;
  onGenerate: (prompt: string, model: AgentModelRef, final?: boolean) => void;
  onDismissDraft: () => void;
  onSaveKey: (name: string, value: string, provider: string) => void;
  onBlank: () => void;
}

export function StartHere({
  state,
  onUseSource,
  onGenerate,
  onSaveKey,
  onDismissDraft,
  onBlank,
  dialog = false,
  initialView = "menu",
  notice,
}: Props) {
  const [view, setView] = useState<StartView>(initialView);
  const importer = useImport(onUseSource);
  const writer = useWriter(state, { onGenerate, onSaveKey });
  const { writing } = writer;
  const { cancel: cancelImport } = importer;

  useEffect(() => {
    if (view !== "import") cancelImport();
  }, [view]);

  // What the person typed (the description, the model, the key) is gone when this screen closes, so a draft that is
  // still being written, or questions about it, cannot be answered afterwards. Closing ends that draft.
  const dismissDraft = useRef(onDismissDraft);
  dismissDraft.current = onDismissDraft;
  useEffect(() => () => dismissDraft.current(), []);

  function restart() {
    onDismissDraft();
    setView("prompt");
  }

  const stage = stageOf(view, {
    writing,
    hasDraft: state.generatedDraft !== null,
    hasQuestions: state.clarifyQuestions.length > 0,
  });

  function escape() {
    const action = escapeAction(stage);
    if (action === "close") onBlank();
    else if (action === "back") setView("menu");
    else if (action === "restart") restart();
  }

  const actions = dialog ? "u-dlg-actions" : "u-panel-foot";

  function frame(
    which: StartStage,
    content: ReactNode,
    sheet: { slide?: boolean; back?: boolean; restart?: boolean },
    narrow = false,
  ) {
    if (!dialog) {
      return (
        <SetupColumn slide={sheet.slide}>
          {sheet.back === true && <BackLink onClick={() => setView("menu")} />}
          {sheet.restart === true && <BackLink onClick={restart} />}
          <h3 className="u-setup-title">{START_TITLES[which]}</h3>
          {START_SUBTITLES[which] !== undefined && <p className="u-setup-note">{START_SUBTITLES[which]}</p>}
          {content}
        </SetupColumn>
      );
    }
    return (
      <DialogFrame
        title={START_TITLES[which]}
        subtitle={START_SUBTITLES[which]}
        footer={START_FOOTERS[which]}
        narrow={narrow}
        focusKey={which}
        onBack={sheet.back === true ? () => setView("menu") : undefined}
        onClose={canClose(which) ? onBlank : undefined}
        onEscape={escape}
        onOutside={outsideClickAction(which) === "close" ? onBlank : undefined}
      >
        {content}
      </DialogFrame>
    );
  }

  if (view === "import") {
    return frame("import", <ImportView {...importer} />, { slide: true, back: true }, true);
  }

  if (view === "templates") {
    return frame("templates", <TemplatesView dialog={dialog} onUseSource={onUseSource} />, { slide: true, back: true });
  }

  if (writing) {
    return frame(
      "writing",
      <p className="u-generating">
        <span className="u-spinner" aria-hidden="true" />
        Generating…
      </p>,
      {},
      true,
    );
  }

  if (state.generatedDraft !== null) {
    const draft = state.generatedDraft;
    return frame(
      "draft",
      <DraftView
        draft={draft}
        actions={actions}
        onWriteAgain={() => {
          onDismissDraft();
          setView("prompt");
        }}
        onUse={() => onUseSource(draft)}
      />,
      {},
    );
  }

  if (state.clarifyQuestions.length > 0) {
    return frame(
      "questions",
      <QuestionsView questions={state.clarifyQuestions} writer={writer} actions={actions} />,
      { restart: true },
      true,
    );
  }

  if (view === "prompt") {
    return frame("prompt", <PromptView writer={writer} draftError={state.draftError} />, { slide: true, back: true });
  }

  if (dialog) {
    return frame("menu", <DialogMenu notice={notice} onBlank={onBlank} setView={setView} />, {});
  }

  return <PanelMenu notice={notice} onBlank={onBlank} setView={setView} />;
}
