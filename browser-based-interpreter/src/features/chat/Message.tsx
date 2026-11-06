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

import { type ReactNode, useState } from "react";
import { type UiMessage } from "../../core/chat/chat-state";
import { Icon } from "../../ui/Icon";
import { useCopyFeedback } from "../../ui/hooks";
import { Markdown } from "./Markdown";
import { useSpeakText } from "./voice";

type TextMessage = Extract<UiMessage, { kind: "user" | "assistant" }>;

interface Props {
  message: TextMessage;
  streaming: boolean;
  onRegenerate?: () => void;
  onEdit?: (text: string) => void;
  footnote?: ReactNode;
}

function Act({ label, path, onClick }: { label: string; path: string; onClick: () => void }) {
  return (
    <button className="xc-act" onClick={onClick} data-tip={label} aria-label={label}>
      <Icon size={14} path={path} />
    </button>
  );
}

const COPY =
  "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2zM4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2";
const EDIT =
  "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4";
const RETRY = "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5";
const SPEAK =
  "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM16 9a5 5 0 0 1 0 6M19.364 18.364a9 9 0 0 0 0-12.728";

export function Message({ message, streaming, onRegenerate, onEdit, footnote }: Props) {
  const isUser = message.kind === "user";
  const { copied, copy } = useCopyFeedback();
  const voice = useSpeakText();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const images = message.kind === "user" && message.images !== undefined && message.images.length > 0 && (
    <div className="msg-images">
      {message.images.map((image, index) => (
        <img
          key={`${image.name}-${index}`}
          className="msg-image"
          src={`data:${image.mediaType};base64,${image.data}`}
          alt={image.name}
        />
      ))}
    </div>
  );

  if (isUser && editing) {
    const send = () => {
      if (draft.trim() === "") return;
      setEditing(false);
      onEdit?.(draft.trim());
    };
    return (
      <div className="xc-turn is-user">
        <div className="xc-edit">
          <textarea
            className="xc-edit-field"
            value={draft}
            rows={3}
            autoFocus
            aria-label="Edit your message"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="xc-edit-bar">
            <button className="u-btn quiet sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="u-btn primary sm" disabled={draft.trim() === ""} onClick={send}>
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="xc-turn is-user">
        {images}
        {message.text.trim() !== "" && (
          <>
            <div className="xc-user">{message.text}</div>
            <span className="xc-uacts">
              <Act label={copied ? "Copied" : "Copy"} path={COPY} onClick={() => copy(message.text)} />
              {onEdit !== undefined && (
                <Act
                  label="Edit"
                  path={EDIT}
                  onClick={() => {
                    setDraft(message.text);
                    setEditing(true);
                  }}
                />
              )}
            </span>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="xc-turn">
      <div className="xc-text">
        <Markdown text={message.text} />
        {streaming && <span className="xc-caret" aria-hidden="true" />}
      </div>
      {(footnote !== undefined || !streaming) && (
        <div className="xc-foot">
          {footnote}
          {!streaming && (
            <span className="xc-acts">
              <Act label={copied ? "Copied" : "Copy"} path={COPY} onClick={() => copy(message.text)} />
              {voice.supported && (
                <Act
                  label={voice.speaking ? "Stop reading aloud" : "Read aloud"}
                  path={SPEAK}
                  onClick={() => (voice.speaking ? voice.stop() : voice.speak(message.text))}
                />
              )}
              {onRegenerate !== undefined && <Act label="Try again" path={RETRY} onClick={onRegenerate} />}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
