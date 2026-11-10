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
import type { JsonSchemaData } from "./schema";

export interface Signature {
  input: JsonSchemaData;
  output: JsonSchemaData;
}

export const TEXT_SIGNATURE: Signature = { input: { type: "string" }, output: { type: "string" } };

export class SchemaError extends Error {
  constructor(
    readonly source: "input" | "output",
    message: string,
  ) {
    super(message);
  }
}

const compiled = new WeakMap<object, z.ZodType>();

function validator(schema: JsonSchemaData): z.ZodType {
  const known = typeof schema === "object" ? compiled.get(schema) : undefined;
  if (known !== undefined) return known;
  const made = z.fromJSONSchema(schema as never) as z.ZodType;
  if (typeof schema === "object") compiled.set(schema, made);
  return made;
}

export const isTextSchema = (schema: JsonSchemaData): boolean => typeof schema === "object" && schema.type === "string";

function problems(value: unknown, schema: JsonSchemaData): string | undefined {
  const result = validator(schema).safeParse(value);
  if (result.success) return undefined;
  return result.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ` : "") + issue.message).join("; ");
}

export function checkSignature(signature: Signature, label: string): void {
  for (const side of ["input", "output"] as const) {
    try {
      validator(signature[side]);
    } catch (error) {
      throw new Error(`The ${side} schema of the ${label} interface is not valid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function inputText(data: unknown, schema: JsonSchemaData): string {
  const failure = problems(data, schema);
  if (failure !== undefined) throw new SchemaError("input", failure);
  return typeof data === "string" ? data : JSON.stringify(data);
}

const FENCE = "```";

export function outputInstruction(schema: JsonSchemaData): string {
  if (isTextSchema(schema)) return "";
  return `\n\nThe final response MUST conform to the following JSON schema:\n${JSON.stringify(schema, null, 2)}\n\nRespond only with the JSON value enclosed between ${FENCE} and ${FENCE}.\nDo not include any other text or explanation outside the code block.`;
}

function codeBlock(reply: string): string {
  const json = reply.indexOf(`${FENCE}json`);
  const generic = reply.indexOf(FENCE);
  const open = json !== -1 ? json + FENCE.length + "json".length : generic !== -1 ? generic + FENCE.length : -1;
  const close = open === -1 ? -1 : reply.indexOf(FENCE, open);
  return close === -1 ? reply.trim() : reply.slice(open, close).trim();
}

export function outputValue(reply: string, schema: JsonSchemaData): unknown {
  if (isTextSchema(schema)) {
    const failure = problems(reply, schema);
    if (failure !== undefined) throw new SchemaError("output", failure);
    return reply;
  }
  let value: unknown;
  try {
    value = JSON.parse(codeBlock(reply));
  } catch (error) {
    throw new SchemaError("output", `Failed to parse response as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const failure = problems(value, schema);
  if (failure !== undefined) throw new SchemaError("output", failure);
  return value;
}
