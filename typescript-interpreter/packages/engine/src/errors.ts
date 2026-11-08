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

export class AfmParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AfmParseError";
  }
}

export class AfmValidationError extends Error {
  readonly field: string;

  constructor(message: string, field: string) {
    super(field ? `${message} (at '${field}')` : message);
    this.name = "AfmValidationError";
    this.field = field;
  }
}

export class VariableResolutionError extends Error {
  readonly reference: string;

  constructor(reference: string, reason: string) {
    super(`Could not resolve variable '${reference}': ${reason}`);
    this.name = "VariableResolutionError";
    this.reference = reference;
  }
}

const MAX_UNWRAP_DEPTH = 4;

function describe(error: unknown, depth: number): string {
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error !== "object" || error === null) return String(error);

  const { message, error: nested, code, type } = error as Record<string, unknown>;
  if (typeof message === "string" && message !== "") return message;
  if (nested !== undefined && nested !== error && depth < MAX_UNWRAP_DEPTH) {
    const inner = describe(nested, depth + 1);
    if (inner !== "" && inner !== "[object Object]") return inner;
  }
  if (typeof code === "string" && code !== "") return typeof type === "string" && type !== "" && type !== "error" ? `${code} (${type})` : code;
  try {
    const json = JSON.stringify(error);
    if (json !== undefined && json !== "{}") return json;
  } catch {
    return String(error);
  }
  return String(error);
}

export function describeError(error: unknown): string {
  return describe(error, 0);
}
