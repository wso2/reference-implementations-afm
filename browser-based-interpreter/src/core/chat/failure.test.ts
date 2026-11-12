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

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  brief,
  briefMessage,
  failureFromStatus,
  failureOf,
  logDetails,
  maskKeys,
  MissingCredentialError,
  RequestTimeoutError,
  SignInRequiredError,
} from "./failure";

const withCode = (code: number, message = "boom") => Object.assign(new Error(message), { code });

describe("failureOf", () => {
  it("tells a refused credential from a slow server", () => {
    expect(failureOf(withCode(401)).kind).toBe("rejected");
    expect(failureOf(withCode(403)).kind).toBe("rejected");
    expect(failureOf(withCode(-32001, "Request timed out")).kind).toBe("slow");
  });

  it("calls a busy or unreachable server by what it is", () => {
    expect(failureOf(withCode(429)).kind).toBe("busy");
    expect(failureOf(withCode(529)).kind).toBe("busy");
    expect(failureOf(withCode(502)).kind).toBe("unreachable");
  });

  it("tells a server that answers with a redirect from one that cannot be reached", () => {
    const refusal =
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"The target answered with a redirect, which is not followed for a request with a body or credentials"}';
    expect(failureOf(withCode(502, refusal))).toEqual({ kind: "redirected", message: refusal });
    expect(failureOf(withCode(502, 'Error POSTing to endpoint: {"error":"Upstream request failed"}')).kind).toBe(
      "unreachable",
    );
    expect(failureOf(withCode(401, refusal)).kind).toBe("rejected");
  });

  it("reads the status of an error that wraps another", () => {
    expect(failureOf(Object.assign(new Error("wrapped"), { cause: withCode(401) })).kind).toBe("rejected");
  });

  it("knows a missing credential and a missing sign-in", () => {
    expect(failureOf(new MissingCredentialError("TOKEN")).kind).toBe("missing");
    expect(failureOf(new SignInRequiredError()).kind).toBe("signin");
  });

  it("reads a request that never arrived as unreachable", () => {
    expect(failureOf(new TypeError("Failed to fetch")).kind).toBe("unreachable");
  });

  it("keeps anything else as other, with its own words", () => {
    expect(failureOf(new TypeError("x is not a function"))).toEqual({ kind: "other", message: "x is not a function" });
    expect(failureOf(new Error("odd"))).toEqual({ kind: "other", message: "odd" });
  });
});

describe("the status a model provider answered with", () => {
  const apiError = (statusCode: number) => Object.assign(new Error("provider said no"), { statusCode });

  it("is read from statusCode, where the AI SDK puts it", () => {
    expect(failureOf(apiError(401)).kind).toBe("rejected");
    expect(failureOf(apiError(429)).kind).toBe("busy");
    expect(failureOf(apiError(404)).kind).toBe("other");
  });

  it("is found inside a retry error, where the last attempt's error is kept", () => {
    expect(failureOf(Object.assign(new Error("Failed after 5 attempts"), { lastError: apiError(503) })).kind).toBe("busy");
  });

  it("is found under a cause", () => {
    expect(failureOf(new Error("wrapped", { cause: apiError(403) })).kind).toBe("rejected");
  });

  it("says slow for a request that was given up on", () => {
    expect(failureOf(new RequestTimeoutError()).kind).toBe("slow");
    expect(new RequestTimeoutError().message).toBe("The server did not answer in time.");
  });
});

describe("failureFromStatus", () => {
  it("treats no status as unreachable and an unknown one as other", () => {
    expect(failureFromStatus(null)).toBe("unreachable");
    expect(failureFromStatus(418)).toBe("other");
  });
});

const PROXY =
  "No MCP proxy is configured. AFM does not connect to external servers directly from the browser - set an MCP proxy (VITE_MCP_PROXY_URL) before connecting tools.";

describe("briefMessage", () => {
  it("hides a key in a short message that no rule recognises", () => {
    expect(briefMessage("oops sk-abcdefghijklmnop1234")).toBe("oops [hidden]");
  });

  it("turns the long proxy message into MCP error", () => {
    expect(briefMessage(PROXY)).toBe("MCP error");
  });

  it("names a rejected key", () => {
    expect(
      briefMessage(
        "401 Incorrect API key provided: sk-abc. You can find your API key at https://platform.openai.com/account",
      ),
    ).toBe("Key not accepted");
  });

  it("names a network failure, a slow answer and a busy server", () => {
    expect(briefMessage("TypeError: Failed to fetch")).toBe("Can't be reached");
    expect(briefMessage("The request timed out after 30000ms while waiting for the server to answer")).toBe(
      "Took too long",
    );
    expect(briefMessage("429 Too many requests, slow down and retry after a while please")).toBe("Busy right now");
  });

  it("keeps a message that is already short", () => {
    expect(briefMessage("Allow pop-ups to sign in.")).toBe("Allow pop-ups to sign in.");
    expect(briefMessage("The sign-in response did not come from the expected provider - please sign in again.")).toBe("Sign-in failed");
    expect(briefMessage("Failed to fetch")).toBe("Can't be reached");
  });

  it("replaces anything else that is long", () => {
    expect(
      briefMessage("Unexpected token < in JSON at position 0 while parsing the response body from the model provider"),
    ).toBe("Something went wrong");
  });
});

describe("what reaches the console", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs the full text once when it is shortened", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const text = `${PROXY} (once)`;
    brief(text);
    brief(text);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(text);
  });

  it("does not log a message that is shown as it is", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    brief("Nothing came back.");
    expect(spy).not.toHaveBeenCalled();
  });

  it("logs details for a label that is already short", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logDetails("detail only for the console");
    logDetails("detail only for the console");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("maskKeys", () => {
  it.each([
    ["Incorrect API key provided: sk-proj-abcdefghijklmnop1234.", "Incorrect API key provided: [hidden]."],
    ["invalid x-api-key sk-ant-api03-AbC_dEf-1234567890", "invalid x-api-key [hidden]"],
    ["Authorization: Bearer abc.def.ghi-1234567890", "Authorization: Bearer [hidden]"],
    ["Basic dXNlcjpwYXNzd29yZA== was refused", "Basic [hidden] was refused"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789 revoked", "token [hidden] revoked"],
    ["slack xoxb-1234567890-abcdefghij failed", "slack [hidden] failed"],
    ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456", "jwt [hidden]"],
    ['{"access_token":"abcdef0123456789abcdef","scope":"read"}', '{"access_token":"[hidden]","scope":"read"}'],
    ["https://x.example/cb?api_key=0123456789abcdef&q=1", "https://x.example/cb?api_key=[hidden]&q=1"],
  ])("hides the key-like part of %j", (text, expected) => {
    expect(maskKeys(text)).toBe(expected);
  });

  it.each([
    "Failed to fetch",
    "The provider answered 429.",
    "Request timed out after 30 seconds",
    "token: expired",
    "request 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed",
    "https://api.example.com/v1/search?q=hello",
    "Nothing has been entered for 'OPENAI_API_KEY'.",
  ])("leaves ordinary text unchanged: %j", (text) => {
    expect(maskKeys(text)).toBe(text);
  });

  it("stays fast on a very long message built to slow a pattern down", () => {
    const hostile = `${"api_key ".repeat(100_000)}${"sk-".repeat(100_000)}${"a".repeat(1_000_000)}${"Bearer ".repeat(100_000)}`;
    const started = performance.now();
    maskKeys(hostile);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("is what the console receives", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logDetails("the server echoed sk-test-0123456789abcdef");
    expect(spy).toHaveBeenCalledWith("the server echoed [hidden]");
    spy.mockRestore();
  });
});
