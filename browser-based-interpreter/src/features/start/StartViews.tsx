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

import { describeError } from "@afm/engine";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { findProvider, MODEL_PROVIDERS } from "../../core/agent/catalogs";
import { EXAMPLES } from "../../core/agent/examples";
import { secretReference } from "../../core/agent/secret-reference";
import { type ChatState } from "../../core/chat/chat-state";
import { brief, logDetails } from "../../core/chat/failure";
import { agentFileSizeError, fetchAgentFile, normalizeAgentFileUrl } from "../../core/links/load-paths";
import { agentFileFetch, McpProxyRequiredError } from "../../core/runtime/factories";
import { type AgentModelRef } from "../../core/runtime/protocol";
import { withCode } from "../../ui/FileCheckPanel";
import { useRunTracker } from "../../ui/hooks";
import { Icon } from "../../ui/Icon";
import { HIDDEN_FILE_INPUT, SECRET_INPUT } from "../../ui/inputs";
import { START_CARDS, START_SUBTITLES, type StartView, templatesNote } from "./start-flow";

export function SetupColumn({ children, slide = false }: { children: ReactNode; slide?: boolean }) {
  return (
    <div className="u-setup">
      <div className={slide ? "u-setup-col panel-slide-in" : "u-setup-col"}>{children}</div>
    </div>
  );
}

const ICON_PATHS = {
  blank: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6",
  generate: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
  template: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  file: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3",
  back: "M19 12H5M12 19l-7-7 7-7",
  warn: "M12 9v5M12 17.4h.01M10.3 3.9L2.4 17.4A2 2 0 004.1 20.5h15.8a2 2 0 001.7-3.1L13.7 3.9a2 2 0 00-3.4 0z",
};

function StartOption({
  icon,
  name,
  desc,
  onClick,
  on = false,
}: {
  icon: ReactNode;
  name: string;
  desc: string;
  onClick: () => void;
  on?: boolean;
}) {
  return (
    <button className={on ? "u-start-opt on" : "u-start-opt"} onClick={onClick}>
      <span className="u-start-ico" aria-hidden="true">
        {icon}
      </span>
      <span>
        <span className="u-start-name">{name}</span>
        <span className="u-start-desc">{desc}</span>
      </span>
    </button>
  );
}

interface CardItem {
  key: string;
  icon: ReactNode;
  name: string;
  desc: string;
  onPick: () => void;
}

