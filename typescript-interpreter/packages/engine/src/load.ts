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

import { parseAfm } from "./parse";
import { type AgentMetadata, validateMetadata } from "./schema";
import { asMapping, type SecretPort, type UnknownRecord } from "./types";
import { isInsecureAddress, isPlainHttpAddress, resolveVariables } from "./variables";

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

const SUPPORTED_MODEL_PROVIDERS: readonly string[] = ["openai", "anthropic"];
const SUPPORTED_MODEL_AUTH: readonly string[] = ["api-key", "bearer"];
const SUPPORTED_TOOL_AUTH: readonly string[] = ["bearer", "basic", "api-key", "oauth2"];

const warning = (code: string, message: string, path: string): PlanIssue => ({ severity: "warning", code, message, path });
const blocked = (code: string, message: string, path: string): PlanIssue => ({ severity: "blocked", code, message, path });

function isPlainString(schema: unknown): boolean {
  return typeof schema === "object" && schema !== null &&
    Object.keys(schema).length === 1 && "type" in schema && schema.type === "string";
}

function interfaceIssues(metadata: AgentMetadata): PlanIssue[] {
  return (metadata.interfaces ?? []).flatMap((iface, i) => {
    if (iface.type !== "webchat") {
      return [
        warning(
          "interface-unsupported",
          `The '${iface.type}' interface does not run in this browser. You can try the agent in web chat instead.`,
          `interfaces[${i}]`,
        ),
      ];
    }
    if (isPlainString(iface.signature.input) && isPlainString(iface.signature.output)) return [];
    return [
      warning(
        "structured-signature-unsupported",
        "This webchat defines structured input or output. This browser chat accepts and returns text.",
        `interfaces[${i}].signature`,
      ),
    ];
  });
}

function modelUrlIssues(metadata: AgentMetadata): PlanIssue[] {
  if (metadata.model?.url === undefined) return [];
  return [warning("model-url-unsupported", "This browser cannot use the custom model URL. It can use the provider's default endpoint instead.", "model.url")];
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

const isPlainSignInAddress = (address: string | undefined): boolean =>
  address !== undefined && !address.includes("${") && isPlainHttpAddress(address);

function toolServerIssues(metadata: AgentMetadata): PlanIssue[] {
  return (metadata.tools?.mcp ?? []).flatMap((server, i) => {
    const { transport } = server;
    if (transport.type === "stdio") {
      return [
        warning(
          "stdio-transport-unsupported",
          `MCP server '${server.name}' uses stdio, which a browser cannot run; it will be skipped. Only HTTP MCP works (via the proxy).`,
          `tools.mcp[${i}].transport`,
        ),
      ];
    }
    const authentication = transport.authentication;
    const path = `tools.mcp[${i}].transport.authentication`;
    if (authentication === undefined) return [];
    const type = authentication.type.toLowerCase();
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
          `MCP server '${server.name}' uses ${authentication.type} authentication, which this browser cannot use. ` +
            "Configure a supported authentication method.",
          path,
        ),
      ];
    }
    const issues: PlanIssue[] = [];
    if (!transport.url.includes("${") && isInsecureAddress(transport.url)) {
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
    warning("local-skill-unsupported", "This browser cannot read a local skill directory. The skill will be skipped.", `skills[${i}]`),
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

const textSignature = () => ({ input: { type: "string" }, output: { type: "string" } });

function webchatOnly(interfaces: unknown): unknown {
  if (!Array.isArray(interfaces)) return interfaces;
  return interfaces.flatMap((item) => {
    const iface = asMapping(item);
    return iface?.type === "webchat" ? [{ ...iface, signature: textSignature() }] : [];
  });
}

function httpServersOnly(mcp: unknown): unknown {
  if (!Array.isArray(mcp)) return mcp;
  return mcp.filter((item) => asMapping(asMapping(item)?.transport)?.type === "http");
}

function browserRunMetadata(metadata: UnknownRecord): UnknownRecord {
  const model = asMapping(metadata.model);
  const tools = asMapping(metadata.tools);
  return {
    ...metadata,
    model: model === null ? metadata.model : { ...model, url: undefined },
    interfaces: webchatOnly(metadata.interfaces),
    tools: tools === null ? metadata.tools : { ...tools, mcp: httpServersOnly(tools.mcp) },
    skills: undefined,
  };
}

export interface LoadedAfm {
  metadata: AgentMetadata;
  role: string;
  instructions: string;
  systemPrompt: string;
  plan: Plan;
}

export interface LoadOptions {
  forBrowser?: boolean;
}

export function buildSystemPrompt(role: string, instructions: string): string {
  return `# Role\n\n${role}\n\n# Instructions\n\n${instructions}`;
}

function withResolvedValues(declared: AgentMetadata, resolved: AgentMetadata): AgentMetadata {
  const resolvedServers = resolved.tools?.mcp ?? [];
  let nextResolved = 0;
  const { model, tools } = declared;
  return {
    ...declared,
    model: model === undefined || resolved.model === undefined ? model : { ...resolved.model, url: model.url },
    tools:
      tools === undefined
        ? undefined
        : {
            ...tools,
            mcp: tools.mcp?.map((server) => (server.transport.type === "http" ? (resolvedServers[nextResolved++] ?? server) : server)),
          },
  };
}

export async function loadAfm(content: string, secrets: SecretPort, options: LoadOptions = {}): Promise<LoadedAfm> {
  const { forBrowser = false } = options;
  const parsed = parseAfm(content);
  const declared = validateMetadata(parsed.frontmatter);
  const runnable = forBrowser ? browserRunMetadata(parsed.frontmatter) : parsed.frontmatter;
  const metadata = validateMetadata(await resolveVariables(runnable, secrets));

  return {
    metadata,
    role: parsed.role,
    instructions: parsed.instructions,
    systemPrompt: buildSystemPrompt(parsed.role, parsed.instructions),
    plan: planForBrowser(forBrowser ? withResolvedValues(declared, metadata) : metadata),
  };
}
