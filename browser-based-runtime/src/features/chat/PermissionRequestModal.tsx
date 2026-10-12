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

import { displayToolName } from "@afm/adapter-tool";
import type { PendingPermission } from "../../core/chat/chat-state";
import { hostOf } from "../../core/links/load-paths";

interface Props {
  request: PendingPermission;
  onDecide: (allow: boolean, remember: boolean) => void;
}

function destinationOf(serverId: string | undefined): string | null {
  return serverId === undefined || serverId === "" ? null : hostOf(serverId);
}

export function PermissionRequestModal({ request, onDecide }: Props) {
  const destination = destinationOf(request.serverId);

  return (
    <div className="overlay permission-overlay">
      <div className="modal permission-modal">
        <h3>Allow tool call?</h3>
        <p>
          The agent wants to run <code>{displayToolName(request.name)}</code>
        </p>
        <p className="permission-destination">
          {destination !== null ? (
            <>
              Sent to <strong>{destination}</strong>
            </>
          ) : (
            <>Runs in this tab - nothing leaves the browser</>
          )}
        </p>
        <pre className="args-pre permission-args">{formatArgs(request.args)}</pre>
        <p className="permission-reassurance">Nothing runs until you decide.</p>
        <div className="modal-actions permission-actions">
          <button className="btn" onClick={() => onDecide(false, false)} autoFocus>
            Deny
          </button>
          <button className="btn" onClick={() => onDecide(true, false)}>
            Allow once
          </button>
          <button className="u-btn primary" onClick={() => onDecide(true, true)}>
            Always allow in this tab
          </button>
        </div>
      </div>
    </div>
  );
}

function formatArgs(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
