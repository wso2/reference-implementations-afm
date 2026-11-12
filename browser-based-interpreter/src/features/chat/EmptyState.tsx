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

import { useEffect, useState } from "react";
import { type AgentStatus } from "../../core/chat/chat-state";
import { OPENERS, selfDescription } from "../../core/chat/chat-text";
import { brief } from "../../core/chat/failure";
import { type LoadStep } from "../../core/runtime/protocol";
import { Icon } from "../../ui/Icon";
import { AgentAvatar } from "../../ui/Marks";

function useDots(): string {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const timer = window.setInterval(() => setCount((n) => (n % 3) + 1), 420);
    return () => window.clearInterval(timer);
  }, []);
  return ".".repeat(count);
}

function LoadChecklist({ steps }: { steps: LoadStep[] }) {
  const dots = useDots();
  if (steps.length === 0) return null;
  return (
    <ul className="load-checklist">
      {steps.map((step) => (
        <li key={step.key} className={`load-step load-step-${step.state}`}>
          <span className="load-step-mark" aria-hidden="true">
            {step.state === "done" ? "✓" : step.state === "failed" ? "✕" : "○"}
          </span>
          <span className="load-step-label">
            {step.label}
            {step.state === "active" && <span className="load-step-dots">{dots}</span>}
          </span>
          {step.state === "failed" && step.note !== undefined && (
            <span className="load-step-note">{brief(step.note)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

interface Props {
  status: Exclude<AgentStatus, "no-agent">;
  agentName: string;
  iconUrl?: string;
  loadSteps: LoadStep[];
  notReady: string | null;
  onRetry: () => void;
  description?: string;
  role?: string;
  onAsk?: (question: string) => void;
  onReplaceKey?: () => void;
}

// A letter or digit on either side would make it part of a longer word, but an underscore is a separator:
// 'OPENAI_API_KEY' is a key problem, and 'monkey' is not.
export function rejectedKey(reason: string | null): boolean {
  return reason !== null && /(?:^|[^a-z0-9])(?:api[ _-]?key|invalid[ _-]?key)(?![a-z0-9])/i.test(reason);
}

export function NotReadyReason({
  notReady,
  onRetry,
  onReplaceKey,
}: {
  notReady: string | null;
  onRetry: () => void;
  onReplaceKey?: () => void;
}) {
  return (
    <>
      <p className="not-ready-reason">
        {notReady === null ? "Something went wrong while starting the agent." : brief(notReady)}
      </p>
      <div className="not-ready-actions">
        {rejectedKey(notReady) && onReplaceKey !== undefined && (
          <button className="u-btn primary" onClick={onReplaceKey}>
            Replace key
          </button>
        )}
        <button className={`btn ${rejectedKey(notReady) ? "subtle" : "primary"}`} onClick={onRetry}>
          Try again
        </button>
      </div>
    </>
  );
}

export function EmptyState({
  status,
  agentName,
  iconUrl = "",
  loadSteps,
  notReady,
  onRetry,
  description = "",
  role = "",
  onAsk,
  onReplaceKey,
}: Props) {
  if (status === "connecting") {
    return (
      <div className="empty">
        <div className="loader-block">
          <div className="loader-ring" />
          <h2>Starting the agent</h2>
          <LoadChecklist steps={loadSteps} />
          <div className="loader-steps">
            <span className="step active">Load</span>
            <span className="step-line" />
            <span className="step">Ready</span>
          </div>
        </div>
      </div>
    );
  }

  if (status === "not-ready") {
    return (
      <div className="empty">
        <div>
          <div className="hero-ico bad">⚠</div>
          <h2>Agent isn&apos;t ready</h2>
          <LoadChecklist steps={loadSteps} />
          <NotReadyReason notReady={notReady} onRetry={onRetry} onReplaceKey={onReplaceKey} />
        </div>
      </div>
    );
  }

  const says = selfDescription(description, role);
  return (
    <div className="xc-col">
      <ThreadHead name={agentName || "AFM Agent"} iconUrl={iconUrl} />
      {says !== "" && <p className="xc-say">{says}</p>}
      {onAsk !== undefined && (
        <div className="xc-starters">
          <div className="xc-slabel">Try asking</div>
          {OPENERS.map((question) => (
            <button className="xc-starter" key={question} onClick={() => onAsk(question)}>
              {question}
              <span className="xc-arw" aria-hidden="true">
                <Icon weight={1.9} path="M7 17L17 7M8.5 7H17v8.5" />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ThreadHead({ name, iconUrl = "" }: { name: string; iconUrl?: string }) {
  return (
    <div className="xc-hero">
      <div className="xc-glow" aria-hidden="true" />
      <div className="xc-row">
        <AgentAvatar className="xc-av" name={name} iconUrl={iconUrl} />
        <span className="xc-name">{name}</span>
      </div>
    </div>
  );
}
