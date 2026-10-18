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

export type JsonSchemaData = {
  type: string;
  properties?: Record<string, JsonSchemaData>;
  required?: string[];
  items?: JsonSchemaData;
  description?: string;
  [key: string]: unknown;
};

export const jsonSchema: z.ZodType<JsonSchemaData> = z.lazy(() =>
  z
    .object({
      type: z.string(),
      properties: z.record(z.string(), jsonSchema).optional(),
      required: z.array(z.string()).optional(),
      items: jsonSchema.optional(),
      description: z.string().optional(),
    })
    .passthrough(),
);

const stringSchema: JsonSchemaData = { type: "string" };

const signatureSchema = z
  .object({
    input: jsonSchema.default(stringSchema),
    output: jsonSchema.default(stringSchema),
  })
  .strict();

const WHOLE_NUMBER = /^\s*[+-]?\d+\s*$/;

function numberFromText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.includes("${")) return undefined;
  return WHOLE_NUMBER.test(value) ? Number(value) : value;
}

const JWT_ALGORITHMS = new Set(["RS256", "RS384", "RS512", "HS256", "HS384", "HS512"]);
const OAUTH2_CREDENTIAL_BEARERS = new Set(["auth_header", "post_body"]);

const AUTH_FIELDS = {
  bearer: { required: ["token"], allowed: ["token"] },
  basic: { required: ["username", "password"], allowed: ["username", "password"] },
  "api-key": { required: ["api_key"], allowed: ["api_key", "header_name"] },
  jwt: {
    required: ["issuer", "signing_key"],
    allowed: ["issuer", "audience", "signing_key", "algorithm", "key_id", "subject", "custom_claims", "expiry_seconds"],
  },
} as const satisfies Record<string, { required: readonly string[]; allowed: readonly string[] }>;

const RECOGNIZED_AUTH_TYPES: readonly string[] = [...Object.keys(AUTH_FIELDS), "oauth2"];

function httpUrl(field: string): z.ZodType<string> {
  return z.string().superRefine((value, ctx) => {
    if (value.includes("${")) return;
    let protocol: string;
    try {
      protocol = new URL(value).protocol;
    } catch {
      return;
    }
    if (protocol !== "http:" && protocol !== "https:") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} must be an http:// or https:// URL - got '${protocol}//'`,
      });
    }
  });
}

function fieldList(fields: string[]): string {
  return `${fields.map((field) => `'${field}'`).join(", ")} ${fields.length === 1 ? "field" : "fields"}`;
}

interface OAuth2GrantSpec {
  required: readonly string[];
  optional: readonly string[];
}

const OAUTH2_GRANTS: Record<string, OAuth2GrantSpec> = {
  client_credentials: { required: ["token_url", "client_id", "client_secret"], optional: ["scopes", "credential_bearer"] },
  password: { required: ["token_url", "username", "password", "client_id", "client_secret"], optional: ["scopes", "credential_bearer"] },
  refresh_token: { required: ["token_url", "refresh_token", "client_id", "client_secret"], optional: ["scopes", "credential_bearer"] },
  jwt_bearer: { required: ["token_url", "assertion"], optional: ["client_id", "client_secret", "scopes", "credential_bearer"] },
  authorization_code: { required: ["authorize_url", "token_url", "client_id"], optional: ["scopes"] },
};

export function postsSecretsToTokenUrl(grantType: unknown): boolean {
  const grant = typeof grantType === "string" ? grantType.toLowerCase() : "";
  return grant !== "authorization_code" && Object.hasOwn(OAUTH2_GRANTS, grant);
}

