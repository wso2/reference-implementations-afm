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
import { authorizationCodeRefreshKey } from "../../core/oauth/session";
import { type ServerMessage } from "../../core/runtime/protocol";
import { createWorkerSecretStore } from "../../core/secrets/worker-secret-store";
import {
  authBlockFor,
  directoryValues,
  discoveredValues,
  isSignedIn,
  probeKey,
  providerFor,
  savedServer,
  seedValues,
  signInNeed,
  signInQuestion,
  toolsProbedFor,
  toolsShown,
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

describe("signInQuestion", () => {
  it("names the login site and the server so the person sees where the window goes", () => {
    const question = signInQuestion({
      authorizeUrl: "https://login.example.com/oauth/authorize?x=1",
      tokenUrl: "https://login.example.com/token",
      clientId: "client",
      scopes: [],
      resource: "https://tools.example.org/mcp",
    });
    expect(question.title).toBe("Open the sign-in window?");
    expect(question.text).toContain("login.example.com");
    expect(question.text).toContain("tools.example.org");
    expect(question.text).not.toContain("/oauth/authorize");
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

describe("isSignedIn, from the worker's key store to the screen", () => {
  const values = { authorize_url: "https://a/authorize", token_url: "https://a/token", client_id: "id" };
  const provider = providerFor(values, ["read", "write"], "https://mcp.example/mcp");
  const nothing = { found: null, error: null };

  // The page is told which sign-ins the worker holds by name, never by value: this follows that message end to end.
  function namesAfterSignIn(): string[] {
    const messages: ServerMessage[] = [];
    const store = createWorkerSecretStore((message) => void messages.push(message));
    store.refreshStore.set(authorizationCodeRefreshKey(provider), "refresh-token");
    const list = messages.findLast((message) => message.type === "secrets-list");
    return list?.type === "secrets-list" ? list.names : [];
  }

  it("is true as soon as the worker has saved the sign-in, before the tools have been listed", () => {
    expect(isSignedIn("oauth2", provider, namesAfterSignIn(), nothing)).toBe(true);
  });

  it("is false before a sign-in, and for a sign-in with other scopes", () => {
    expect(isSignedIn("oauth2", provider, [], nothing)).toBe(false);
    const other = providerFor(values, ["read"], "https://mcp.example/mcp");
    expect(isSignedIn("oauth2", other, namesAfterSignIn(), nothing)).toBe(false);
  });

  it("is also true when the server just listed its tools, and false when it refused", () => {
    expect(isSignedIn("oauth2", provider, [], { found: [], error: null })).toBe(true);
    expect(isSignedIn("oauth2", provider, [], { found: [], error: new Error("401") })).toBe(false);
  });

  it("is never true for a server that does not use a provider sign-in", () => {
    expect(isSignedIn("bearer", provider, namesAfterSignIn(), { found: [], error: null })).toBe(false);
  });
});

describe("a tool list belongs to the address and sign-in method it was listed for", () => {
  const tools = [{ name: "search" }];
  const probed = { key: probeKey("none", "https://a.example/mcp"), tools };

  it("is shown for the same address and method, whatever spaces were typed around it", () => {
    expect(toolsProbedFor(probed, probeKey("none", " https://a.example/mcp "))).toBe(tools);
  });

  it("is not shown for another address", () => {
    expect(toolsProbedFor(probed, probeKey("none", "https://b.example/mcp"))).toBeNull();
  });

  it("is not shown for another sign-in method, so it cannot pass as a sign-in", () => {
    const method = probeKey("oauth2", "https://a.example/mcp");
    expect(toolsProbedFor(probed, method)).toBeNull();
    const provider = { authorizeUrl: "https://a.example/a", tokenUrl: "https://a.example/t", clientId: "c", scopes: [], resource: "https://a.example/mcp" };
    const answered = { found: toolsProbedFor(probed, method), error: null };
    expect(isSignedIn("oauth2", provider, [], answered)).toBe(false);
  });

  it("is not shown when nothing was listed yet", () => {
    expect(toolsProbedFor(null, probeKey("none", "https://a.example/mcp"))).toBeNull();
  });
});

describe("a tool list also belongs to the settings of its sign-in", () => {
  const oauth = (clientId: string, secret = "s") => ({
    type: "oauth2",
    fields: { authorize_url: "https://a.example/a", token_url: "https://a.example/t", client_id: clientId, client_secret: secret },
    scopes: ["read"],
  });

  it("is the same for the same settings", () => {
    expect(probeKey("oauth2", "https://a.example/mcp", oauth("c1"))).toBe(probeKey("oauth2", " https://a.example/mcp ", oauth("c1")));
  });

  it("changes with a client id, an address of the sign-in or the scopes", () => {
    const base = probeKey("oauth2", "https://a.example/mcp", oauth("c1"));
    expect(probeKey("oauth2", "https://a.example/mcp", oauth("c2"))).not.toBe(base);
    expect(probeKey("oauth2", "https://a.example/mcp", { ...oauth("c1"), scopes: ["write"] })).not.toBe(base);
    const moved = oauth("c1");
    moved.fields.token_url = "https://other.example/t";
    expect(probeKey("oauth2", "https://a.example/mcp", moved)).not.toBe(base);
  });

  it("never holds a secret, and does not change when a secret is typed", () => {
    const key = probeKey("oauth2", "https://a.example/mcp", oauth("c1", "s3cret-value"));
    expect(key).not.toContain("s3cret-value");
    expect(probeKey("oauth2", "https://a.example/mcp", oauth("c1", "another"))).toBe(key);
    const bearer = probeKey("bearer", "https://a.example/mcp", { type: "bearer", fields: { token: "tok-12345" } });
    expect(bearer).not.toContain("tok-12345");
  });
});

describe("the tools shown for a server", () => {
  it("are a found list, over anything the file lists", () => {
    expect(toolsShown(false, [{ name: "new" }], ["old"])).toEqual([{ name: "new" }]);
    expect(toolsShown(true, [{ name: "new" }], ["old"])).toEqual([{ name: "new" }]);
  });

  it("are the tools the file lists for a server that is already listed, until it is checked", () => {
    expect(toolsShown(false, null, ["a", "b"])).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("are nothing yet for a server that was not listed or has a new address", () => {
    expect(toolsShown(true, null, ["a"])).toBeNull();
  });
});
