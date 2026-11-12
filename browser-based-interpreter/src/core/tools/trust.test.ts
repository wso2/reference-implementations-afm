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
import {
  keepConfirmed,
  toolsOfServer,
  trustKeyFor,
  withTrusted,
  allowedKeys,
  listedToolKey,
  permissionKey,
} from "./trust";
import type { AgentMetadata } from "@afm/engine";
import { namespacedToolName } from "./tool-names";

describe("permissionKey", () => {
  it("keeps the same tool name on different servers apart", () => {
    const good = permissionKey("https://good.example/mcp", "search");
    const evil = permissionKey("https://attacker.example/mcp", "search");
    expect(good).not.toBe(evil);
  });

  it("is stable for the same server and tool", () => {
    expect(permissionKey("https://a/mcp", "x")).toBe(permissionKey("https://a/mcp", "x"));
  });

  it("keys in-page tools under 'local'", () => {
    expect(permissionKey(undefined, "read_file")).toBe("local::read_file");
  });

  it("does not let a server-scoped grant satisfy an in-page tool of the same name", () => {
    expect(permissionKey("https://a/mcp", "read_file")).not.toBe(permissionKey(undefined, "read_file"));
  });
});

const A = "https://a.example.com/mcp";
const B = "https://b.example.com/mcp";

const agent = (servers: unknown[]) => ({ name: "A", tools: { mcp: servers } }) as AgentMetadata;
const http = (name: string, url: string, allow?: string[]) => ({
  name,
  transport: { type: "http", url },
  ...(allow === undefined ? {} : { tool_filter: { allow } }),
});

describe("listedToolKey", () => {
  it("cannot be confused across servers when an address has the separator in it", () => {
    expect(listedToolKey(A, "x::y")).not.toBe(listedToolKey(`${A}::x`, "y"));
  });
});

describe("keepConfirmed", () => {
  const metadata = agent([http("a", A, ["x", "y"]), http("b", B, ["z"])]);

  it("keeps what the person confirmed for tools that are still listed", () => {
    const confirmed = [listedToolKey(A, "x"), listedToolKey(B, "z")];
    expect(keepConfirmed(confirmed, metadata)).toEqual(confirmed);
  });

  it("drops what was confirmed for a tool, or a whole server, that is no longer listed", () => {
    const confirmed = [
      listedToolKey(A, "x"),
      listedToolKey(A, "gone"),
      listedToolKey("https://old.example.com/mcp", "x"),
    ];
    expect(keepConfirmed(confirmed, metadata)).toEqual([listedToolKey(A, "x")]);
  });

  it("never confirms a tool that is listed but was not confirmed", () => {
    expect(keepConfirmed([listedToolKey(A, "x")], metadata)).not.toContain(listedToolKey(A, "y"));
    expect(keepConfirmed([], metadata)).toEqual([]);
  });

  it("leaves the list alone when the file cannot be read", () => {
    const confirmed = [listedToolKey(A, "x")];
    expect(keepConfirmed(confirmed, null)).toBe(confirmed);
  });
});

describe("keepConfirmed for a server with no tool list", () => {
  const metadata = agent([http("a", A), http("b", B, ["z"])]);

  it("keeps the tools the person always allowed on it", () => {
    const confirmed = [listedToolKey(A, "x"), listedToolKey(A, "y")];
    expect(keepConfirmed(confirmed, metadata)).toEqual(confirmed);
  });

  it("drops them with the server", () => {
    expect(keepConfirmed([listedToolKey(A, "x")], agent([http("b", B, ["z"])]))).toEqual([]);
  });

  it("drops keys that are not a server and a tool", () => {
    expect(keepConfirmed(["nonsense", "[1,2]"], metadata)).toEqual([]);
  });
});

describe("toolsOfServer", () => {
  it("names the tools of one server only", () => {
    const keys = [listedToolKey(A, "x"), listedToolKey(B, "z"), listedToolKey(A, "y"), "nonsense"];
    expect(toolsOfServer(keys, A)).toEqual(["x", "y"]);
  });

  it("does not match a server whose address starts with this one", () => {
    expect(toolsOfServer([listedToolKey(`${A}::evil`, "x")], A)).toEqual([]);
  });
});

describe("trustKeyFor", () => {
  const listed = agent([http("docs", A, ["search_docs"]), http("plain", B)]);

  it("is the key of the listed tool a call named", () => {
    expect(trustKeyFor(listed, A, "docs__search_docs")).toBe(listedToolKey(A, "search_docs"));
  });

  it("is the shown name on a server whose file lists no tools", () => {
    expect(trustKeyFor(listed, B, "plain__get_me")).toBe(listedToolKey(B, "get_me"));
  });

  it("is nothing for a tool the list does not include, because the engine will not call it", () => {
    expect(trustKeyFor(listed, A, "docs__other")).toBeNull();
  });

  it("is nothing without a server address, for an unknown server or for no file", () => {
    expect(trustKeyFor(listed, undefined, "docs__search_docs")).toBeNull();
    expect(trustKeyFor(listed, "", "docs__search_docs")).toBeNull();
    expect(trustKeyFor(listed, "https://unknown.example.com/mcp", "docs__search_docs")).toBeNull();
    expect(trustKeyFor(null, A, "docs__search_docs")).toBeNull();
  });
});

describe("withTrusted", () => {
  it("adds the key to the tools already confirmed, once", () => {
    const next = withTrusted([listedToolKey(A, "x")], listedToolKey(A, "y"));
    expect(next).toEqual([listedToolKey(A, "x"), listedToolKey(A, "y")]);
    expect(withTrusted(next, listedToolKey(A, "y"))).toEqual(next);
  });

  it("starts from nothing for an agent you wrote, so approving one tool never approves the others the file lists", () => {
    expect(withTrusted(null, listedToolKey(A, "x"))).toEqual([listedToolKey(A, "x")]);
  });
});

describe("allowedKeys", () => {
  const metadata = agent([http("a", A, ["x", "y"])]);

  it("approves nothing when the file only lists tools, because a tool list says what is offered and not what runs unasked", () => {
    expect(allowedKeys(metadata, []).size).toBe(0);
  });

  it("approves only the tools that were confirmed and are still listed", () => {
    const keys = allowedKeys(metadata, [listedToolKey(A, "x"), listedToolKey(A, "gone")]);
    expect([...keys]).toEqual([permissionKey(A, namespacedToolName("a", "x"))]);
  });
});
