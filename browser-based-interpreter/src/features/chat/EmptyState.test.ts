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

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotReadyReason, rejectedKey } from "./EmptyState";

describe("rejectedKey", () => {
  it.each([
    "Incorrect API key provided: sk-abc",
    "invalid x-api-key",
    "No API key was provided for the model.",
    "The invalid_key error came back",
  ])("offers to replace the key for %j", (reason) => {
    expect(rejectedKey(reason)).toBe(true);
  });

  it.each([
    "Couldn't reach the agent's tools - Error POSTing to endpoint (HTTP 401)",
    "Unauthorized",
    "The server answered 403",
    "Connection timed out",
  ])("does not treat %j as a problem with the model's key", (reason) => {
    expect(rejectedKey(reason)).toBe(false);
  });

  it("has nothing to say when there is no failure", () => {
    expect(rejectedKey(null)).toBe(false);
  });
});

describe("NotReadyReason", () => {
  const html = (notReady: string | null, onReplaceKey?: () => void) =>
    renderToStaticMarkup(createElement(NotReadyReason, { notReady, onRetry: () => {}, onReplaceKey }));

  it("says why the agent did not start, and offers to try again", () => {
    const out = html("Could not resolve variable '${env:OPENAI_API_KEY}'");
    expect(out).toContain("not-ready-reason");
    expect(out).toContain("Key not accepted");
    expect(out).toContain("Try again");
  });

  it("keeps the long technical text off the screen", () => {
    const out = html(
      "No MCP proxy is configured. AFM does not connect to external servers directly from the browser - set an MCP proxy (VITE_MCP_PROXY_URL) before connecting tools.",
    );
    expect(out).toContain("MCP error");
    expect(out).not.toContain("VITE_MCP_PROXY_URL");
  });

  it("falls back to a plain sentence when no reason came with the failure", () => {
    expect(html(null)).toContain("Something went wrong while starting the agent.");
  });

  it("offers to replace a key the provider refused, when it can", () => {
    expect(html("Incorrect API key provided", () => {})).toContain("Replace key");
    expect(html("Incorrect API key provided")).not.toContain("Replace key");
  });

  it("does not offer a new key for a failure that is not about one", () => {
    expect(html("Unsupported model provider gemini. Use openai or anthropic.", () => {})).not.toContain("Replace key");
  });
});
