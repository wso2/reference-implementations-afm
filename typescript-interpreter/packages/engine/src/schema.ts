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

import { z } from "zod";
import { AfmValidationError } from "./errors";

const WHOLE_NUMBER = /^\s*[+-]?\d+\s*$/;

function numberFromText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.includes("${")) return /^\$\{[^{}]+\}$/.test(value.trim()) ? undefined : value;
  return WHOLE_NUMBER.test(value) ? Number(value) : value;
}

function reportIssue(ctx: z.RefinementCtx, message: string, path?: (string | number)[]): void {
  ctx.addIssue({ code: "custom", message, ...(path === undefined ? {} : { path }) });
}

function httpUrl(field: string): z.ZodType<string> {
  return z.string().superRefine((value, ctx) => {
    if (value.includes("${")) return;
    let protocol: string;
    try {
      protocol = new URL(value).protocol;
    } catch {
      reportIssue(ctx, `${field} must be an absolute http:// or https:// URL`);
      return;
    }
    if (protocol !== "http:" && protocol !== "https:") {
      reportIssue(ctx, `${field} must be an http:// or https:// URL - got '${protocol}//'`);
    }
  });
}

function fieldList(fields: string[]): string {
  return `${fields.map((field) => `'${field}'`).join(", ")} ${fields.length === 1 ? "field" : "fields"}`;
}

interface FieldSpec {
  required: readonly string[];
  optional: readonly string[];
}

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const SIGNING: FieldSpec = {
  required: ["issuer", "audience", "signing_key"],
  optional: ["algorithm", "key_id", "subject", "custom_claims", "expiry_seconds"],
};
const TOKEN_REQUEST = ["client_id", "client_secret", "scopes", "token_endpoint_auth_method", "resource", "extra_params"];

const AUTH_FIELDS = new Map<string, FieldSpec>([
  ["bearer", { required: ["token"], optional: [] }],
  ["basic", { required: ["username", "password"], optional: [] }],
  ["api-key", { required: ["api_key"], optional: ["header_name"] }],
  ["jwt", SIGNING],
]);

const GRANT_FIELDS = new Map<string, FieldSpec>([
  ["client_credentials", { required: ["grant_type", "token_url"], optional: TOKEN_REQUEST }],
  [JWT_BEARER, { required: ["grant_type", "token_url", "assertion_signing"], optional: TOKEN_REQUEST }],
]);

const isEmpty = (value: unknown): boolean => value === undefined || value === "" || (Array.isArray(value) && value.length === 0);

function checkFields(label: string, spec: FieldSpec, block: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const given = Object.keys(block).filter((key) => key !== "type");
  const nulls = given.filter((key) => block[key] === null);
  const missing = spec.required.filter((key) => isEmpty(block[key]));
  const unknown = given.filter((key) => !spec.required.includes(key) && !spec.optional.includes(key));
  if (nulls.length > 0) reportIssue(ctx, `${label} must not set ${fieldList(nulls)} to null`);
  if (missing.length > 0) reportIssue(ctx, `${label} requires ${fieldList(missing)}`);
  if (unknown.length > 0) reportIssue(ctx, `${label} does not support ${fieldList(unknown)}`);
}

function checkOAuth2(block: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const grant = typeof block.grant_type === "string" ? block.grant_type.toLowerCase() : "";
  const spec = GRANT_FIELDS.get(grant);
  if (spec === undefined) {
    reportIssue(ctx, `type 'oauth2' requires a 'grant_type' of client_credentials or ${JWT_BEARER}`);
    return;
  }
  checkFields(`oauth2 grant_type '${grant}'`, spec, block, ctx);

  const clientAuthenticates = block.token_endpoint_auth_method !== "none";
  if (clientAuthenticates && (isEmpty(block.client_id) || isEmpty(block.client_secret))) {
    reportIssue(ctx, "oauth2 requires 'client_id' and 'client_secret' unless 'token_endpoint_auth_method' is 'none'");
  }
  if (!clientAuthenticates && grant === "client_credentials") {
    reportIssue(ctx, "oauth2 'token_endpoint_auth_method' 'none' is only for the jwt-bearer grant");
  }
  if (!clientAuthenticates && block.client_secret !== undefined) {
    reportIssue(ctx, "oauth2 must not set 'client_secret' with 'token_endpoint_auth_method' 'none'");
  }
  const signing = block.assertion_signing;
  if (typeof signing === "object" && signing !== null) checkFields("oauth2 'assertion_signing'", SIGNING, signing as Record<string, unknown>, ctx);
  else if (signing !== undefined) reportIssue(ctx, "oauth2 'assertion_signing' must be an object");
}

const clientAuthentication = z
  .looseObject({
    type: z.string().min(1),
    token: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    api_key: z.string().optional(),
    header_name: z.string().optional(),
  })
  .superRefine((auth, ctx) => {
    const type = auth.type.toLowerCase();
    if (type === "oauth2") {
      checkOAuth2(auth, ctx);
      return;
    }
    const spec = AUTH_FIELDS.get(type);
    if (spec === undefined) {
      reportIssue(ctx, "authentication type is not recognized; use bearer, basic, api-key, jwt or oauth2");
      return;
    }
    checkFields(`type '${type}'`, spec, auth, ctx);
  });

export type ClientAuthentication = z.infer<typeof clientAuthentication>;

const httpTransport = z.strictObject({
  type: z.literal("http"),
  url: httpUrl("transport.url"),
  authentication: clientAuthentication.optional(),
});

