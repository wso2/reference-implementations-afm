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
  holdInsertedTools,
  listedToolKey,
  listedTools,
  serverMessageFromLoopEvent,
  permissionKey,
} from "./protocol";
import type { AgentMetadata } from "@afm/engine";
import type { LoopEvent } from "@afm/runtime";

describe("serverMessageFromLoopEvent", () => {
  it("passes a text-delta through", () => {
    expect(serverMessageFromLoopEvent({ type: "text-delta", text: "hi" })).toEqual({
      type: "text-delta",
      text: "hi",
    });
  });

  it("renames finish to turn-finished", () => {
    expect(serverMessageFromLoopEvent({ type: "finish", reason: "stop" })).toEqual({
      type: "turn-finished",
      reason: "stop",
    });
  });

  it("maps a tool-result", () => {
    const event: LoopEvent = { type: "tool-result", id: "c1", name: "t", ok: true, content: "r" };
    expect(serverMessageFromLoopEvent(event)).toEqual({
      type: "tool-result",
      id: "c1",
      name: "t",
      ok: true,
      content: "r",
    });
  });

  it("passes a budget-update through", () => {
    const event: LoopEvent = {
      type: "budget-update",
      totalTokens: 120,
      inputTokens: 80,
      outputTokens: 40,
      maxTokens: 250_000,
      iteration: 1,
      maxIterations: 10,
      elapsedMs: 340,
      maxWallClockMs: 180_000,
    };
    expect(serverMessageFromLoopEvent(event)).toEqual({
      type: "budget-update",
      totalTokens: 120,
      inputTokens: 80,
      outputTokens: 40,
      maxTokens: 250_000,
      iteration: 1,
      maxIterations: 10,
      elapsedMs: 340,
      maxWallClockMs: 180_000,
    });
  });
});

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

describe("listedTools", () => {
  it("names every tool the file lists, by server address and tool", () => {
    expect(listedTools(agent([http("a", A, ["x", "y"]), http("b", B, ["x"])]))).toEqual([
      listedToolKey(A, "x"),
      listedToolKey(A, "y"),
      listedToolKey(B, "x"),
    ]);
  });

  it("is empty for no file, or servers that list no tools", () => {
    expect(listedTools(null)).toEqual([]);
    expect(listedTools(agent([http("a", A)]))).toEqual([]);
  });
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
  const metadata = agent([http("a", A, ["x", "y"])]);

  it("adds the key to the tools already trusted, once", () => {
    const next = withTrusted([listedToolKey(A, "x")], metadata, listedToolKey(A, "y"));
    expect(next).toEqual([listedToolKey(A, "x"), listedToolKey(A, "y")]);
    expect(withTrusted(next, metadata, listedToolKey(A, "y"))).toEqual(next);
  });

  it("starts from every listed tool when the agent was trusted as a whole, so none of them starts asking", () => {
    expect(withTrusted(null, metadata, listedToolKey(B, "z"))).toEqual([
      listedToolKey(A, "x"),
      listedToolKey(A, "y"),
      listedToolKey(B, "z"),
    ]);
  });
});

describe("holdInsertedTools", () => {
  const before = agent([http("a", A, ["x"])]);
  const pasted = "  - name: b\n    tool_filter:\n      allow: [log]";

  it("keeps what was listed before the paste confirmed, so only the tools the paste adds ask first", () => {
    expect(holdInsertedTools(null, before, pasted)).toEqual([listedToolKey(A, "x")]);
  });

  it("confirms nothing when the file could not be read before the paste", () => {
    expect(holdInsertedTools(null, null, pasted)).toEqual([]);
  });

  it("leaves an agent alone when the pasted text lists no tools", () => {
    expect(holdInsertedTools(null, before, "just some words")).toBeNull();
  });

  it("does not change an agent that is already marked as from outside", () => {
    const confirmed = [listedToolKey(B, "y")];
    expect(holdInsertedTools(confirmed, before, pasted)).toBe(confirmed);
    expect(holdInsertedTools([], before, pasted)).toEqual([]);
  });
});
