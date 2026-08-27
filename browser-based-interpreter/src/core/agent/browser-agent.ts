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

import {
  type AgentMetadata,
  buildSystemPrompt,
  type Env,
  loadParsed,
  parseAfm,
  resolveValues,
  validateMetadata,
} from "@afm/engine";
import { type Plan, planForBrowser } from "./browser-plan";
import { isObject } from "./credentials";
import { checkSignIns, type SignIn, withoutSignIns } from "./sign-in";

type Mapping = Record<string, unknown>;
export type McpServer = NonNullable<NonNullable<AgentMetadata["tools"]>["mcp"]>[number];

export interface BrowserLoaded {
  metadata: AgentMetadata;
  role: string;
  instructions: string;
  systemPrompt: string;
  plan: Plan;
}

function withSignIns(metadata: AgentMetadata, signIns: SignIn[]): AgentMetadata {
  const { tools } = metadata;
  if (tools?.mcp === undefined || signIns.length === 0) return metadata;
  const mcp = tools.mcp.map((server) => {
    const signIn = signIns.find((found) => found.name === server.name);
    if (signIn === undefined || server.transport.type !== "http") return server;
    return { ...server, transport: { ...server.transport, authentication: signIn.auth } };
  });
  return { ...metadata, tools: { ...tools, mcp } } as AgentMetadata;
}

function declare(frontmatter: Mapping) {
  const { frontmatter: stripped, signIns } = withoutSignIns(frontmatter);
  const validated = validateMetadata(stripped);
  checkSignIns(signIns);
  return { metadata: withSignIns(validated, signIns), signIns, stripped };
}

export function declaredAgent(frontmatter: Mapping): AgentMetadata {
  return declare(frontmatter).metadata;
}

function runnableFrontmatter(frontmatter: Mapping): Mapping {
  const { model, tools, interfaces } = frontmatter;

  const webchats = [];
  if (Array.isArray(interfaces)) {
    for (const item of interfaces) {
      if (isObject(item) && item.type === "webchat") {
        webchats.push({ ...item, signature: { input: { type: "string" }, output: { type: "string" } } });
      }
    }
  }

  let httpServers = isObject(tools) ? tools.mcp : undefined;
  if (Array.isArray(httpServers)) {
    httpServers = httpServers.filter((server) => isObject(server) && isObject(server.transport) && server.transport.type === "http");
  }

  return {
    ...frontmatter,
    model: isObject(model) ? { ...model, url: undefined } : model,
    interfaces: Array.isArray(interfaces) ? webchats : interfaces,
    tools: isObject(tools) ? { ...tools, mcp: httpServers } : tools,
    skills: undefined,
  };
}

function withResolvedValues(declared: AgentMetadata, resolved: AgentMetadata): AgentMetadata {
  const { model, tools } = declared;
  const resolvedServers = resolved.tools?.mcp ?? [];
  const servers = tools?.mcp?.map((server) => resolvedServers.find((found) => found.name === server.name) ?? server);
  return {
    ...declared,
    model: model === undefined || resolved.model === undefined ? model : { ...resolved.model, url: model.url },
    tools: tools === undefined ? undefined : { ...tools, mcp: servers },
  };
}

export function loadForBrowser(content: string, env: Env): BrowserLoaded {
  const parsed = parseAfm(content);
  const { metadata: declared, signIns, stripped } = declare(parsed.frontmatter);
  const runnable = { ...parsed, role: "", instructions: "", frontmatter: runnableFrontmatter(stripped) };
  const loaded = loadParsed(runnable, { env });
  const resolvedSignIns = signIns.map((signIn) => ({ ...signIn, auth: resolveValues(signIn.auth, env) as Mapping }));
  const metadata = withSignIns(loaded.metadata, resolvedSignIns);
  return {
    metadata,
    role: parsed.role,
    instructions: parsed.instructions,
    systemPrompt: buildSystemPrompt(parsed.role, parsed.instructions),
    plan: planForBrowser(withResolvedValues(declared, metadata)),
  };
}
