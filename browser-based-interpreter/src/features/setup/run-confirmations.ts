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

import type { AgentMetadata, PlanIssue } from "@afm/engine";

export interface RunConfirmation {
  title: string;
  text: string;
}

export function runConfirmations(metadata: AgentMetadata, issues: PlanIssue[]): RunConfirmation[] {
  return issues.flatMap((issue) => {
    if (issue.severity !== "warning") return [];
    if (issue.code === "interface-unsupported") {
      const index = Number(/\[(\d+)\]/.exec(issue.path ?? "")?.[1]);
      const iface = metadata.interfaces?.[index];
      const label =
        iface?.type === "platformchat" ? `${iface.platform} platform chat` : (iface?.type ?? "This interface");
      const detail =
        iface?.type === "platformchat"
          ? "Platform events will not be received."
          : iface?.type === "webhook"
            ? "Webhook requests will not be received."
            : "The terminal interface will not start.";
      return [{ title: `${label} cannot run here`, text: `Run a web chat preview instead? ${detail}` }];
    }
    if (issue.code === "stdio-transport-unsupported") {
      const index = Number(/\[(\d+)\]/.exec(issue.path ?? "")?.[1]);
      const name = metadata.tools?.mcp?.[index]?.name ?? "This local MCP server";
      return [
        {
          title: `${name} cannot run here`,
          text: "This browser cannot start a local MCP process. Run without this tool server?",
        },
      ];
    }
    if (issue.code === "local-skill-unsupported") {
      return [
        {
          title: "Local skill unavailable",
          text: "This browser cannot read a local skill directory. Run without this skill?",
        },
      ];
    }
    if (issue.code === "model-url-unsupported") {
      return [
        {
          title: "Custom model URL unavailable",
          text: "This browser will use the model provider's default endpoint. Continue?",
        },
      ];
    }
    if (issue.code === "structured-signature-unsupported") {
      return [
        {
          title: "Structured chat unavailable",
          text: "This browser chat accepts and returns text. Run a text chat preview instead?",
        },
      ];
    }
    return [{ title: "Browser limitation", text: `${issue.message} Continue with this browser preview?` }];
  });
}
