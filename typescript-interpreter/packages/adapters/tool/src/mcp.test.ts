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

import { describe, it, expect, vi, afterEach } from "vitest";
import { mcpAuthHeaders, McpAuthError, isDynamicAuthType, createDynamicMcpAuthHeaderProvider, mcpToolPort, effectiveUrl, toToolDescriptor, toToolResult } from "./mcp";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

describe("mcpAuthHeaders", () => {
  it("bearer -> Authorization: Bearer <token>", () => {
    expect(mcpAuthHeaders({ type: "bearer", token: "abc" })).toEqual({
      Authorization: "Bearer abc",
    });
  });

  it("basic -> Authorization: Basic base64(user:pass)", () => {
    expect(mcpAuthHeaders({ type: "basic", username: "alice", password: "s3cret" })).toEqual({
      Authorization: `Basic ${btoa("alice:s3cret")}`,
    });
  });

  it("api-key -> default Authorization header with the raw key", () => {
    expect(mcpAuthHeaders({ type: "api-key", api_key: "k-123" })).toEqual({
      Authorization: "k-123",
    });
  });

  it("api-key -> custom header_name", () => {
    expect(mcpAuthHeaders({ type: "api-key", api_key: "k-123", header_name: "X-API-Key" })).toEqual({
      "X-API-Key": "k-123",
    });
  });

  it("matches the type case-insensitively", () => {
    expect(mcpAuthHeaders({ type: "BEARER", token: "abc" })).toEqual({ Authorization: "Bearer abc" });
  });

  it("throws when a required field is missing", () => {
    expect(() => mcpAuthHeaders({ type: "bearer" })).toThrow(McpAuthError);
    expect(() => mcpAuthHeaders({ type: "basic", username: "a" })).toThrow(/username.*password/);
    expect(() => mcpAuthHeaders({ type: "api-key" })).toThrow(/api_key/);
  });

  it("points oauth2 at the dynamic provider instead of computing a static header", () => {
    expect(() => mcpAuthHeaders({ type: "oauth2" })).toThrow(/createDynamicMcpAuthHeaderProvider/);
  });

  it("rejects an unknown type, and a jwt block - a browser does not sign tokens", () => {
    expect(() => mcpAuthHeaders({ type: "magic" })).toThrow(/Unsupported authentication type/);
    expect(() => mcpAuthHeaders({ type: "jwt" })).toThrow(/Unsupported authentication type: 'jwt'/);
  });
});

describe("isDynamicAuthType", () => {
  it("is true only for oauth2", () => {
    expect(isDynamicAuthType({ type: "oauth2" })).toBe(true);
    expect(isDynamicAuthType({ type: "OAuth2" })).toBe(true);
    expect(isDynamicAuthType({ type: "bearer" })).toBe(false);
    expect(isDynamicAuthType({ type: "basic" })).toBe(false);
    expect(isDynamicAuthType({ type: "api-key" })).toBe(false);
    expect(isDynamicAuthType({ type: "jwt" })).toBe(false);
  });
});

describe("createDynamicMcpAuthHeaderProvider", () => {
  it("oauth2 client_credentials: fetches and caches a token across calls", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ access_token: `tok-${calls}`, expires_in: 3600 }) } as Response;
    }) as unknown as typeof fetch;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      const provider = createDynamicMcpAuthHeaderProvider({
        type: "oauth2",
        grant_type: "client_credentials",
        token_url: "https://auth.example.com/token",
        client_id: "id",
        client_secret: "secret",
      });
      const first = await provider();
      const second = await provider();
      expect(first).toEqual({ Authorization: "Bearer tok-1" });
      expect(second).toEqual({ Authorization: "Bearer tok-1" });
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("oauth2 authorization_code: delegates to the injected interactive token getter", async () => {
    const getInteractiveToken = vi.fn(async () => "interactive-token");
    const provider = createDynamicMcpAuthHeaderProvider(
      { type: "oauth2", grant_type: "authorization_code", authorize_url: "https://a", token_url: "https://t", client_id: "c" },
      { getInteractiveToken },
    );
    expect(await provider()).toEqual({ Authorization: "Bearer interactive-token" });
    expect(getInteractiveToken).toHaveBeenCalledOnce();
  });

  it("oauth2 authorization_code: throws clearly when no interactive token getter was supplied", () => {
    expect(() =>
      createDynamicMcpAuthHeaderProvider({ type: "oauth2", grant_type: "authorization_code", authorize_url: "https://a", token_url: "https://t", client_id: "c" }),
    ).toThrow(/interactive sign-in/);
  });

  it("oauth2: throws when grant_type is missing or unsupported", () => {
    expect(() => createDynamicMcpAuthHeaderProvider({ type: "oauth2" })).toThrow(/requires a 'grant_type'/);
    expect(() => createDynamicMcpAuthHeaderProvider({ type: "oauth2", grant_type: "implicit" })).toThrow(/Unsupported oauth2 grant_type/);
  });

  it("throws for a non-dynamic type", () => {
    expect(() => createDynamicMcpAuthHeaderProvider({ type: "bearer", token: "t" })).toThrow(/not a dynamic auth type/);
    expect(() => createDynamicMcpAuthHeaderProvider({ type: "jwt", issuer: "i", signing_key: "s" })).toThrow(/not a dynamic auth type/);
  });
});

