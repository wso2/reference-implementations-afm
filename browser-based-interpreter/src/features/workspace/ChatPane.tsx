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

import { type ActivityPhase } from "../../core/chat/agent-activity";
import { type AgentStatus } from "../../core/chat/chat-state";
import { displayName } from "../../core/setup/setup-check";
import { Icon } from "../../ui/Icon";
import { AgentAvatar } from "../../ui/Marks";
import { type useStandaloneSession } from "../../worker-client/useStandaloneSession";
import { Composer } from "../chat/Composer";
import { MessageList } from "../chat/MessageList";

const WAITING_PLACEHOLDER: Partial<Record<AgentStatus, string>> = {
  "no-agent": "Press Run to start…",
  connecting: "Loading the agent…",
  "not-ready": "The agent didn't start…",
};

interface Props {
  session: ReturnType<typeof useStandaloneSession>;
  serverNameByUrl: Map<string, string>;
  onReplaceKey: () => void;
  onRetry: () => void;
  description?: string;
  role?: string;
  iconUrl?: string;
}

export function ChatPane({
  session,
  serverNameByUrl,
  onReplaceKey,
  onRetry,
  description = "",
  role = "",
  iconUrl = "",
}: Props) {
  const { state, send, stop, attachFiles, detachFile, regenerate, retryReply, editMessage, submitPermission } = session;
  const { pendingPermission } = state;

  return (
    <div className="xc">
      {state.status === "no-agent" ? (
        <div className="u-empty">
          <span className="u-empty-ico" aria-hidden="true">
            <Icon size={19} path="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </span>
          <h4>Not started yet</h4>
          <p>
            Press <strong>Run</strong> and the conversation begins here.
          </p>
        </div>
      ) : (
        <MessageList
          messages={state.messages}
          streaming={state.status === "streaming"}
          status={state.status}
          agentName={state.agentName}
          iconUrl={iconUrl}
          loadSteps={state.loadSteps}
          notReady={state.notReady}
          description={description}
          role={role}
          onAsk={state.status === "ready" ? (question) => send(question) : undefined}
          onReplaceKey={onReplaceKey}
          onRetry={onRetry}
          failure={state.error}
          onRetryReply={retryReply}
          onRegenerate={state.canContinue ? retryReply : regenerate}
          onEdit={editMessage}
          pendingPermission={pendingPermission}
          onDecide={
            pendingPermission === null
              ? undefined
              : (allow, remember) => submitPermission(pendingPermission.id, allow, remember)
          }
          onDetachFile={detachFile}
          serverOf={(toolName) => {
            const name = serverNameByUrl.get(state.tools.find((tool) => tool.name === toolName)?.serverId ?? "");
            return name === undefined ? undefined : displayName(name);
          }}
        />
      )}

      <Composer
        onSend={send}
        onStop={stop}
        onAttach={attachFiles}
        streaming={state.status === "streaming"}
        disabled={state.status !== "ready" && state.status !== "streaming"}
        placeholder={WAITING_PLACEHOLDER[state.status]}
      />
    </div>
  );
}

interface ChatStatus {
  tone: "ok" | "warn" | "bad";
  label: string;
}

const IDLE: Record<Exclude<AgentStatus, "streaming">, ChatStatus | null> = {
  ready: { tone: "ok", label: "Ready" },
  connecting: { tone: "warn", label: "Starting" },
  "not-ready": { tone: "bad", label: "Needs attention" },
  "no-agent": null,
};

export function headerStatus(
  status: AgentStatus,
  phase: ActivityPhase,
  server?: string,
  waitingForAnswer = false,
): ChatStatus | null {
  if (waitingForAnswer) return { tone: "warn", label: "Waiting for your answer" };
  if (status !== "streaming") return IDLE[status];
  if (phase === "tool")
    return { tone: "warn", label: server === undefined ? "Using a tool" : `Using ${displayName(server)}` };
  return phase === "answering" ? { tone: "ok", label: "Answering" } : { tone: "warn", label: "Thinking" };
}

export function ChatHead({ name, iconUrl, status }: { name: string; iconUrl: string; status: ChatStatus | null }) {
  return (
    <>
      <AgentAvatar className="xc-av sm" name={name} iconUrl={iconUrl} />
      <span className="u-who">
        <span className="u-panel-title">{name}</span>
        {status !== null && <span className={`u-state ${status.tone}`}>{status.label}</span>}
      </span>
    </>
  );
}

export function StatusPill({ status }: { status: ChatStatus | null }) {
  return status === null ? null : <span className={`u-state pill ${status.tone}`}>{status.label}</span>;
}
