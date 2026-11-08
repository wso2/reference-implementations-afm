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

const JWT_ALGORITHMS = new Set(["RS256", "RS384", "RS512", "HS256", "HS384", "HS512"]);

interface FieldSpec {
  required: readonly string[];
  optional: readonly string[];
}

const AUTH_FIELDS: Record<string, FieldSpec> = {
  bearer: { required: ["token"], optional: [] },
  "api-key": { required: ["api_key"], optional: ["header_name"] },
  jwt: {
    required: ["issuer", "signing_key"],
    optional: ["audience", "algorithm", "key_id", "subject", "custom_claims", "expiry_seconds"],
  },
};

const RECOGNIZED_AUTH_TYPES: readonly string[] = [...Object.keys(AUTH_FIELDS), "oauth2"];

const AUTHORIZATION_CODE: FieldSpec = { required: ["authorize_url", "token_url", "client_id"], optional: ["scopes"] };

function checkFields(label: string, spec: FieldSpec, provided: Set<string>, ctx: z.RefinementCtx): void {
  const missing = spec.required.filter((field) => !provided.has(field));
  if (missing.length > 0) reportIssue(ctx, `${label} requires ${fieldList(missing)}`);

  const allowed = new Set<string>([...spec.required, ...spec.optional]);
  const unknown = [...provided].filter((field) => !allowed.has(field));
  if (unknown.length > 0) reportIssue(ctx, `${label} does not support ${fieldList(unknown)}`);
}

function validateJwtAlgorithm(algorithm: string, ctx: z.RefinementCtx): void {
  if (algorithm.toLowerCase() === "none") {
    reportIssue(ctx, "jwt 'algorithm' 'none' is not allowed; it produces an unsigned token");
    return;
  }
  if (!JWT_ALGORITHMS.has(algorithm)) {
    reportIssue(ctx, `jwt 'algorithm' is not supported. Supported algorithms: ${[...JWT_ALGORITHMS].sort().join(", ")}`);
  }
}

function validateOAuth2Fields(auth: { grant_type?: string }, provided: Set<string>, ctx: z.RefinementCtx): void {
  if (auth.grant_type === undefined) {
    reportIssue(ctx, "type 'oauth2' requires 'grant_type' field");
  } else if (auth.grant_type.toLowerCase() !== "authorization_code") {
    reportIssue(ctx, "oauth2 'grant_type' is not supported. Supported grant types: authorization_code");
  } else {
    checkFields("oauth2 grant_type 'authorization_code'", AUTHORIZATION_CODE, new Set([...provided].filter((field) => field !== "grant_type")), ctx);
  }
}

const clientAuthentication = z
  .looseObject({
    type: z.string().min(1),
    token: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    api_key: z.string().optional(),
    header_name: z.string().optional(),
    issuer: z.string().optional(),
    audience: z.union([z.string(), z.array(z.string())]).optional(),
    signing_key: z.string().optional(),
    algorithm: z.string().optional(),
    key_id: z.string().optional(),
    subject: z.string().optional(),
    custom_claims: z.record(z.string(), z.unknown()).optional(),
    expiry_seconds: z.preprocess(numberFromText, z.number().int().optional()),
    grant_type: z.string().optional(),
    authorize_url: httpUrl("authentication.authorize_url").optional(),
    token_url: httpUrl("authentication.token_url").optional(),
    client_id: z.string().optional(),
    scopes: z.array(z.string()).optional(),
  })
  .superRefine((auth, ctx) => {
    const type = auth.type.toLowerCase();
    if (!RECOGNIZED_AUTH_TYPES.includes(type)) return;

    const provided = new Set(Object.keys(auth).filter((key) => key !== "type"));

    if (type === "oauth2") {
      validateOAuth2Fields(auth, provided, ctx);
      return;
    }

    checkFields(`type '${type}'`, AUTH_FIELDS[type]!, provided, ctx);

    if (type === "jwt" && auth.algorithm !== undefined) {
      validateJwtAlgorithm(auth.algorithm, ctx);
    }
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
