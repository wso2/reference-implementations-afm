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
import { type AfmIssue } from "../../core/agent/agent-validation";
import { FileCheckPanel, withCode } from "../../ui/FileCheckPanel";
import { Icon } from "../../ui/Icon";
import { useDismiss, useLingering } from "../../ui/hooks";

const RING_LENGTH = 2 * Math.PI * 9;

function Mark() {
  return (
    <Icon weight={2.6}>
      <circle className="u-pill-track" cx="12" cy="12" r="9" />
      <circle
        className="u-pill-arc"
        cx="12"
        cy="12"
        r="9"
        transform="rotate(-90 12 12)"
        style={{ strokeDasharray: `${RING_LENGTH} ${RING_LENGTH}` }}
      />
      <path d="M12 7.8v5M12 16.2h.01" stroke="currentColor" strokeWidth="2.4" />
    </Icon>
  );
}

export function problemCount(issues: readonly AfmIssue[]): string {
  return issues.length === 1 ? "1 problem" : `${issues.length} problems`;
}

export function mostSevereFirst(issues: readonly AfmIssue[]): AfmIssue[] {
  return [...issues].sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error"));
}

export function issueAnnouncement(issues: readonly AfmIssue[]): string {
  const first = mostSevereFirst(issues)[0];
  if (first === undefined) return "";
  const where = first.line === null ? "" : ` Line ${first.line}.`;
  return `${problemCount(issues)}.${where} ${first.message}`;
}

export function IssuePill({ issues }: { issues: readonly AfmIssue[] }) {
  const { items, leaving } = useLingering(issues);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useDismiss(open, wrap, () => setOpen(false));

  useEffect(() => {
    if (items.length === 0) setOpen(false);
  }, [items.length]);

  if (items.length === 0) return null;
  const ordered = mostSevereFirst(items);
  const first = ordered[0]!;
  const more = ordered.length - 1;
  const calm = !ordered.some((issue) => issue.severity === "error");

  return (
    <div className="u-pill-wrap" ref={wrap}>
      {open && (
        <div className="u-pill-pop">
          <FileCheckPanel issues={ordered} />
        </div>
      )}
      <div className={`u-pill${calm ? " is-warn" : ""}${leaving ? " is-leaving" : ""}`}>
        <span className="u-pill-dot" aria-hidden="true">
          <Mark />
        </span>
        <span className="u-pill-body">
          <span className="u-pill-in">
            <span className="u-pill-lead">{problemCount(ordered)}</span>
            {first.line !== null && <span className="u-pill-line">Line {first.line}</span>}
            <button className="u-pill-msg" title={first.message} aria-expanded={open} onClick={() => setOpen(!open)}>
              {withCode(first.message)}
            </button>
            {more > 0 && (
              <button className="u-pill-more" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? "Hide" : `+${more} more`}
              </button>
            )}
          </span>
        </span>
      </div>
      <span className="visually-hidden" role="status">
        {leaving ? "" : issueAnnouncement(ordered)}
      </span>
    </div>
  );
}