const stdioTransport = z.strictObject({
  type: z.literal("stdio"),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const transport = z.discriminatedUnion("type", [httpTransport, stdioTransport]);

const toolFilter = z.strictObject({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
});

const mcpServer = z.strictObject({
  name: z.string(),
  transport,
  tool_filter: toolFilter.optional(),
});

const toolsSchema = z.strictObject({
  mcp: z.array(mcpServer).optional(),
});

function checkServerNames(tools: z.infer<typeof toolsSchema> | undefined, ctx: z.RefinementCtx): void {
  const names = new Set<string>();
  tools?.mcp?.forEach((server, index) => {
    if (names.has(server.name)) {
      reportIssue(ctx, `Duplicate MCP server name '${server.name}'`, ["tools", "mcp", index, "name"]);
    }
    names.add(server.name);
  });
}

export type JsonSchemaData = boolean | { type?: string | string[]; [key: string]: unknown };

export const jsonSchema: z.ZodType<JsonSchemaData> = z.union([z.boolean(), z.record(z.string(), z.unknown())]);

const stringSchema: JsonSchemaData = { type: "string" };
const defaultSignature = { input: stringSchema, output: stringSchema };

const signatureSchema = z.strictObject({
  input: jsonSchema.default(stringSchema),
  output: jsonSchema.default(stringSchema),
});

const eventSignatureSchema = z.strictObject({ input: jsonSchema.optional(), output: jsonSchema.optional() });

const httpExposure = z.strictObject({ path: z.string().optional() });
const exposure = z.strictObject({ http: httpExposure.optional() });

const subscription = z.strictObject({
  protocol: z.string(),
  hub: z.string().optional(),
  topic: z.string().optional(),
  callback: z.string().optional(),
  secret: z.string().optional(),
  authentication: clientAuthentication.optional(),
});

const consoleChatInterface = z.strictObject({
  type: z.literal("consolechat"),
  signature: signatureSchema.default(defaultSignature),
});

const webChatInterface = z.strictObject({
  type: z.literal("webchat"),
  signature: signatureSchema.default(defaultSignature),
  exposure: exposure.default({ http: { path: "/chat" } }),
});

const webhookInterface = z.strictObject({
  type: z.literal("webhook"),
  prompt: z.string().optional(),
  signature: eventSignatureSchema.optional(),
  exposure: exposure.default({ http: { path: "/webhook" } }),
  subscription: subscription.optional(),
});

const platformChatInterface = z.strictObject({
  type: z.literal("platformchat"),
  platform: z.string().min(1),
  mode: z.enum(["notification", "request", "polling"]),
  prompt: z.string().optional(),
  signature: eventSignatureSchema.optional(),
  platform_config: z.record(z.string(), z.unknown()).optional(),
  exposure: exposure.optional(),
  polling: z
    .strictObject({
      interval: z.preprocess(numberFromText, z.number().int().positive().optional()),
      timeout: z.preprocess(numberFromText, z.number().int().positive().optional()),
    })
    .optional(),
  authentication: clientAuthentication.optional(),
});

const interfaceSchema = z.discriminatedUnion("type", [
  consoleChatInterface,
  webChatInterface,
  webhookInterface,
  platformChatInterface,
]);

function checkInterfaces(interfaces: z.infer<typeof interfaceSchema>[] | undefined, ctx: z.RefinementCtx): void {
  interfaces?.forEach((iface, index) => {
    if (iface.type !== "platformchat") return;
    const at = (field: string): (string | number)[] => ["interfaces", index, field];
    if (iface.mode !== "request" && iface.signature?.output !== undefined) {
      reportIssue(ctx, `platformchat mode '${iface.mode}' must not set signature.output`, ["interfaces", index, "signature", "output"]);
    }
    if (iface.mode === "polling" && iface.exposure !== undefined) {
      reportIssue(ctx, "platformchat polling must not set exposure", at("exposure"));
    }
    if (iface.mode !== "polling" && iface.polling !== undefined) {
      reportIssue(ctx, `platformchat mode '${iface.mode}' must not set polling`, at("polling"));
    }
    if (iface.mode !== "polling" && iface.authentication !== undefined) {
      reportIssue(ctx, `platformchat mode '${iface.mode}' must not set authentication`, at("authentication"));
    }
  });
}

const providerSchema = z.strictObject({
  name: z.string().optional(),
  url: httpUrl("provider.url").optional(),
});

const modelSchema = z.strictObject({
  name: z.string().optional(),
  provider: z.string().optional(),
  url: httpUrl("model.url").optional(),
  authentication: clientAuthentication.optional(),
});

const skillSchema = z.strictObject({
  type: z.literal("local"),
  path: z.string(),
});

export const agentMetadataSchema = z
  .strictObject({
    spec_version: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
    author: z.string().optional(),
    authors: z.array(z.string()).optional(),
    icon_url: httpUrl("icon_url").optional(),
    provider: providerSchema.optional(),
    license: z.string().optional(),
    model: modelSchema.optional(),
    interfaces: z.array(interfaceSchema).optional(),
    tools: toolsSchema.optional(),
    skills: z.array(skillSchema).optional(),
    max_iterations: z.preprocess(numberFromText, z.number().int().positive().optional()),
  })
  .superRefine((metadata, ctx) => {
    checkServerNames(metadata.tools, ctx);
    checkInterfaces(metadata.interfaces, ctx);
  });

export type AgentMetadata = z.infer<typeof agentMetadataSchema>;

export function validateMetadata(raw: Record<string, unknown>): AgentMetadata {
  const result = agentMetadataSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue ? issue.path.join(".") : "";
    const message = issue ? issue.message : "invalid agent metadata";
    throw new AfmValidationError(message, field);
  }
  return result.data;
}
