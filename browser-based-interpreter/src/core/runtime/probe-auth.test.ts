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
import { resolveProbeAuth, probeToolUses } from "./probe-auth";
import type { AgentMetadata, Env } from "@afm/engine";
import { MissingCredentialError } from "../chat/failure";

const env = (values: Record<string, string>): Env => values;

const server = (authentication: Record<string, unknown>): AgentMetadata["tools"] =>
  ({
    mcp: [{ name: "huggingface", transport: { type: "http", url: "https://huggingface.co/mcp", authentication } }],
  }) as AgentMetadata["tools"];

const authOf = (tools: AgentMetadata["tools"]) => {
  const transport = tools?.mcp?.[0]?.transport;
  return transport?.type === "http" ? transport.authentication : undefined;
};

describe("resolveProbeAuth", () => {
  it("replaces a reference with the value behind it", () => {
    const out = resolveProbeAuth(server({ type: "bearer", token: "${env:HF_TOKEN}" }), env({ HF_TOKEN: "hf_the_real_token" }));
    expect(authOf(out)).toEqual({ type: "bearer", token: "hf_the_real_token" });
  });

  it("leaves a literal credential exactly as typed", () => {
    const out = resolveProbeAuth(server({ type: "bearer", token: "typed-in-by-hand" }), env({}));
    expect(authOf(out)).toEqual({ type: "bearer", token: "typed-in-by-hand" });
  });

  it("refuses to connect when nothing can answer for a reference", () => {
    expect(() => resolveProbeAuth(server({ type: "bearer", token: "${env:HF_TOKEN}" }), env({}))).toThrow(MissingCredentialError);
  });

  it("resolves every referenced field, not just the first", () => {
    const out = resolveProbeAuth(server({ type: "api-key", api_key: "${env:K}", header_name: "${env:H}" }), env({ K: "secret", H: "X-Mine" }));
    expect(authOf(out)).toEqual({ type: "api-key", api_key: "secret", header_name: "X-Mine" });
  });

  it("does not touch non-string fields such as scopes", () => {
    const out = resolveProbeAuth(server({ type: "oauth2", client_id: "${env:ID}", scopes: ["mcp", "read"] }), env({ ID: "client-1" }));
    expect(authOf(out)).toMatchObject({ client_id: "client-1", scopes: ["mcp", "read"] });
  });

  it("changes nothing when a server declares no auth", () => {
    const plain = { mcp: [{ name: "open", transport: { type: "http", url: "https://open/mcp" } }] } as AgentMetadata["tools"];
    expect(resolveProbeAuth(plain, env({ HF_TOKEN: "x" }))).toEqual(plain);
  });

  it("passes a server list of none straight back", () => {
    expect(resolveProbeAuth(undefined, env({}))).toBeUndefined();
  });
});

describe("probeToolUses", () => {
  it("reads the name and address from the server being probed, not any other server", () => {
    const uses = probeToolUses(server({ type: "bearer", token: "${env:GITHUB_TOKEN}" }));
    expect(uses).toEqual([{ name: "GITHUB_TOKEN", address: "https://huggingface.co/mcp" }]);
  });

  it("changes address when the probed server's own address changes", () => {
    const edited = {
      mcp: [
        {
          name: "gh",
          transport: {
            type: "http",
            url: "https://api.githubcopilott.com/mcp",
            authentication: { type: "bearer", token: "${env:GITHUB_TOKEN}" },
          },
        },
      ],
    } as AgentMetadata["tools"];
    expect(probeToolUses(edited)).toEqual([{ name: "GITHUB_TOKEN", address: "https://api.githubcopilott.com/mcp" }]);
  });

  it("finds every reference across every field, not just one", () => {
    const uses = probeToolUses(server({ type: "api-key", api_key: "${env:K}", header_name: "${env:H}" }));
    expect(uses).toEqual([
      { name: "K", address: "https://huggingface.co/mcp" },
      { name: "H", address: "https://huggingface.co/mcp" },
    ]);
  });

  it("is empty for a server with no auth, or none at all", () => {
    const plain = {
      mcp: [{ name: "open", transport: { type: "http", url: "https://open/mcp" } }],
    } as AgentMetadata["tools"];
    expect(probeToolUses(plain)).toEqual([]);
    expect(probeToolUses(undefined)).toEqual([]);
  });

  it("ignores fields that are not a bare secret reference", () => {
    const uses = probeToolUses(server({ type: "oauth2", client_id: "${env:ID}", scopes: ["mcp"] }));
    expect(uses).toEqual([{ name: "ID", address: "https://huggingface.co/mcp" }]);
  });
});
