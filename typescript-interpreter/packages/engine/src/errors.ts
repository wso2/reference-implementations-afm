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

import { asRecord, stringField, type UnknownRecord } from "./types";

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

function describeRaw(error: unknown): string {
  try {
    const json = JSON.stringify(error);
    if (json !== undefined && json !== "{}") return json;
  } catch {
    return String(error);
  }
  return String(error);
}

function* errorChain(error: unknown): Generator<UnknownRecord> {
  let current = error;
  for (let depth = 0; depth <= MAX_UNWRAP_DEPTH; depth++) {
    const record = asRecord(current);
    if (record === null) return;
    yield record;
    const nested = record["error"];
    if (nested === undefined || nested === current) return;
    current = nested;
  }
}

function describeNested(record: UnknownRecord, error: unknown, depth: number): string | undefined {
  const nested = record["error"];
  if (depth >= MAX_UNWRAP_DEPTH || nested === undefined || nested === error) return undefined;
  const described = describe(nested, depth + 1);
  return described !== "" && described !== "[object Object]" ? described : undefined;
}

function describeCode(record: UnknownRecord): string | undefined {
  const code = stringField(record, "code");
  const kind = stringField(record, "type");
  if (code === "") return undefined;
  return kind !== "" && kind !== "error" ? `${code} (${kind})` : code;
}

function describe(error: unknown, depth: number): string {
  if (typeof error === "string") return error;
  if (error instanceof Error && error.message !== "") return error.message;

  const record = asRecord(error);
  if (record === null) return String(error);

  const message = stringField(record, "message");
  if (message !== "") return message;

  return describeNested(record, error, depth) ?? describeCode(record) ?? describeRaw(error);
}

export function describeError(error: unknown): string {
  return describe(error, 0);
}

export const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000, 30_000];

export const MAX_SERVER_RETRY_DELAY_MS = 60_000;

const RATE_LIMIT_CODES: readonly string[] = ["rate_limit_exceeded", "rate_limited"];

export function isRateLimited(error: unknown): boolean {
  for (const record of errorChain(error)) {
    if (record["statusCode"] === 429 || record["status"] === 429) return true;
    if (RATE_LIMIT_CODES.includes(stringField(record, "code")) || stringField(record, "type") === "rate_limit_error") return true;
    if (/\brate.?limit/i.test(stringField(record, "message"))) return true;
  }
  return false;
}

function parseRetryAfter(header: string): number | undefined {
  if (header === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function retryAfterHeaderMs(record: UnknownRecord): number | undefined {
  const headers = asRecord(record["responseHeaders"]) ?? asRecord(record["headers"]);
  return headers === null ? undefined : parseRetryAfter(stringField(headers, "retry-after"));
}

function retryAfterMessageMs(record: UnknownRecord): number | undefined {
  const match = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(stringField(record, "message"));
  const amount = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  return match?.[2]?.toLowerCase() === "ms" ? amount : amount * 1000;
}

export function retryAfterMs(error: unknown): number | undefined {
  for (const record of errorChain(error)) {
    const delay = retryAfterHeaderMs(record) ?? retryAfterMessageMs(record);
    if (delay !== undefined) return delay;
  }
  return undefined;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
