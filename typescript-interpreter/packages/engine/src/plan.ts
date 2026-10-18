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

import type { AgentMetadata } from "./schema";

export type PlanSeverity = "warning" | "blocked";

export interface PlanIssue {
  severity: PlanSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface Plan {
  runnable: boolean;
  issues: PlanIssue[];
}

export function planForBrowser(metadata: AgentMetadata): Plan {
  const issues: PlanIssue[] = [];

  (metadata.interfaces ?? []).forEach((iface, i) => {
    if (iface.type !== "webchat") {
      issues.push({
        severity: "warning",
        code: "interface-unsupported",
        message: `The '${iface.type}' interface does not run in a browser; only 'webchat' is supported here.`,
        path: `interfaces[${i}]`,
      });
    }
  });

  const modelAuth = metadata.model?.authentication;
  const modelAuthType = modelAuth?.type.toLowerCase();
  if (modelAuthType === "jwt" || modelAuthType === "oauth2") {
    issues.push({
      severity: "blocked",
      code: "model-auth-unsupported",
      message: `The model's '${modelAuthType}' authentication does not run in a browser; give the model an API key instead.`,
      path: "model.authentication",
    });
  }

  (metadata.tools?.mcp ?? []).forEach((server, i) => {
    if (server.transport.type === "stdio") {
      issues.push({
        severity: "warning",
        code: "stdio-transport-unsupported",
        message: `MCP server '${server.name}' uses stdio, which a browser cannot run; it will be skipped. Only HTTP MCP works (via the proxy).`,
        path: `tools.mcp[${i}].transport`,
      });
    } else if (server.transport.authentication?.type.toLowerCase() === "jwt") {
      issues.push({
        severity: "blocked",
        code: "jwt-auth-unsupported",
        message: `MCP server '${server.name}' uses jwt authentication, which needs a server-side runtime. In a browser, use oauth2 sign-in or a bearer access token.`,
        path: `tools.mcp[${i}].transport.authentication`,
      });
    }
  });

  const runnable = !issues.some((issue) => issue.severity === "blocked");
  return { runnable, issues };
}
