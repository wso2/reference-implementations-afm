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

import type { AgentMetadata } from "@afm/engine";
import { isInsecure, parseUrl } from "./addresses";
import { isInteractiveOAuth } from "../oauth/session";

type PlanSeverity = "warning" | "blocked";

export interface Confirmation {
  title: string;
  text: string;
}

export interface PlanIssue {
  severity: PlanSeverity;
  code: string;
  message: string;
  path?: string;
  confirm?: Confirmation;
}

export interface Plan {
  runnable: boolean;
  issues: PlanIssue[];
}

const SUPPORTED_MODEL_PROVIDERS: readonly string[] = ["openai", "anthropic"];
const SUPPORTED_MODEL_AUTH: readonly string[] = ["api-key", "bearer"];
const SUPPORTED_TOOL_AUTH: readonly string[] = ["bearer", "api-key", "oauth2"];

const warning = (code: string, message: string, path: string, confirm: Confirmation): PlanIssue => ({
  severity: "warning",
  code,
  message,
  path,
  confirm,
});
const blocked = (code: string, message: string, path: string): PlanIssue => ({ severity: "blocked", code, message, path });

function isPlainString(schema: unknown): boolean {
  return typeof schema === "object" && schema !== null &&
    Object.keys(schema).length === 1 && "type" in schema && schema.type === "string";
}

function interfaceIssues(metadata: AgentMetadata): PlanIssue[] {
  return (metadata.interfaces ?? []).flatMap((iface, i) => {
    if (iface.type !== "webchat") {
      const label = iface.type === "platformchat" ? `${iface.platform} platform chat` : iface.type;
      const lost =
        iface.type === "platformchat"
          ? "Platform events will not be received."
          : iface.type === "webhook"
            ? "Webhook requests will not be received."
            : "The terminal interface will not start.";
      return [
        warning(
          "interface-unsupported",
          `The '${iface.type}' interface does not run in this browser. You can try the agent in web chat instead.`,
          `interfaces[${i}]`,
          { title: `${label} cannot run here`, text: `Run a web chat preview instead? ${lost}` },
        ),
      ];
    }
    if (isPlainString(iface.signature.input) && isPlainString(iface.signature.output)) return [];
    return [
      warning(
        "structured-signature-unsupported",
        "This webchat defines structured input or output. This browser chat accepts and returns text.",
        `interfaces[${i}].signature`,
        {
          title: "Structured chat unavailable",
          text: "This browser chat accepts and returns text. Run a text chat preview instead?",
        },
      ),
    ];
  });
}

function modelUrlIssues(metadata: AgentMetadata): PlanIssue[] {
  if (metadata.model?.url === undefined) return [];
  return [
    blocked(
      "model-url-unsupported",
      "This agent sets its own model address (`url`). This app can only use the official OpenAI and Anthropic addresses, so it cannot run the agent as written. Remove `url` from the file to run it here.",
      "model.url",
    ),
  ];
}

function modelProviderIssues(metadata: AgentMetadata): PlanIssue[] {
  const provider = metadata.model?.provider;
  if (provider === undefined || SUPPORTED_MODEL_PROVIDERS.includes(provider.toLowerCase())) return [];
  return [
    blocked(
      "model-provider-unsupported",
      `Model provider '${provider}' is valid AFM but is not supported by this browser. Choose OpenAI or Anthropic to run here.`,
      "model.provider",
    ),
  ];
}

function modelAuthIssues(metadata: AgentMetadata): PlanIssue[] {
  const type = metadata.model?.authentication?.type.toLowerCase();
  if (type === undefined || SUPPORTED_MODEL_AUTH.includes(type)) return [];
  return [
    blocked(
      "model-auth-unsupported",
      `The model's '${type}' authentication does not run in this browser; use an API key or bearer token.`,
      "model.authentication",
    ),
  ];
}

const SIGN_IN_ADDRESS_FIELDS = ["authorize_url", "token_url"] as const;

function hostIsKnown(address: string): boolean {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(address);
  return authority !== null && !authority[1]!.includes("${");
}

const isPlainSignInAddress = (address: unknown): boolean =>
  typeof address === "string" && hostIsKnown(address) && parseUrl(address)?.protocol === "http:";