interface TestServer {
  url: string;
  lastSeenHeader: string | undefined;
  received: string[];
  forgetSessions: () => void;
  close: () => Promise<void>;
}

function startTestMcpServer(requiredHeader?: { name: string; value: string }): Promise<TestServer> {
  const state: { lastSeenHeader: string | undefined } = { lastSeenHeader: undefined };
  const received: string[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();

  function buildMcpServer(): McpServer {
    const server = new McpServer({ name: "test-server", version: "0.0.0" });
    server.registerTool(
      "whoami",
      { title: "Whoami", description: "Echoes the auth header this server received." },
      async () => ({ content: [{ type: "text" as const, text: state.lastSeenHeader ?? "none" }] }),
    );
    return server;
  }

  const httpServer: Server = createServer((req, res) => {
    void (async () => {
      const headerName = requiredHeader?.name.toLowerCase() ?? "authorization";
      const seen = req.headers[headerName];
      state.lastSeenHeader = typeof seen === "string" ? seen : undefined;

      if (requiredHeader !== undefined && state.lastSeenHeader !== requiredHeader.value) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body: unknown = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;

      received.push(String((body as { method?: unknown } | undefined)?.method));
      const sessionId = req.headers["mcp-session-id"];
      let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;

      if (transport === undefined && isInitializeRequest(body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport as StreamableHTTPServerTransport);
          },
        });
        await buildMcpServer().connect(transport);
      }

      if (transport === undefined) {
        res.writeHead(typeof sessionId === "string" ? 404 : 400).end("No valid session");
        return;
      }
      await transport.handleRequest(req, res, body);
    })();
  });

  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        get lastSeenHeader() {
          return state.lastSeenHeader;
        },
        received,
        forgetSessions: () => transports.clear(),
        close: () =>
          new Promise((res) => {
            httpServer.close(() => res());
            httpServer.closeAllConnections();
          }),
      });
    });
  });
}

