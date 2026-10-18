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

import { useEffect, useRef, useState } from "react";
import { type AgentStatus, type UiMessage } from "../../core/chat/chat-state";
import { brief } from "../../core/chat/failure";
import { attachedFileKey, attachmentBadge, describeAttachment } from "../../core/files/file-labels";
import { type LoadStep } from "../../core/runtime/protocol";
import { Icon } from "../../ui/Icon";
import { EmptyState, NotReadyReason } from "./EmptyState";
import { Message } from "./Message";
import { ToolFootnote } from "./ToolFootnote";

interface Props {
  messages: UiMessage[];
  streaming: boolean;
  status: Exclude<AgentStatus, "no-agent">;
  agentName: string;
  iconUrl?: string;
  loadSteps: LoadStep[];
  notReady: string | null;
  onRetry: () => void;
  failure?: string | null;
  onRetryReply?: () => void;
  onRegenerate: () => void;
  onDetachFile?: (messageId: number, key: string) => void;
  description?: string;
  role?: string;
  onAsk?: (question: string) => void;
  onReplaceKey?: () => void;
  serverOf?: (toolName: string) => string | undefined;
  onEdit?: (messageId: number, text: string) => void;
}

type ToolMessage = Extract<UiMessage, { kind: "tool" }>;

function lastIndexOfKind(messages: UiMessage[], kind: UiMessage["kind"]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.kind === kind) return i;
  }
  return -1;
}

function toolsBeforeAnswers(messages: UiMessage[]): Map<number, ToolMessage[]> {
  const attached = new Map<number, ToolMessage[]>();
  let pending: ToolMessage[] = [];
  for (const message of messages) {
    if (message.kind === "tool") {
      pending.push(message);
      continue;
    }
    if (message.kind === "assistant" && pending.length > 0) {
      attached.set(message.id, pending);
      pending = [];
    }
    if (message.kind === "user") pending = [];
  }
  return attached;
}

export function MessageList(props: Props) {
  const {
    messages,
    streaming,
    status,
    agentName,
    iconUrl = "",
    loadSteps,
    notReady,
    onRetry,
    failure = null,
    onRetryReply,
    onRegenerate,
    onDetachFile,
    description,
    role,
    onAsk,
    onReplaceKey,
    serverOf,
    onEdit,
  } = props;
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    if (atBottom) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming, failure, atBottom]);

  function onScroll() {
    const el = scrollRef.current;
    if (el === null) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  }

  if (messages.length === 0) {
    return (
      <div className="xc-wrap mid" ref={scrollRef}>
        <EmptyState
          status={status}
          agentName={agentName}
          iconUrl={iconUrl}
          loadSteps={loadSteps}
          notReady={notReady}
          onRetry={onRetry}
          description={description}
          role={role}
          onAsk={onAsk}
          onReplaceKey={onReplaceKey}
        />
      </div>
    );
  }

  const lastIndex = messages.length - 1;
  const lastAssistant = lastIndexOfKind(messages, "assistant");
  const footnotes = toolsBeforeAnswers(messages);
  const openTools = messages.filter(
    (message): message is ToolMessage =>
      message.kind === "tool" && message.status === "running" && !isAttached(message, footnotes),
  );
  const canAct = status === "ready";
  const detach = streaming ? undefined : onDetachFile;
  const waiting = streaming && messages[lastIndex]?.kind !== "assistant" && openTools.length === 0;

  return (
    <div className="xc-wrap" ref={scrollRef} onScroll={onScroll}>
      <div className="xc-col">
        <div className="xc-thread">
          {messages.map((message, index) => {
            if (message.kind === "tool") {
              if (isAttached(message, footnotes)) return null;
              return (
                <div className="xc-turn" key={message.id}>
                  <ToolFootnote tool={message} server={serverOf?.(message.name)} />
                </div>
              );
            }
            if (message.kind === "attachment") {
              return (
                <div className="attachment-row" key={message.id} role="group" aria-label="Attached files">
                  {message.files.map((file) => (
                    <div className="attachment-card" key={attachedFileKey(file)} title={file.name}>
                      <span className="attachment-badge" aria-hidden="true">
                        {attachmentBadge(file.name)}
                      </span>
                      <span className="attachment-body">
                        <span className="attachment-name">{file.name}</span>
                        <span className="attachment-meta">{describeAttachment(file)}</span>
                      </span>
                      {detach !== undefined && (
                        <button
                          className="attachment-remove"
                          onClick={() => detach(message.id, attachedFileKey(file))}
                          aria-label={`Remove ${file.name}`}
                          data-tip="Remove this file"
                        >
                          <Icon size={12} weight={2.5} path="M18 6 6 18M6 6l12 12" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              );
            }
            if (message.kind === "notice") {
              return (
                <div className="notice-marker" key={message.id} role="status">
                  {message.text}
                </div>
              );
            }
            const did = footnotes.get(message.id);
            return (
              <Message
                key={message.id}
                message={message}
                streaming={streaming && index === lastIndex && message.kind === "assistant"}
                onRegenerate={canAct && index === lastAssistant ? onRegenerate : undefined}
                onEdit={canAct && onEdit !== undefined ? (text) => onEdit(message.id, text) : undefined}
                footnote={
                  did === undefined ? undefined : (
                    <>
                      {did.map((tool) => (
                        <ToolFootnote key={tool.id} tool={tool} server={serverOf?.(tool.name)} />
                      ))}
                    </>
                  )
                }
              />
            );
          })}

          {waiting && (
            <div className="xc-turn">
              <span className="xc-live">
                <span className="xc-pulse" aria-hidden="true" />
                Thinking…
              </span>
            </div>
          )}
        </div>
        {failure !== null && status === "ready" && (
          <ReplyFailure
            message={failure}
            onRetry={onRetryReply !== undefined && lastIndexOfKind(messages, "user") !== -1 ? onRetryReply : undefined}
            onReplaceKey={onReplaceKey}
          />
        )}
        {status === "not-ready" && (
          <div className="xc-notready">
            <NotReadyReason notReady={notReady} onRetry={onRetry} onReplaceKey={onReplaceKey} />
          </div>
        )}
        <div ref={endRef} />
      </div>
      {!atBottom && (
        <button
          className="scroll-bottom"
          onClick={() => endRef.current?.scrollIntoView({ behavior: "smooth" })}
          aria-label="Scroll to latest"
        >
          <Icon size={18} weight={2} path="M12 5v14M19 12l-7 7-7-7" />
        </button>
      )}
    </div>
  );
}

function isAttached(tool: ToolMessage, attached: Map<number, ToolMessage[]>): boolean {
  for (const group of attached.values()) {
    if (group.includes(tool)) return true;
  }
  return false;
}

const KEY_REJECTED = "Key not accepted";

interface ReplyFailureProps {
  message: string;
  onRetry?: () => void;
  onReplaceKey?: () => void;
}

function ReplyFailure({ message, onRetry, onReplaceKey }: ReplyFailureProps) {
  const text = brief(message);
  return (
    <div className="reply-failure" role="alert">
      <span className="reply-failure-dot" aria-hidden="true" />
      <span className="reply-failure-text">{text}</span>
      {text === KEY_REJECTED && onReplaceKey !== undefined && (
        <button className="u-btn ghost sm" onClick={onReplaceKey}>
          Replace key
        </button>
      )}
      {onRetry !== undefined && (
        <button className="u-btn ghost sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
