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
import { displayToolName } from "@afm/runtime";
import type { UiMessage } from "../../core/chat/chat-state";
import { Icon } from "../../ui/Icon";

type ToolMessage = Extract<UiMessage, { kind: "tool" }>;

const clip = (text: string) => (text.length > 240 ? `${text.slice(0, 240)}…` : text);

interface Props {
  tool: ToolMessage;
  server?: string;
  asking?: boolean;
}

export function ToolFootnote({ tool, server, asking = false }: Props) {
  const startedAt = useRef(Date.now());
  const watched = useRef(tool.status === "running");
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (tool.status === "running" || !watched.current) return;
    setElapsed((current) => current ?? Date.now() - startedAt.current);
  }, [tool.status]);

  if (asking) {
    return (
      <span className="xc-used ask">
        <span className="d" aria-hidden="true" />
        <span className="xc-used-name">
          {server === undefined ? displayToolName(tool.name) : `${server} · ${displayToolName(tool.name)}`}
        </span>
      </span>
    );
  }

  if (tool.status === "running") {
    return (
      <span className="xc-live">
        <span className="xc-pulse" aria-hidden="true" />
        Using {server ?? "a tool"}…
      </span>
    );
  }

  const failed = tool.status === "failed";
  return (
    <span className={`xc-tool ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className={`xc-used ${failed ? "is-bad" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="d" aria-hidden="true" />
        <span className="xc-used-name">
          {server === undefined ? displayToolName(tool.name) : `${server} · ${displayToolName(tool.name)}`}
        </span>
        <span className="xc-meta">{failed ? "failed" : elapsed !== null ? `${(elapsed / 1000).toFixed(1)}s` : ""}</span>
        <Icon size={12} weight={2.2} path="m6 9 6 6 6-6" />
      </button>
      {open && (
        <div className="xc-toolbody">
          <span className="u-label">Asked with</span>
          <code>{clip(JSON.stringify(tool.args ?? {}))}</code>
          {tool.result !== undefined && (
            <>
              <span className="u-label">Got back</span>
              <code>{clip(tool.result)}</code>
            </>
          )}
        </div>
      )}
    </span>
  );
}