describe("mcpToolPort — real auth headers through a real MCP handshake", () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("sends a configured bearer token, and the server receives exactly it", async () => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer secret-token" });
    const port = mcpToolPort({
      serverUrl: server.url,
      headers: mcpAuthHeaders({ type: "bearer", token: "secret-token" }),
    });

    const tools = await port.list();
    expect(tools.map((t) => t.name)).toContain("whoami");

    const result = await port.execute({ id: "1", name: "whoami", args: {} }, new AbortController().signal);
    expect(result).toEqual({ ok: true, content: "Bearer secret-token" });
  });

  it("starts a new session for listing when the server has forgotten the old one, instead of failing from then on", async () => {
    server = await startTestMcpServer();
    const port = mcpToolPort({ serverUrl: server.url });
    await port.list();

    server.forgetSessions();

    expect((await port.list()).map((t) => t.name)).toContain("whoami");
    expect(server.received.filter((method) => method === "initialize")).toHaveLength(2);
    await port.dispose?.();
  });

  it("does not repeat a tool call when the server has forgotten the session, and starts a new session for the next call", async () => {
    server = await startTestMcpServer();
    const port = mcpToolPort({ serverUrl: server.url });
    await port.list();

    server.forgetSessions();

    await expect(port.execute({ id: "1", name: "whoami", args: {} }, new AbortController().signal)).rejects.toThrow(
      /session had ended.*not repeated/,
    );
    expect(server.received.filter((method) => method === "tools/call")).toHaveLength(1);

    const next = await port.execute({ id: "2", name: "whoami", args: {} }, new AbortController().signal);
    expect(next.ok).toBe(true);
    expect(server.received.filter((method) => method === "initialize")).toHaveLength(2);
    await port.dispose?.();
  });

  it("fails to connect when the required bearer token is missing", async () => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer secret-token" });
    const port = mcpToolPort({ serverUrl: server.url });

    await expect(port.list()).rejects.toBeTruthy();
  });

  it("fails to connect when the bearer token is wrong", async () => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer secret-token" });
    const port = mcpToolPort({
      serverUrl: server.url,
      headers: mcpAuthHeaders({ type: "bearer", token: "wrong-token" }),
    });

    await expect(port.list()).rejects.toBeTruthy();
  });

  it("sends basic auth as a correctly base64-encoded Authorization header", async () => {
    const expected = `Basic ${Buffer.from("alice:hunter2").toString("base64")}`;
    server = await startTestMcpServer({ name: "authorization", value: expected });
    const port = mcpToolPort({
      serverUrl: server.url,
      headers: mcpAuthHeaders({ type: "basic", username: "alice", password: "hunter2" }),
    });

    const result = await port.execute({ id: "1", name: "whoami", args: {} }, new AbortController().signal);
    expect(result).toEqual({ ok: true, content: expected });
  });

  it("sends api-key auth on a custom header name (not just Authorization)", async () => {
    server = await startTestMcpServer({ name: "x-api-key", value: "k-123" });
    const port = mcpToolPort({
      serverUrl: server.url,
      headers: mcpAuthHeaders({ type: "api-key", api_key: "k-123", header_name: "X-Api-Key" }),
    });

    const result = await port.execute({ id: "1", name: "whoami", args: {} }, new AbortController().signal);
    expect(result).toEqual({ ok: true, content: "k-123" });
  });

  it("connects fine with no auth at all when the server requires none", async () => {
    server = await startTestMcpServer();
    const port = mcpToolPort({ serverUrl: server.url });

    const tools = await port.list();
    expect(tools.map((t) => t.name)).toContain("whoami");
  });

  it("calls onAuthRejected when the server rejects a dynamic-auth token with 401, so a revoked/stale cached token can be evicted instead of retried forever", async () => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
    let rejectedCount = 0;
    const port = mcpToolPort({
      serverUrl: server.url,
      authHeaderProvider: async () => ({ Authorization: "Bearer revoked-token" }),
      onAuthRejected: () => {
        rejectedCount += 1;
      },
    });

    await expect(port.list()).rejects.toBeTruthy();
    expect(rejectedCount).toBeGreaterThanOrEqual(1);
  });

  it("does NOT call onAuthRejected when the dynamic-auth token is accepted", async () => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
    let rejectedCount = 0;
    const port = mcpToolPort({
      serverUrl: server.url,
      authHeaderProvider: async () => ({ Authorization: "Bearer good-token" }),
      onAuthRejected: () => {
        rejectedCount += 1;
      },
    });

    const tools = await port.list();
    expect(tools.map((t) => t.name)).toContain("whoami");
    expect(rejectedCount).toBe(0);
  });
});

describe("mcpToolPort — the fetch it is given carries all of its traffic", () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it.each([
    ["static headers", { headers: { Authorization: "Bearer good-token" } }],
    ["a dynamic auth provider", { authHeaderProvider: async () => ({ Authorization: "Bearer good-token" }) }],
  ])("sends every POST and the event-stream GET through it, with %s", async (_name, auth) => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
    const calls: { method: string | undefined; authorization: string | null }[] = [];
    const fetchFn = ((url: string | URL, init?: RequestInit) => {
      calls.push({ method: init?.method, authorization: new Headers(init?.headers).get("authorization") });
      return fetch(url, init);
    }) as typeof fetch;
    const port = mcpToolPort({ serverUrl: server.url, fetchFn, ...auth });

    expect((await port.list()).map((t) => t.name)).toContain("whoami");
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toContain("GET"));

    expect(calls.filter((c) => c.method === "POST").length).toBeGreaterThanOrEqual(3);
    expect(calls.every((c) => c.authorization === "Bearer good-token")).toBe(true);
    await port.dispose?.();
  });
});