function toolServerIssues(metadata: AgentMetadata): PlanIssue[] {
  return (metadata.tools?.mcp ?? []).flatMap((server, i) => {
    const { transport } = server;
    if (transport.type === "stdio") {
      return [
        warning(
          "stdio-transport-unsupported",
          `MCP server '${server.name}' uses stdio, which a browser cannot run; it will be skipped. Only HTTP MCP works (via the proxy).`,
          `tools.mcp[${i}].transport`,
          {
            title: `${server.name} cannot run here`,
            text: "This browser cannot start a local MCP process. Run without this tool server?",
          },
        ),
      ];
    }
    const address = parseUrl(transport.url);
    if (address !== null && (address.username !== "" || address.password !== "")) {
      return [
        blocked(
          "tool-address-credentials",
          `MCP server '${server.name}' has a user name or password in its address, which would pass through the proxy and its logs. Put credentials in the authentication block instead.`,
          `tools.mcp[${i}].transport.url`,
        ),
      ];
    }
    const authentication = transport.authentication;
    const path = `tools.mcp[${i}].transport.authentication`;
    if (authentication === undefined) return [];
    const type = authentication.type.toLowerCase();
    if (type === "oauth2" && !isInteractiveOAuth(authentication)) {
      return [
        blocked(
          "oauth-grant-unsupported",
          `MCP server '${server.name}' uses an oauth2 grant that needs a secret kept on a server, which a browser cannot keep. ` +
            "Use provider sign-in (grant_type: authorization_code) or an access token.",
          path,
        ),
      ];
    }
    if (type === "jwt") {
      return [
        blocked(
          "jwt-auth-unsupported",
          `MCP server '${server.name}' uses jwt authentication, which needs a server-side runtime. In a browser, use oauth2 sign-in or a bearer access token.`,
          path,
        ),
      ];
    }
    if (!SUPPORTED_TOOL_AUTH.includes(type)) {
      return [
        blocked(
          "tool-auth-unsupported",
          `MCP server '${server.name}' uses ${authentication.type} authentication, which is not supported. ` +
            "Use an access token, a key in a header, or provider sign-in.",
          path,
        ),
      ];
    }
    const issues: PlanIssue[] = [];
    if (hostIsKnown(transport.url) && isInsecure(transport.url)) {
      issues.push(
        blocked(
          "tool-credentials-insecure",
          `MCP server '${server.name}' would send its credentials over plain http://, where anyone on the network could read them. ` +
            "Use an https:// address (http://localhost is allowed).",
          `tools.mcp[${i}].transport.url`,
        ),
      );
    }
    const signInAddress = type === "oauth2" ? SIGN_IN_ADDRESS_FIELDS.find((field) => isPlainSignInAddress(authentication[field])) : undefined;
    if (signInAddress !== undefined) {
      issues.push(
        blocked(
          "oauth-address-insecure",
          `MCP server '${server.name}' signs in over plain http://, but sign-in addresses must use https://. Use an https:// address.`,
          `${path}.${signInAddress}`,
        ),
      );
    }
    return issues;
  });
}

function skillIssues(metadata: AgentMetadata): PlanIssue[] {
  return (metadata.skills ?? []).map((_, i) =>
    warning(
      "local-skill-unsupported",
      "This browser cannot read a local skill directory. The skill will be skipped.",
      `skills[${i}]`,
      {
        title: "Local skill unavailable",
        text: "This browser cannot read a local skill directory. Run without this skill?",
      },
    ),
  );
}

const RULES: readonly ((metadata: AgentMetadata) => PlanIssue[])[] = [
  interfaceIssues,
  modelUrlIssues,
  modelProviderIssues,
  modelAuthIssues,
  toolServerIssues,
  skillIssues,
];

export function planForBrowser(metadata: AgentMetadata): Plan {
  const issues = RULES.flatMap((rule) => rule(metadata));
  return { runnable: !issues.some((issue) => issue.severity === "blocked"), issues };
}

export function confirmationsOf(plan: Plan): Confirmation[] {
  const confirmations: Confirmation[] = [];
  for (const issue of plan.issues) {
    if (issue.confirm !== undefined) confirmations.push(issue.confirm);
  }
  return confirmations;
}
