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

import { type AgentMetadata } from "@afm/engine";
import { describe, expect, it } from "vitest";
import { AUTH_METHODS } from "../../core/mcp/mcp-servers";
import {
  authBlockFor,
  directoryValues,
  discoveredValues,
  providerFor,
  savedServer,
  seedValues,
  signInNeed,
  waitingNote,
} from "./server-panel-state";

const fieldsOf = (id: string) => AUTH_METHODS.find((method) => method.id === id)!.fields;

describe("authBlockFor", () => {
  it("is nothing when the server needs no sign-in", () => {
    expect(authBlockFor("none", [], {}, {}, [])).toBeUndefined();
  });

  it("trims what was typed and leaves out what is empty", () => {
    const block = authBlockFor("api-key", fieldsOf("api-key"), { header_name: " X-Key ", api_key: "" }, {}, []);
    expect(block).toEqual({ type: "api-key", fields: { header_name: "X-Key" }, scopes: undefined });
  });

  it("takes a freshly typed secret over the value already in the file", () => {
    const block = authBlockFor("bearer", fieldsOf("bearer"), { token: "${env:OLD}" }, { token: "new-token" }, []);
    expect(block?.fields).toEqual({ token: "new-token" });
    expect(authBlockFor("bearer", fieldsOf("bearer"), { token: "${env:OLD}" }, {}, [])?.fields).toEqual({
      token: "${env:OLD}",
    });
  });

  it("marks a sign-in with the authorization code grant and keeps the scopes as a list", () => {
    const block = authBlockFor(
      "oauth2",
      fieldsOf("oauth2"),
      { authorize_url: "https://a/authorize", scopes: "a b" },
      {},
      ["a", "b"],
    );
    expect(block).toMatchObject({ type: "oauth2", scopes: ["a", "b"] });
    expect(block?.fields.grant_type).toBe("authorization_code");
    expect(block?.fields.scopes).toBeUndefined();
  });
});

describe("providerFor", () => {
  it("names the sign-in addresses, the client, the scopes and the server being signed in to", () => {
    const values = { authorize_url: "https://a/authorize", token_url: "https://a/token", client_id: "id" };
    expect(providerFor(values, ["x"], " https://mcp.example/mcp ")).toEqual({
      authorizeUrl: "https://a/authorize",
      tokenUrl: "https://a/token",
      clientId: "id",
      scopes: ["x"],
      resource: "https://mcp.example/mcp",
    });
  });

  it("uses empty text for what is not filled in yet", () => {
    expect(providerFor({}, [], "").clientId).toBe("");
  });
});

describe("the values a sign-in form starts from", () => {
  it("come from what a server announced, scopes joined by spaces", () => {
    expect(
      discoveredValues({
        authorizeUrl: "https://a/authorize",
        tokenUrl: "https://a/token",
        clientId: "",
        scopes: ["a", "b"],
      }),
    ).toEqual({ authorize_url: "https://a/authorize", token_url: "https://a/token", client_id: "", scopes: "a b" });
    expect(discoveredValues({ authorizeUrl: "u", tokenUrl: "t", clientId: "c", scopes: [] })).not.toHaveProperty(
      "scopes",
    );
  });

  it("come from what the server publishes, except that a directory entry's own scopes win", () => {
    const found = { authorizeUrl: "https://a/authorize", tokenUrl: "https://a/token", clientId: "c", scopes: ["all:read", "all:write"] };
    expect(directoryValues(found, { type: "oauth2" })).toMatchObject({ client_id: "c", scopes: "all:read all:write" });
    expect(directoryValues(found, { type: "oauth2", scopes: ["mcp:read"] })).toMatchObject({ scopes: "mcp:read" });
  });

  it("come from the file for a server being edited, without its type and grant", () => {
    expect(
      seedValues({ type: "oauth2", grant_type: "authorization_code", client_id: "id", scopes: ["a", "b"] }),
    ).toEqual({
      client_id: "id",
      scopes: "a b",
    });
    expect(seedValues(undefined)).toEqual({});
  });
});

describe("what the empty tool list says", () => {
  const ask = (
    url: string,
    over: Partial<{
      probing: boolean;
      error: string | null;
      need: "none" | "missing" | "signin";
      unlisted: boolean;
    }> = {},
  ) => waitingNote(url, over.probing ?? false, over.error ?? null, over.need ?? "none", over.unlisted ?? false);

  it("says it is checking while it checks", () => {
    expect(ask("https://a/mcp", { probing: true })).toBe("Checking the address…");
  });

  it("asks for the address first", () => {
    expect(ask("  ")).toBe("Enter the address and its tools are listed here.");
  });

  it("says what is missing before it can list anything", () => {
    expect(ask("https://a/mcp", { need: "missing" })).toContain("needs its credential");
    expect(ask("https://a/mcp", { need: "signin" })).toContain("Sign in above");
  });

  it("says no tools were listed when the check failed", () => {
    expect(ask("https://a/mcp", { error: "no" })).toContain("No tools listed");
  });

  it("says every tool is allowed when the file never listed this server's tools", () => {
    expect(ask("https://a/mcp", { unlisted: true })).toContain("every tool is allowed");
    expect(ask("https://a/mcp")).toBe("Press Check again to list this server's tools.");
  });
});

describe("savedServer", () => {
  const metadata = {
    tools: {
      mcp: [
        {
          name: "docs",
          transport: { type: "http", url: "https://docs.example/mcp", authentication: { type: "bearer" } },
          tool_filter: { allow: ["read"], deny: ["delete"] },
        },
        { name: "local", transport: { type: "stdio", command: "run" } },
      ],
    },
  } as unknown as AgentMetadata;

  it("reads the address, sign-in and tool lists of the server being edited", () => {
    expect(savedServer(metadata, "docs")).toEqual({
      url: "https://docs.example/mcp",
      auth: { type: "bearer" },
      isStdio: false,
      allow: ["read"],
      deny: ["delete"],
    });
  });

  it("knows a command server has no address", () => {
    expect(savedServer(metadata, "local")).toMatchObject({ url: "", isStdio: true, allow: undefined, deny: [] });
  });

  it("is empty when nothing is being edited", () => {
    expect(savedServer(metadata, null)).toEqual({
      url: "",
      auth: undefined,
      isStdio: false,
      allow: undefined,
      deny: [],
    });
  });
});

describe("signInNeed", () => {
  it("asks for the missing credential before anything else", () => {
    expect(signInNeed(true, "oauth2", false)).toBe("missing");
  });

  it("asks for a sign-in only when the method needs one and none is stored", () => {
    expect(signInNeed(false, "oauth2", false)).toBe("signin");
    expect(signInNeed(false, "oauth2", true)).toBe("none");
    expect(signInNeed(false, "bearer", false)).toBe("none");
  });
});
