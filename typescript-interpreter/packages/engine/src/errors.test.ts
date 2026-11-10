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
import { describeError } from "./errors";

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
