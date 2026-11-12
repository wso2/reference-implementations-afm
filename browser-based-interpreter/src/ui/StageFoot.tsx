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

import type { Readiness, ReadyFix } from "../core/setup/readiness";

export function StageFoot({ state, onFix }: { state: Readiness; onFix: (fix: ReadyFix) => void }) {
  const { tone, lead, subject, fix } = state;
  return (
    <div className={`u-stage-foot${state.chip === true ? " is-covered" : ""}`}>
      <span className="u-ready">
        <span className={`u-ready-dot ${tone === "ok" ? "" : tone}`} aria-hidden="true" />
        {lead}
        {subject !== undefined &&
          (fix === undefined ? (
            <b>{subject}</b>
          ) : (
            <button className="u-ready-act" onClick={() => onFix(fix)}>
              {subject}
            </button>
          ))}
      </span>
    </div>
  );
}
