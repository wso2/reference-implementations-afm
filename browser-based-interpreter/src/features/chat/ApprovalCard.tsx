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

import type { PendingPermission } from "../../core/chat/chat-state";
import { hostOf } from "../../core/agent/addresses";
import { Icon } from "../../ui/Icon";
import { displayToolName } from "../../core/tools/tool-names";

interface Props {
  request: PendingPermission;
  onDecide: (allow: boolean, remember: boolean) => void;
}

const SHIELD = "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z";

export function destinationOf(serverId: string | undefined): string {
  return serverId === undefined || serverId === "" ? "this tab" : hostOf(serverId);
}

export function argsText(args: unknown): string | null {
  if (args === undefined || args === null) return null;
  let text: string;
  try {
    text = JSON.stringify(args, null, 2) ?? "";
  } catch {
    text = String(args);
  }
  return text === "" || text === "{}" || text === "[]" ? null : text;
}

export function ApprovalCard({ request, onDecide }: Props) {
  const tool = displayToolName(request.name);
  const args = argsText(request.args);
  return (
    <div className="ap" role="alert" aria-label={`Allow ${tool}?`}>
      <div className="ap-h">
        <Icon path={SHIELD} size={14} />
        <b>
          Allow <code>{tool}</code>?
        </b>
        <span className="ap-to">{destinationOf(request.serverId)}</span>
      </div>
      {args !== null && (
        <pre className="ap-args" tabIndex={0} aria-label="What the tool will be sent">
          {args}
        </pre>
      )}
      <div className="ap-b">
        <button className="u-btn sm primary" onClick={() => onDecide(true, false)}>
          Allow
        </button>
        <button className="u-btn sm ghost" onClick={() => onDecide(true, true)}>
          Always allow
        </button>
        <button className="u-btn sm danger" onClick={() => onDecide(false, false)}>
          Deny
        </button>
      </div>
    </div>
  );
}
