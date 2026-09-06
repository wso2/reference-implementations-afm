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

import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { type ChipStatus, type Needs } from "../../core/setup/readiness";
import { Icon } from "../../ui/Icon";
import { LEAVE_MS } from "../../ui/hooks";

const TICK = <Icon weight={2.4} path="M5 12.5l4.5 4.5L19 7.5" />;
const RING = (
  <Icon weight={2.4}>
    <circle cx="12" cy="12" r="7.5" />
  </Icon>
);

const RING_LENGTH = 2 * Math.PI * 9;

function Dot({ done, total, ready }: { done: number; total: number; ready: boolean }) {
  const filled = ready ? RING_LENGTH : (RING_LENGTH * done) / total;
  return (
    <span className="u-need-dot" aria-hidden="true">
      <Icon weight={2.6}>
        <circle className="u-need-track" cx="12" cy="12" r="9" />
        <circle
          className="u-need-arc"
          cx="12"
          cy="12"
          r="9"
          transform="rotate(-90 12 12)"
          style={{ strokeDasharray: `${filled} ${RING_LENGTH}`, opacity: filled === 0 ? 0 : 1 }}
        />
        {ready && <path d="M8.2 12.4l2.7 2.7 5-5.2" stroke="currentColor" strokeWidth="2.2" />}
      </Icon>
    </span>
  );
}

export function chipAnnouncement(needs: Needs, phase: ChipPhase): string {
  if (phase === "confirm") return "Ready to run";
  if (phase !== "missing") return "";
  const missing = needs.items.filter((item) => !item.done).map((item) => item.label);
  return `${needs.done} of ${needs.items.length} ready. ${missing.join(" and ")} missing.`;
}

export function ReadinessChip({
  needs,
  phase,
  onHold,
}: {
  needs: Needs;
  phase: ChipPhase;
  onHold: (held: boolean) => void;
}) {
  if (phase === "hidden") return null;
  const ready = phase === "confirm" || phase === "leaving";
  return (
    <div
      className={`u-need${ready ? " ready" : ""}${phase === "leaving" ? " is-leaving" : ""}`}
      onMouseEnter={() => onHold(true)}
      onMouseLeave={() => onHold(false)}
    >
      <Dot done={needs.done} total={needs.items.length} ready={ready} />
      <span className="u-need-body">
        <span className="u-need-in">
          <span className="u-need-lead">
            {ready ? (
              "Ready to run"
            ) : (
              <>
                <span className="u-need-word">Ready: </span>
                {`${needs.done}/${needs.items.length}`}
              </>
            )}
          </span>
          {needs.items.map((item) => {
            const done = ready || item.done;
            return (
              <span key={item.id} className={`u-need-item ${done ? "done" : "todo"}`}>
                {done ? TICK : RING}
                <span>{item.label}</span>
              </span>
            );
          })}
        </span>
      </span>
    </div>
  );
}

export type ChipPhase = "missing" | "confirm" | "leaving" | "hidden";

export const SHOW_DELAY_MS = 3000;
export const CONFIRM_MS = 3000;
const EDIT_WINDOW_MS = 1500;

export function phaseOnStatus(
  phase: ChipPhase,
  before: ChipStatus,
  status: ChipStatus,
  typedJustNow: boolean,
): ChipPhase {
  if (status === "missing") return phase !== "hidden" || typedJustNow ? "missing" : "hidden";
  if (status === "none") return "hidden";
  if (before === "missing" && typedJustNow) return "confirm";
  return phase === "confirm" || phase === "leaving" ? phase : "hidden";
}

export function useReadyChip(status: ChipStatus, lastEditAt: MutableRefObject<number>, held: boolean): ChipPhase {
  const [phase, setPhase] = useState<ChipPhase>("hidden");
  const before = useRef(status);

  useEffect(() => {
    const was = before.current;
    before.current = status;
    setPhase((current) => phaseOnStatus(current, was, status, Date.now() - lastEditAt.current < EDIT_WINDOW_MS));
  }, [status, lastEditAt]);

  useEffect(() => {
    if (phase !== "hidden" || status !== "missing") return;
    const timer = window.setTimeout(() => setPhase("missing"), SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [phase, status]);

  useEffect(() => {
    if (phase !== "confirm" || held) return;
    const timer = window.setTimeout(() => setPhase("leaving"), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [phase, held]);

  useEffect(() => {
    if (phase !== "leaving") return;
    const timer = window.setTimeout(() => setPhase("hidden"), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return phase;
}
