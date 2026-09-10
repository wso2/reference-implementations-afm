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

import type { ReactNode } from "react";
import type { AfmIssue } from "../core/agent/agent-validation";

export function withCode(text: string): ReactNode[] {
  return text.split("`").map((part, at) => (at % 2 === 1 ? <code key={at}>{part}</code> : part));
}

interface Props {
  issues: AfmIssue[];
}

export function FileCheckPanel({ issues }: Props) {
  if (issues.length === 0) return null;

  return (
    <div className="u-issues">
      {issues.map((issue, index) => {
        const where = [issue.line === null ? null : `Line ${issue.line}`, issue.field === "" ? null : issue.field]
          .filter((part) => part !== null)
          .join(" · ");
        return (
          <div className="u-issue" key={index}>
            <span className={`u-issue-dot ${issue.severity === "error" ? "bad" : "warn"}`} aria-hidden="true" />
            <span className="u-issue-body">
              <b>{withCode(issue.message)}</b>
              {where !== "" && <span className="u-issue-where">{where}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
