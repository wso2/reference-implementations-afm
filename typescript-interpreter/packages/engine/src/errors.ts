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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export function describeError(error: unknown, depth = 0): string {
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message !== "") return error.message;

  const record = asRecord(error);
  if (record === null) return String(error);

  const message = stringField(record, "message");
  if (message !== "") return message;

  const nested = record["error"];
  if (depth < MAX_UNWRAP_DEPTH && nested !== undefined && nested !== error) {
    const described = describeError(nested, depth + 1);
    if (described !== "" && described !== "[object Object]") return described;
  }

  const code = stringField(record, "code");
  const kind = stringField(record, "type");
  if (code !== "") return kind !== "" && kind !== "error" ? `${code} (${kind})` : code;

  try {
    const json = JSON.stringify(error);
    if (json !== undefined && json !== "{}") return json;
  } catch {
  }
  return String(error);
}

export function isRateLimited(error: unknown, depth = 0): boolean {
  if (depth > MAX_UNWRAP_DEPTH) return false;

  const record = asRecord(error);
  if (record === null) return false;

  if (record["statusCode"] === 429 || record["status"] === 429) return true;

  const code = stringField(record, "code");
  if (code === "rate_limit_exceeded" || code === "rate_limited") return true;
  if (stringField(record, "type") === "rate_limit_error") return true;

  const nested = record["error"];
  if (nested !== undefined && nested !== error && isRateLimited(nested, depth + 1)) return true;

  return /\brate.?limit/i.test(stringField(record, "message"));
}

export function retryAfterMs(error: unknown, depth = 0): number | undefined {
  if (depth > MAX_UNWRAP_DEPTH) return undefined;

  const record = asRecord(error);
  if (record === null) return undefined;

  const headers = asRecord(record["responseHeaders"]) ?? asRecord(record["headers"]);
  const header = headers === null ? "" : stringField(headers, "retry-after");
  const headerSeconds = header === "" ? Number.NaN : Number(header);
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) return headerSeconds * 1000;

  const match = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(stringField(record, "message"));
  const amount = match === null ? Number.NaN : Number(match[1]);
  if (Number.isFinite(amount)) return match?.[2]?.toLowerCase() === "ms" ? amount : amount * 1000;

  const nested = record["error"];
  if (nested !== undefined && nested !== error) return retryAfterMs(nested, depth + 1);
  return undefined;
}