describe("effectiveUrl", () => {
  it("routes through the proxy when proxyUrl is set", () => {
    const url = effectiveUrl({
      serverUrl: "https://mcp.example.com/rpc",
      proxyUrl: "https://proxy.afm.dev/mcp",
    });
    expect(url.origin + url.pathname).toBe("https://proxy.afm.dev/mcp");
    expect(url.searchParams.get("target")).toBe("https://mcp.example.com/rpc");
  });

  it("connects directly when no proxy is set (this adapter is policy-agnostic — see tool-factory.ts for the browser's mandatory-proxy rule)", () => {
    const url = effectiveUrl({ serverUrl: "https://mcp.example.com/rpc" });
    expect(url.href).toBe("https://mcp.example.com/rpc");
  });
});

describe("toToolDescriptor", () => {
  it("maps name, description, and inputSchema", () => {
    expect(
      toToolDescriptor({ name: "search", description: "find things", inputSchema: { type: "object" } }),
    ).toEqual({ name: "search", description: "find things", inputSchema: { type: "object" } });
  });

  it("defaults a missing inputSchema to {}", () => {
    expect(toToolDescriptor({ name: "x" }).inputSchema).toEqual({});
  });
});

describe("toToolResult", () => {
  it("joins text blocks (ok)", () => {
    expect(toToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toEqual({
      ok: true,
      content: "a\nb",
    });
  });

  it("skips a malformed block missing the fields its type needs", () => {
    expect(toToolResult({ content: [{ type: "image" }, { type: "text", text: "t" }] }).content).toBe("t");
  });

  it("treats isError as a failed result", () => {
    expect(toToolResult({ content: [{ type: "text", text: "boom" }], isError: true }).ok).toBe(false);
  });

  it("uses a placeholder when there is no text content", () => {
    expect(toToolResult({ content: [] })).toEqual({
      ok: true,
      content: "(tool returned no text content)",
    });
  });

  it("keeps a well-formed image block as media instead of dropping it", () => {
    const result = toToolResult({
      content: [{ type: "image", data: "abc123", mimeType: "image/png" }],
    });
    expect(result.media).toEqual([{ kind: "image", data: "abc123", mediaType: "image/png" }]);
    expect(result.content).toBe("(tool returned 1 attachment, no text)");
  });

  it("keeps an audio block as media alongside any text", () => {
    const result = toToolResult({
      content: [
        { type: "text", text: "Here's the recording." },
        { type: "audio", data: "xyz", mimeType: "audio/wav" },
      ],
    });
    expect(result.content).toBe("Here's the recording.");
    expect(result.media).toEqual([{ kind: "audio", data: "xyz", mediaType: "audio/wav" }]);
  });

  it("summarizes a resource_link block by name", () => {
    const result = toToolResult({
      content: [{ type: "resource_link", uri: "file:///report.csv", name: "report.csv" }],
    });
    expect(result.content).toBe("[resource: report.csv]");
  });

  it("inlines an embedded text resource", () => {
    const result = toToolResult({
      content: [{ type: "resource", resource: { uri: "file:///a.txt", text: "hello there" } }],
    });
    expect(result.content).toBe("hello there");
  });

  it("treats an embedded image resource (blob + image mimeType) as media", () => {
    const result = toToolResult({
      content: [{ type: "resource", resource: { uri: "file:///chart.png", mimeType: "image/png", blob: "b64" } }],
    });
    expect(result.media).toEqual([{ kind: "image", data: "b64", mediaType: "image/png" }]);
  });

  it("summarizes a non-image embedded blob resource by reference rather than dropping it", () => {
    const result = toToolResult({
      content: [{ type: "resource", resource: { uri: "file:///data.bin", mimeType: "application/octet-stream", blob: "b64" } }],
    });
    expect(result.content).toBe("[resource: file:///data.bin (application/octet-stream)]");
  });

  it("hands structuredContent to the model as JSON, appended after any text", () => {
    const result = toToolResult({
      content: [{ type: "text", text: "Summary:" }],
      structuredContent: { total: 42, items: ["a", "b"] },
    });
    expect(result.content).toBe('Summary:\n{"total":42,"items":["a","b"]}');
  });
});