const clientAuthentication = z
  .object({
    type: z.string(),
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
    authorize_url: z.string().optional(),
    token_url: z.string().optional(),
    client_id: z.string().optional(),
    client_secret: z.string().optional(),
    refresh_token: z.string().optional(),
    assertion: z.string().optional(),
    scopes: z.array(z.string()).optional(),
    credential_bearer: z.string().optional(),
  })
  .passthrough()
  .superRefine((auth, ctx) => {
    const type = auth.type.toLowerCase();
    if (type.startsWith("x-")) return;

    if (!RECOGNIZED_AUTH_TYPES.includes(type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unknown authentication type. Supported types: ${RECOGNIZED_AUTH_TYPES.join(", ")}`,
      });
      return;
    }

    const provided = new Set(Object.keys(auth).filter((key) => key !== "type"));

    if (type === "oauth2") {
      validateOAuth2Fields(auth, provided, ctx);
      return;
    }

    const fields = AUTH_FIELDS[type as keyof typeof AUTH_FIELDS];
    const missing = fields.required.filter((field) => !provided.has(field));
    if (missing.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `type '${type}' requires ${fieldList(missing)}` });
    }

    const allowed = new Set<string>(fields.allowed);
    const unknown = [...provided].filter((field) => !allowed.has(field));
    if (unknown.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `type '${type}' does not support ${fieldList(unknown)}` });
    }

    if (type === "jwt" && auth.algorithm !== undefined) {
      validateJwtAlgorithm(auth.algorithm, ctx);
    }
  });

function validateJwtAlgorithm(algorithm: string, ctx: z.RefinementCtx): void {
  if (algorithm.toLowerCase() === "none") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "jwt 'algorithm' 'none' is not allowed; it produces an unsigned token" });
    return;
  }
  if (!JWT_ALGORITHMS.has(algorithm)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `jwt 'algorithm' is not supported. Supported algorithms: ${[...JWT_ALGORITHMS].sort().join(", ")}`,
    });
  }
}

function validateOAuth2Fields(auth: { grant_type?: string; credential_bearer?: string }, provided: Set<string>, ctx: z.RefinementCtx): void {
  if (auth.grant_type === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "type 'oauth2' requires 'grant_type' field" });
    return;
  }

  const grant = auth.grant_type.toLowerCase();
  const spec = OAUTH2_GRANTS[grant];
  if (spec === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `oauth2 'grant_type' is not supported. Supported grant types: ${Object.keys(OAUTH2_GRANTS).join(", ")}`,
    });
    return;
  }

  const missing = spec.required.filter((field) => !provided.has(field));
  if (missing.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `oauth2 grant_type '${grant}' requires ${fieldList(missing)}` });
  }

  const allowed = new Set(["grant_type", ...spec.required, ...spec.optional]);
  const unknown = [...provided].filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `oauth2 grant_type '${grant}' does not support ${fieldList(unknown)}` });
  }

  if (auth.credential_bearer !== undefined && !OAUTH2_CREDENTIAL_BEARERS.has(auth.credential_bearer)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `oauth2 'credential_bearer' is not supported. Supported values: ${[...OAUTH2_CREDENTIAL_BEARERS].sort().join(", ")}`,
    });
  }
}

const providerSchema = z
  .object({
    name: z.string().optional(),
    url: httpUrl("provider.url").optional(),
  })
  .strict();

const modelSchema = z
  .object({
    name: z.string().optional(),
    provider: z.string().optional(),
    url: httpUrl("model.url").optional(),
    authentication: clientAuthentication.optional(),
  })
  .strict();

const httpTransport = z
  .object({
    type: z.literal("http"),
    url: httpUrl("transport.url"),
    authentication: clientAuthentication.optional(),
  })
  .strict();

const stdioTransport = z
  .object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const transport = z.discriminatedUnion("type", [httpTransport, stdioTransport]);

const toolFilter = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

const mcpServer = z
  .object({
    name: z.string(),
    transport,
    tool_filter: toolFilter.optional(),
  })
  .strict();

const toolsSchema = z
  .object({
    mcp: z.array(mcpServer).optional(),
  })
  .strict();

const httpExposure = z.object({ path: z.string() }).strict();
const exposure = z.object({ http: httpExposure.optional() }).strict();

const subscription = z
  .object({
    protocol: z.string(),
    hub: z.string().optional(),
    topic: z.string().optional(),
    callback: z.string().optional(),
    secret: z.string().optional(),
    authentication: clientAuthentication.optional(),
  })
  .strict();

const defaultSignature = { input: stringSchema, output: stringSchema };

const consoleChatInterface = z
  .object({
    type: z.literal("consolechat"),
    signature: signatureSchema.default(defaultSignature),
  })
  .strict();

const webChatInterface = z
  .object({
    type: z.literal("webchat"),
    signature: signatureSchema.default(defaultSignature),
    exposure: exposure.default({ http: { path: "/chat" } }),
  })
  .strict();

const webhookInterface = z
  .object({
    type: z.literal("webhook"),
    prompt: z.string().optional(),
    signature: signatureSchema.default(defaultSignature),
    exposure: exposure.default({ http: { path: "/webhook" } }),
    subscription,
  })
  .strict();

const interfaceSchema = z.discriminatedUnion("type", [
  consoleChatInterface,
  webChatInterface,
  webhookInterface,
]);

const localSkillSource = z
  .object({
    type: z.literal("local"),
    path: z.string(),
  })
  .strict();

const skillSource = localSkillSource;

export const agentMetadataSchema = z
  .object({
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
    skills: z.array(skillSource).optional(),
    max_iterations: z.preprocess(numberFromText, z.number().int().positive().optional()),
  })
  .strict();

export type AgentMetadata = z.infer<typeof agentMetadataSchema>;
export type ClientAuthentication = z.infer<typeof clientAuthentication>;

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
