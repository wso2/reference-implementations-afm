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

export class TemplateError extends Error {}

type Segment = string | { payload: string } | { header: string };
export type PromptTemplate = Segment[];
export type RequestHeaders = Record<string, string | string[] | undefined>;

function httpVariable(expression: string): Segment {
  const part = expression.slice("http:".length);
  if (part === "payload") return { payload: "" };
  if (part.startsWith("payload.") || part.startsWith("payload[")) {
    const path = part.slice(part.startsWith("payload.") ? "payload.".length : "payload".length);
    if (path === "") throw new TemplateError(`Invalid http variable format: ${expression}`);
    return { payload: path };
  }
  if (part.startsWith("header.")) {
    const name = part.slice("header.".length);
    if (name === "") throw new TemplateError(`Invalid http variable format: ${expression}`);
    return { header: name };
  }
  throw new TemplateError(`Unknown http variable prefix: ${part.split(".")[0]}`);
}

export function compileTemplate(template: string): PromptTemplate {
  const segments: PromptTemplate = [];
  let at = 0;
  while (at < template.length) {
    const open = template.indexOf("${", at);
    const close = open === -1 ? -1 : template.indexOf("}", open);
    if (close === -1) {
      segments.push(template.slice(at));
      break;
    }
    if (open > at) segments.push(template.slice(at, open));
    const expression = template.slice(open + 2, close);
    segments.push(expression.startsWith("http:") ? httpVariable(expression) : "${" + expression + "}");
    at = close + 1;
  }
  return segments;
}

function ownField(value: unknown, name: string, rest: string): unknown {
  if (name === "") throw new TemplateError(`Empty field name in path: ${rest}`);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TemplateError(`Cannot access field '${name}' on non-object`);
  if (!Object.hasOwn(value, name)) throw new TemplateError(`Field '${name}' not found`);
  return (value as Record<string, unknown>)[name];
}

function bracket(value: unknown, rest: string): [unknown, string] {
  const close = rest.indexOf("]");
  if (close === -1) throw new TemplateError(`Invalid bracket notation in path: ${rest}`);
  const inside = rest.slice(1, close);
  const after = rest.slice(close + 1);
  if (inside.length >= 2 && (inside[0] === "'" || inside[0] === '"') && inside.endsWith(inside[0]!)) {
    return [ownField(value, inside.slice(1, -1), rest), after];
  }
  if (!/^-?\d+$/.test(inside)) throw new TemplateError(`Invalid array index: ${inside}`);
  const index = Number(inside);
  if (!Array.isArray(value)) throw new TemplateError(`Cannot access index ${index} on non-array`);
  if (index < 0 || index >= value.length) throw new TemplateError(`Array index out of bounds: ${index}`);
  return [value[index], after];
}

function payloadField(payload: unknown, path: string): unknown {
  let current = payload;
  let rest = path;
  while (rest !== "") {
    if (rest.startsWith("[")) {
      [current, rest] = bracket(current, rest);
    } else if (rest.startsWith(".")) {
      if (rest.startsWith("..")) throw new TemplateError(`Empty field name in path: ${rest}`);
      rest = rest.slice(1);
    } else {
      const end = rest.search(/[.[]/);
      const name = end === -1 ? rest : rest.slice(0, end);
      current = ownField(current, name, rest);
      rest = end === -1 ? "" : rest.slice(end);
    }
  }
  return current;
}

function headerValue(headers: RequestHeaders, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value !== undefined) return Array.isArray(value) ? value.join(", ") : value;
  }
  throw new TemplateError(`Cannot resolve header variable '${"${http:header." + name + "}"}': header not found`);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function evaluateTemplate(template: PromptTemplate, payload: unknown, headers: RequestHeaders): string {
  return template
    .map((segment) => {
      if (typeof segment === "string") return segment;
      if ("header" in segment) return headerValue(headers, segment.header);
      if (segment.payload === "") return JSON.stringify(payload);
      try {
        return textOf(payloadField(payload, segment.payload));
      } catch (error) {
        throw new TemplateError(`Cannot resolve payload variable '${"${http:payload." + segment.payload + "}"}': ${(error as Error).message}`);
      }
    })
    .join("");
}