function Cards({ items, row = false }: { items: CardItem[]; row?: boolean }) {
  const [active, setActive] = useState(0);
  const cards = useRef<(HTMLButtonElement | null)[]>([]);

  function move(from: number, key: string) {
    const to =
      key === "ArrowRight" ? from + 1 : key === "ArrowLeft" ? from - 1 : key === "ArrowDown" ? from + 2 : from - 2;
    if (to >= 0 && to < items.length) cards.current[to]?.focus();
  }

  return (
    <div className="u-dlg-grid">
      {items.map((item, index) => (
        <button
          key={item.key}
          ref={(element) => {
            cards.current[index] = element;
          }}
          className={`u-dlg-card${row ? " row" : ""}${index === active ? " on" : ""}`}
          data-autofocus={index === 0 ? "" : undefined}
          onMouseEnter={() => setActive(index)}
          onFocus={() => setActive(index)}
          onKeyDown={(event) => {
            if (!event.key.startsWith("Arrow")) return;
            event.preventDefault();
            move(index, event.key);
          }}
          onClick={item.onPick}
        >
          <span className="u-dlg-ico" aria-hidden="true">
            {item.icon}
          </span>
          <span>
            <span className="u-dlg-name">{item.name}</span>
            <span className="u-dlg-desc">{item.desc}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button className="u-back" onClick={onClick}>
      <Icon path={ICON_PATHS.back} size={14} />
      Back
    </button>
  );
}

export function useImport(onUseSource: (source: string, fromOutside?: boolean) => void) {
  const [link, setLink] = useState("");
  const [dropping, setDropping] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imports = useRunTracker();

  // A file read or a link fetch can finish after the person went back or chose something else.
  // Only the latest one may open its source, and nothing may after this screen is left.
  function cancel() {
    imports.begin("import");
    setFetching(false);
  }
  useEffect(() => () => void imports.begin("import"), [imports]);

  async function openFile(file: File | undefined) {
    if (file === undefined) return;
    const run = imports.begin("import");
    setFetching(false);
    const sizeError = agentFileSizeError(file.size);
    if (sizeError !== null) {
      setImportError(sizeError);
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (imports.isCurrent("import", run)) setImportError("That file could not be read.");
      return;
    }
    if (!imports.isCurrent("import", run)) return;
    setImportError(null);
    onUseSource(text, true);
  }

  async function openLink() {
    const normalized = normalizeAgentFileUrl(link.trim());
    if (!normalized.ok) {
      setImportError(normalized.error);
      return;
    }
    const run = imports.begin("import");
    setFetching(true);
    setImportError(null);
    try {
      const source = await fetchAgentFile(normalized.url, agentFileFetch());
      if (imports.isCurrent("import", run)) onUseSource(source, true);
    } catch (error) {
      if (!imports.isCurrent("import", run)) return;
      if (error instanceof McpProxyRequiredError) {
        logDetails(error.message);
        setImportError("Opening links is unavailable");
      } else {
        setImportError(brief(describeError(error)));
      }
    } finally {
      if (imports.isCurrent("import", run)) setFetching(false);
    }
  }

  return { link, setLink, dropping, setDropping, importError, fetching, fileInput, openFile, openLink, cancel };
}

export function ImportView({
  link,
  setLink,
  dropping,
  setDropping,
  importError,
  fetching,
  fileInput,
  openFile,
  openLink,
}: ReturnType<typeof useImport>) {
  return (
    <>
      <div
        className={`u-drop ${dropping ? "on" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDropping(false);
          void openFile(event.dataTransfer.files[0]);
        }}
        onClick={() => fileInput.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") fileInput.current?.click();
        }}
      >
        <span className="u-drop-ico" aria-hidden="true">
          <Icon path={ICON_PATHS.file} size={17} />
        </span>
        Drop an <code>.afm.md</code> here, or choose one
      </div>

      <div className="u-divider" />
      <label className="u-group">
        <span className="u-label">Or paste a link to one</span>
        <div className="u-input-row">
          <input
            className="u-input"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://…/agent.afm.md"
            onKeyDown={(event) => {
              if (event.key === "Enter") void openLink();
            }}
          />
          <button className="u-btn ghost" disabled={link.trim() === "" || fetching} onClick={() => void openLink()}>
            {fetching ? "Opening…" : "Open"}
          </button>
        </div>
      </label>
      {importError !== null && <p className="u-errcard">{importError}</p>}

      <input
        ref={fileInput}
        type="file"
        accept=".md,.afm.md,text/markdown,text/plain"
        {...HIDDEN_FILE_INPUT}
        onChange={(event) => void openFile(event.target.files?.[0])}
      />
    </>
  );
}

export function TemplatesView({ dialog, onUseSource }: { dialog: boolean; onUseSource: (source: string) => void }) {
  const items: CardItem[] = EXAMPLES.map((example) => ({
    key: example.title,
    icon: <Icon path={example.icon} size={15} />,
    name: example.title,
    desc: example.description,
    onPick: () => onUseSource(example.content),
  }));
  return dialog ? (
    <Cards row items={items} />
  ) : (
    <div className="u-start-list">
      {items.map((item) => (
        <StartOption key={item.key} icon={item.icon} name={item.name} desc={item.desc} onClick={item.onPick} />
      ))}
    </div>
  );
}

export function useWriter(
  state: ChatState,
  deps: {
    onGenerate: (prompt: string, model: AgentModelRef, final?: boolean) => void;
    onSaveKey: (name: string, value: string, provider: string) => void;
  },
) {
  const { onGenerate, onSaveKey } = deps;
  const [prompt, setPrompt] = useState("");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [key, setKey] = useState("");
  const [answers, setAnswers] = useState("");

  // The session knows whether a request is still waiting. That stays true if this screen is closed and opened again,
  // and it ends when the answer comes or the agent stops.
  const writing = state.drafting;

  const provider = findProvider(providerId);
  const keySaved = provider !== undefined && state.savedSecrets.includes(provider.secretName);

  function writeFile(final = false, request = prompt.trim()) {
    if (request === "" || provider === undefined || modelId === "") return;
    if (!keySaved && key.trim() !== "") onSaveKey(provider.secretName, key.trim(), provider.id);
    const authoringModel = {
      provider: provider.id,
      name: modelId,
      authentication: { type: "api-key", api_key: secretReference(provider.secretName) },
    } as AgentModelRef;
    onGenerate(request, authoringModel, final);
  }

  function answer() {
    if (answers.trim() === "") return;
    writeFile(true, `${prompt.trim()}\n\nAnswers to your questions:\n${answers.trim()}`);
    setAnswers("");
  }

  function skip() {
    writeFile(true, prompt.trim());
    setAnswers("");
  }

  return {
    prompt,
    setPrompt,
    providerId,
    setProviderId,
    modelId,
    setModelId,
    key,
    setKey,
    answers,
    setAnswers,
    writing,
    provider,
    keySaved,
    writeFile,
    answer,
    skip,
  };
}

type Writer = ReturnType<typeof useWriter>;

export function DraftView({
  draft,
  actions,
  onWriteAgain,
  onUse,
}: {
  draft: string;
  actions: string;
  onWriteAgain: () => void;
  onUse: () => void;
}) {
  return (
    <>
      <pre className="u-draft">{draft}</pre>
      <div className={actions}>
        <button className="u-btn ghost" onClick={onWriteAgain}>
          Write it again
        </button>
        <button className="u-btn primary" onClick={onUse}>
          Use this file
        </button>
      </div>
    </>
  );
}

export function QuestionsView({
  questions,
  writer,
  actions,
}: {
  questions: string[];
  writer: Writer;
  actions: string;
}) {
  const { answers, setAnswers, writing } = writer;
  return (
    <>
      <ul className="u-rows">
        {questions.map((question) => (
          <li key={question}>{question}</li>
        ))}
      </ul>
      <form
        className="u-group"
        onSubmit={(event) => {
          event.preventDefault();
          writer.answer();
        }}
      >
        <textarea
          className="u-area"
          aria-label="Your answers"
          value={answers}
          onChange={(event) => setAnswers(event.target.value)}
          placeholder="Answer in your own words…"
          rows={4}
          autoFocus
        />
        <div className={actions}>
          <button className="u-btn ghost" type="button" disabled={writing} onClick={writer.skip}>
            Skip
          </button>
          <button className="u-btn primary" type="submit" disabled={answers.trim() === "" || writing}>
            {writing ? "Writing the file…" : "Write the agent file"}
          </button>
        </div>
      </form>
    </>
  );
}

export function PromptView({ writer, draftError }: { writer: Writer; draftError: string | null }) {
  const { prompt, setPrompt, providerId, setProviderId, modelId, setModelId, key, setKey } = writer;
  const { writing, provider, keySaved, writeFile } = writer;
  const chosen = provider !== undefined && modelId !== "";
  const canWrite = prompt.trim() !== "" && chosen && (keySaved || key.trim() !== "") && !writing;
  return (
    <>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          writeFile();
        }}
        className="u-group"
      >
        <textarea
          className="u-area"
          aria-label="What the agent should do"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="A support agent for a coffee roastery that answers questions about beans and delivery…"
          rows={5}
          autoFocus
        />

        <div className="u-label is-section">Model that writes the file</div>
        <div className="u-input-row">
          <label className="u-group u-input-col">
            <span className="u-label">Provider</span>
            <select
              className={`u-input${provider === undefined ? " is-placeholder" : ""}`}
              value={providerId}
              onChange={(event) => {
                setProviderId(event.target.value);
                setModelId("");
                setKey("");
              }}
            >
              <option value="" disabled>
                Choose a provider
              </option>
              {MODEL_PROVIDERS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="u-group u-input-col">
            <span className="u-label">Model</span>
            <select
              className={`u-input${modelId === "" ? " is-placeholder" : ""}`}
              value={modelId}
              disabled={provider === undefined}
              onChange={(event) => setModelId(event.target.value)}
            >
              <option value="" disabled>
                Choose a model
              </option>
              {provider?.models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {chosen && !keySaved && (
          <label className="u-group">
            <span className="u-label">{provider.label} API key</span>
            <input
              className="u-input"
              type="password"
              {...SECRET_INPUT}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={`Paste your ${provider.label} key`}
            />
          </label>
        )}

        {provider !== undefined && (
          <p className="u-usage-note">
            <Icon path={ICON_PATHS.warn} size={15} />
            <span>
              Your <strong>{provider.label}</strong> API usage will be used to write this file.
            </span>
          </p>
        )}

        <button className="u-btn primary wide" type="submit" disabled={!canWrite}>
          {writing ? "Writing the file…" : "Write the agent file"}
        </button>
      </form>
      {draftError !== null && <p className="u-errcard">{brief(draftError)}</p>}
    </>
  );
}

interface MenuProps {
  notice?: string;
  onBlank: () => void;
  setView: (view: StartView) => void;
}

const CHOICES: { key: string; icon: string; name: string; view: StartView | null; desc: string }[] = [
  {
    key: "blank",
    icon: ICON_PATHS.blank,
    name: "Blank",
    view: null,
    desc: START_CARDS.blank,
  },
  {
    key: "generate",
    icon: ICON_PATHS.generate,
    name: "Generate with AI",
    view: "prompt",
    desc: START_CARDS.generate,
  },
  {
    key: "templates",
    icon: ICON_PATHS.template,
    name: "From a template",
    view: "templates",
    desc: templatesNote(EXAMPLES.length),
  },
  {
    key: "import",
    icon: ICON_PATHS.file,
    name: "Import a file",
    view: "import",
    desc: START_CARDS.import,
  },
];

export function DialogMenu({ notice, onBlank, setView }: MenuProps) {
  return (
    <>
      {notice !== undefined && <p className="u-errcard u-start-notice">{withCode(notice)}</p>}
      <Cards
        items={CHOICES.map((choice) => ({
          key: choice.key,
          icon: <Icon path={choice.icon} size={15} />,
          name: choice.name,
          desc: choice.desc,
          onPick: () => (choice.view === null ? onBlank() : setView(choice.view)),
        }))}
      />
    </>
  );
}

export function PanelMenu({ notice, onBlank, setView }: MenuProps) {
  return (
    <SetupColumn>
      {notice !== undefined && <p className="u-errcard u-start-notice">{withCode(notice)}</p>}
      <p className="u-setup-note">{START_SUBTITLES.menu}</p>

      <div className="u-start-list">
        {CHOICES.map((choice) => (
          <StartOption
            key={choice.key}
            icon={<Icon path={choice.icon} size={15} />}
            name={choice.name}
            desc={choice.desc}
            on={choice.view === null}
            onClick={() => (choice.view === null ? onBlank() : setView(choice.view))}
          />
        ))}
      </div>
    </SetupColumn>
  );
}
