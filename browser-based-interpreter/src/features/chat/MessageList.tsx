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

import { useLayoutEffect, useRef, useState } from "react";
import { type AgentStatus, type PendingPermission, type UiMessage } from "../../core/chat/chat-state";
import { brief } from "../../core/chat/failure";
import { type LoadStep } from "../../core/runtime/protocol";
import { Icon } from "../../ui/Icon";
import { ApprovalCard } from "./ApprovalCard";
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
  description?: string;
  role?: string;
  onAsk?: (question: string) => void;
  onReplaceKey?: () => void;
  serverOf?: (toolName: string) => string | undefined;
  onEdit?: (messageId: number, text: string) => void;
  pendingPermission?: PendingPermission | null;
  onDecide?: (allow: boolean, remember: boolean) => void;
}

type ToolMessage = Extract<UiMessage, { kind: "tool" }>;

function askingTool(messages: UiMessage[], pending: PendingPermission | null): ToolMessage | null {
  if (pending === null) return null;
  const asking = messages.findLast(
    (message) => message.kind === "tool" && message.status === "running" && message.callId === pending.id,
  );
  return asking?.kind === "tool" ? asking : null;
}

// The tool calls before an answer are shown as a note under it. The one that waits for a decision is not: it stays in the
// thread, where its card is shown, even when words from the model come after it.
export function toolsBeforeAnswers(messages: UiMessage[], asking: ToolMessage | null = null): Map<number, ToolMessage[]> {
  const attached = new Map<number, ToolMessage[]>();
  let pending: ToolMessage[] = [];
  for (const message of messages) {
    if (message.kind === "tool") {
      if (message !== asking) pending.push(message);
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

const NEAR_BOTTOM = 80;

// While words arrive, the page grows many times a second. A smooth scroll starts again with
// each word and always runs behind, so the text seems to shake. Jump straight to the end then.
export function endScrollBehavior(streaming: boolean): ScrollBehavior {
  return streaming ? "auto" : "smooth";
}

// "Try again" regenerates the latest question, so it belongs only under an answer to that question.
// When the latest turn has no answer yet (for example it ended after a tool result), no older answer may offer it.
export function regenerableIndex(messages: UiMessage[]): number {
  const answer = messages.findLastIndex((message) => message.kind === "assistant");
  return answer > messages.findLastIndex((message) => message.kind === "user") ? answer : -1;
}

export function followingAfterScroll(following: boolean, away: number, movedUp: boolean): boolean {
  if (away < NEAR_BOTTOM) return true;
  return movedUp ? false : following;
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
    description,
    role,
    onAsk,
    onReplaceKey,
    serverOf,
    onEdit,
    pendingPermission = null,
    onDecide,
  } = props;
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastTop = useRef(0);
  const lastSent = useRef<number | null>(null);
  const lastAsked = useRef<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  function follow(on: boolean) {
    following.current = on;
    setAtBottom(on);
  }

  // A layout effect runs before the browser paints. With a normal effect, each new line is
  // drawn once below the edge and only then scrolled into view, which shows as a small jump.
  useLayoutEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.kind === "user" && last.id !== lastSent.current) {
      lastSent.current = last.id;
      follow(true);
    }
    if (pendingPermission !== null && pendingPermission.id !== lastAsked.current) {
      lastAsked.current = pendingPermission.id;
      follow(true);
    }
    if (following.current) endRef.current?.scrollIntoView({ behavior: endScrollBehavior(streaming), block: "end" });
  }, [messages, streaming, failure, pendingPermission]);

  function onScroll() {
    const el = scrollRef.current;
    if (el === null) return;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = followingAfterScroll(following.current, away, el.scrollTop < lastTop.current - 2);
    lastTop.current = el.scrollTop;
    if (next !== following.current) follow(next);
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
  const lastAssistant = regenerableIndex(messages);
  const asking = askingTool(messages, pendingPermission);
  const footnotes = toolsBeforeAnswers(messages, asking);
  const footnoted = new Set([...footnotes.values()].flat());
  const openTools = messages.filter(
    (message): message is ToolMessage =>
      message.kind === "tool" && message.status === "running" && !footnoted.has(message),
  );
  const card =
    pendingPermission !== null && onDecide !== undefined ? (
      <ApprovalCard key={pendingPermission.id} request={pendingPermission} onDecide={onDecide} />
    ) : null;
  const canAct = status === "ready";
  const waiting = streaming && messages[lastIndex]?.kind !== "assistant" && openTools.length === 0;

  return (
    <div className="xc-wrap" ref={scrollRef} onScroll={onScroll}>
      <div className="xc-col">
        <div className="xc-thread">
          {messages.map((message, index) => {
            if (message.kind === "tool") {
              if (footnoted.has(message)) return null;
              return (
                <div className="xc-turn" key={message.id}>
                  <ToolFootnote tool={message} server={serverOf?.(message.name)} asking={message === asking} />
                  {message === asking && card}
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

          {card !== null && asking === null && <div className="xc-turn">{card}</div>}

          {waiting && pendingPermission === null && (
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
            onRetry={onRetryReply !== undefined && messages.some((message) => message.kind === "user") ? onRetryReply : undefined}
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
          onClick={() => {
            follow(true);
            endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
          }}
          aria-label="Scroll to latest"
        >
          <Icon size={18} weight={2} path="M12 5v14M19 12l-7 7-7-7" />
        </button>
      )}
    </div>
  );
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
