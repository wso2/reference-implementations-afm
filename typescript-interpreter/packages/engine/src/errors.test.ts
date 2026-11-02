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

import { describe, expect, it } from "vitest";
import { describeError, isRateLimited, RATE_LIMIT_BACKOFF_MS, retryAfterMs, sleep } from "./errors";

const OPENAI_STREAM_ERROR = {
  type: "error",
  sequence_number: 2,
  error: {
    type: "tokens",
    code: "rate_limit_exceeded",
    message:
      "Rate limit reached for gpt-4o in organization org-abc on tokens per min (TPM): Limit 30000, Used 29500, Requested 2000. Please try again in 3s.",
  },
};

describe("describeError", () => {
  it("never renders an object as '[object Object]'", () => {
    expect(describeError(OPENAI_STREAM_ERROR)).toContain("Rate limit reached");
    expect(describeError(OPENAI_STREAM_ERROR)).not.toBe("[object Object]");
  });

  it("reads the message off a plain provider error", () => {
    expect(describeError({ type: "tokens", code: "rate_limit_exceeded", message: "slow down" })).toBe(
      "slow down",
    );
  });

  it("falls back to the code when there is no prose", () => {
    expect(describeError({ code: "rate_limit_exceeded", type: "tokens" })).toBe(
      "rate_limit_exceeded (tokens)",
    );
  });

  it("keeps working for Errors and strings", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError("boom")).toBe("boom");
  });

  it("survives a self-referencing object instead of overflowing the stack", () => {
    const circular: Record<string, unknown> = { code: "" };
    circular["error"] = circular;
    expect(describeError(circular)).toBe("[object Object]");
  });

  it("serialises an object with no recognisable fields rather than hiding it", () => {
    expect(describeError({ status: 503 })).toBe('{"status":503}');
  });
});

describe("isRateLimited", () => {
  it("recognises the nested OpenAI stream shape", () => {
    expect(isRateLimited(OPENAI_STREAM_ERROR)).toBe(true);
  });

  it("recognises a 429 and Anthropic's own type", () => {
    expect(isRateLimited({ statusCode: 429 })).toBe(true);
    expect(isRateLimited({ type: "rate_limit_error" })).toBe(true);
  });

  it("does not treat unrelated failures as retryable", () => {
    expect(isRateLimited(new Error("invalid api key"))).toBe(false);
    expect(isRateLimited({ code: "context_length_exceeded" })).toBe(false);
    expect(isRateLimited(null)).toBe(false);
  });
});

describe("retryAfterMs", () => {
  it("uses the delay the provider states in its message", () => {
    expect(retryAfterMs(OPENAI_STREAM_ERROR)).toBe(3000);
    expect(retryAfterMs({ message: "Please try again in 1.5s" })).toBe(1500);
    expect(retryAfterMs({ message: "Please try again in 200ms" })).toBe(200);
  });

  it("prefers a Retry-After header when there is one", () => {
    expect(retryAfterMs({ responseHeaders: { "retry-after": "12" } })).toBe(12_000);
  });

  it("returns undefined when the provider says nothing", () => {
    expect(retryAfterMs({ code: "rate_limit_exceeded" })).toBeUndefined();
  });
});

describe("how deep an error is searched", () => {
  const nest = (levels: number, inner: Record<string, unknown>): Record<string, unknown> => {
    let error = inner;
    for (let level = 0; level < levels; level++) error = { error };
    return error;
  };

  it("finds a rate limit up to four levels down and no further", () => {
    expect(isRateLimited(nest(4, { statusCode: 429 }))).toBe(true);
    expect(isRateLimited(nest(5, { statusCode: 429 }))).toBe(false);
  });

  it("finds a stated delay up to four levels down and no further", () => {
    expect(retryAfterMs(nest(4, { message: "try again in 2s" }))).toBe(2000);
    expect(retryAfterMs(nest(5, { message: "try again in 2s" }))).toBeUndefined();
  });

  it("stops at an error that contains itself", () => {
    const circular: Record<string, unknown> = { message: "no limit here" };
    circular["error"] = circular;
    expect(isRateLimited(circular)).toBe(false);
    expect(retryAfterMs(circular)).toBeUndefined();
  });
});

describe("retryAfterMs details", () => {
  it("puts a header ahead of the message at the same level", () => {
    expect(retryAfterMs({ headers: { "retry-after": "2" }, message: "try again in 9s" })).toBe(2000);
  });

  it("reads a header that is an HTTP date, as the time still to wait", () => {
    const wait = retryAfterMs({ headers: { "retry-after": new Date(Date.now() + 30_000).toUTCString() } });
    expect(wait).toBeGreaterThan(28_000);
    expect(wait).toBeLessThanOrEqual(30_000);
  });

  it("does not wait for an HTTP date that has already passed", () => {
    expect(retryAfterMs({ headers: { "retry-after": new Date(Date.now() - 60_000).toUTCString() } })).toBe(0);
  });

  it("ignores a header that is negative or not a number", () => {
    expect(retryAfterMs({ headers: { "retry-after": "-1" } })).toBeUndefined();
    expect(retryAfterMs({ headers: { "retry-after": "soon" } })).toBeUndefined();
    expect(retryAfterMs({ headers: { "retry-after": "Not a date at all" } })).toBeUndefined();
    expect(retryAfterMs({ headers: { "retry-after": 7 } })).toBeUndefined();
  });

  it("takes the outer error's delay before the inner one", () => {
    expect(retryAfterMs({ message: "try again in 1s", error: { message: "try again in 5s" } })).toBe(1000);
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    await expect(sleep(5, new AbortController().signal)).resolves.toBeUndefined();
  });

  it("resolves at once when already aborted, and when aborted while waiting", async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(sleep(60_000, aborted.signal)).resolves.toBeUndefined();

    const later = new AbortController();
    const waiting = sleep(60_000, later.signal);
    later.abort();
    await expect(waiting).resolves.toBeUndefined();
  });
});

describe("the backoff", () => {
  it("waits longer after each rate limit", () => {
    expect(RATE_LIMIT_BACKOFF_MS).toEqual([5_000, 15_000, 30_000]);
  });
});
