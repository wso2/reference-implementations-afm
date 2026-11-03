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

import { Server as McpProtocolServer } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectiveUrl, type McpHttpOptions, mcpToolPort, toToolDescriptor, toToolResult } from "./mcp";
import { McpAuthError, createDynamicMcpAuthHeaderProvider, mcpAuthHeaders } from "./mcp-auth";

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

interface TestServer {
  url: string;
  lastSeenHeader: string | undefined;
  received: string[];
  forgetSessions: () => void;
  close: () => Promise<void>;
}

function startTestMcpServer(requiredHeader?: { name: string; value: string }, makeServer?: () => McpProtocolServer): Promise<TestServer> {
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
        await (makeServer?.() ?? buildMcpServer()).connect(transport);
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

function pagedServer(page: (cursor: string | undefined) => { names: string[]; next?: string }): () => McpProtocolServer {
  return () => {
    const server = new McpProtocolServer({ name: "paged-server", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const { names, next } = page(request.params?.cursor);
      return {
        tools: names.map((name) => ({ name, inputSchema: { type: "object" as const } })),
        ...(next === undefined ? {} : { nextCursor: next }),
      };
    });
    return server;
  };
}

describe("mcpToolPort - a tool list that comes in pages", () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("reads every page, so no tool of a long list is lost", async () => {
    const pages = [["a", "b"], ["c"], ["d", "e"]];
    server = await startTestMcpServer(
      undefined,
      pagedServer((cursor) => {
        const index = cursor === undefined ? 0 : Number(cursor);
        return { names: pages[index]!, next: index + 1 < pages.length ? String(index + 1) : undefined };
      }),
    );
    const port = mcpToolPort({ serverUrl: server.url });
    expect((await port.list()).map((tool) => tool.name)).toEqual(["a", "b", "c", "d", "e"]);
    await port.dispose?.();
  });

  it("asks only once when the server sends everything at once", async () => {
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["a", "b"] })));
    const port = mcpToolPort({ serverUrl: server.url });
    expect((await port.list()).map((tool) => tool.name)).toEqual(["a", "b"]);
    expect(server.received.filter((method) => method === "tools/list")).toHaveLength(1);
    await port.dispose?.();
  });

  it("refuses a server that hands out the same cursor again and again", async () => {
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["a"], next: "same" })));
    const port = mcpToolPort({ serverUrl: server.url });
    await expect(port.list()).rejects.toThrow(/without ever finishing/);
    expect(server.received.filter((method) => method === "tools/list").length).toBeLessThanOrEqual(3);
    await port.dispose?.();
  });

  it("refuses a server whose list never ends, after a bounded number of pages", async () => {
    let counter = 0;
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: [`t${counter}`], next: String((counter += 1)) })));
    const port = mcpToolPort({ serverUrl: server.url });
    await expect(port.list()).rejects.toThrow(/without ever finishing/);
    expect(server.received.filter((method) => method === "tools/list")).toHaveLength(50);
    await port.dispose?.();
  });
});

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

  it("calls onAuthRejected when the server rejects a dynamic-auth token with 401, so a stale cached token can be evicted", async () => {
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

  it("tells a provider to drop its token when the server answers 401", async () => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
    const invalidate = vi.fn();
    const authHeaderProvider = Object.assign(async () => ({ Authorization: "Bearer revoked-token" }), { invalidate });
    const port = mcpToolPort({ serverUrl: server.url, authHeaderProvider });

    await expect(port.list()).rejects.toBeTruthy();
    expect(invalidate).toHaveBeenCalled();
  });

  it("does not tell the provider to drop its token while the server accepts it", async () => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
    const invalidate = vi.fn();
    const authHeaderProvider = Object.assign(async () => ({ Authorization: "Bearer good-token" }), { invalidate });
    const port = mcpToolPort({ serverUrl: server.url, authHeaderProvider });

    await port.list();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("replaces a machine token the server has revoked, so the next call works", async () => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
    let issued = 0;
    const tokenFetch = (async () => {
      issued += 1;
      return Response.json({ access_token: issued === 1 ? "revoked-token" : "good-token", expires_in: 3600 });
    }) as unknown as typeof fetch;
    const authHeaderProvider = createDynamicMcpAuthHeaderProvider(
      { type: "oauth2", grant_type: "client_credentials", token_url: "https://auth.example.com/token", client_id: "id", client_secret: "secret" },
      { fetchFn: tokenFetch },
    );
    const port = mcpToolPort({ serverUrl: server.url, authHeaderProvider, setupTimeoutMs: 2000 });

    await expect(port.list()).rejects.toBeTruthy();
    const tools = await port.list();
    expect(tools.map((t) => t.name)).toContain("whoami");
    expect(issued).toBe(2);
  });

  it("tells the app when the server rejects an interactive sign-in token with 401", async () => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
    const onInteractiveAuthRejected = vi.fn();
    const authHeaderProvider = createDynamicMcpAuthHeaderProvider(
      {
        type: "oauth2",
        grant_type: "authorization_code",
        authorize_url: "https://a.example.com/authorize",
        token_url: "https://a.example.com/token",
        client_id: "c",
      },
      { getInteractiveToken: async () => "revoked-token", onInteractiveAuthRejected },
      server.url,
    );
    const port = mcpToolPort({ serverUrl: server.url, authHeaderProvider, setupTimeoutMs: 2000 });

    await expect(port.list()).rejects.toBeTruthy();
    expect(onInteractiveAuthRejected).toHaveBeenCalledWith(expect.objectContaining({ clientId: "c", resource: server.url }));
  });

  it("does not tell the app anything while the server accepts the interactive sign-in token", async () => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
    const onInteractiveAuthRejected = vi.fn();
    const authHeaderProvider = createDynamicMcpAuthHeaderProvider(
      {
        type: "oauth2",
        grant_type: "authorization_code",
        authorize_url: "https://a.example.com/authorize",
        token_url: "https://a.example.com/token",
        client_id: "c",
      },
      { getInteractiveToken: async () => "good-token", onInteractiveAuthRejected },
      server.url,
    );
    const port = mcpToolPort({ serverUrl: server.url, authHeaderProvider, setupTimeoutMs: 2000 });

    await port.list();
    expect(onInteractiveAuthRejected).not.toHaveBeenCalled();
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

describe("mcpToolPort - credentials over plain http", () => {
  const bearer = { Authorization: "Bearer secret-token" };
  const asked = () => {
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL) => {
      calls.push(String(input));
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  };
  const port = (options: Partial<McpHttpOptions> & { serverUrl: string }, fetchFn: typeof fetch) =>
    mcpToolPort({ setupTimeoutMs: 2000, fetchFn, ...options });

  it.each([
    ["static credentials", { headers: bearer }, "http://mcp.example.com/mcp"],
    ["an auth header provider", { authHeaderProvider: async () => bearer }, "http://mcp.example.com/mcp"],
    ["credentials sent through a plain http proxy", { headers: bearer, proxyUrl: "http://proxy.example.com/mcp" }, "https://mcp.example.com/mcp"],
    ["credentials for a plain http server behind an https proxy", { headers: bearer, proxyUrl: "https://proxy.example.com/mcp" }, "http://mcp.example.com/mcp"],
    ["credentials for a lookalike of localhost", { headers: bearer }, "http://localhost.evil.com/mcp"],
    ["credentials for an address whose real host is not localhost", { headers: bearer }, "http://localhost@evil.com/mcp"],
    ["credentials for a lookalike of 127.0.0.1", { headers: bearer }, "http://127.0.0.1.evil.com/mcp"],
  ])("refuses to connect with %s, and sends nothing", async (_label, extra, serverUrl) => {
    const { calls, fetchFn } = asked();
    await expect(port({ serverUrl, ...extra }, fetchFn).list()).rejects.toThrow(McpAuthError);
    await expect(port({ serverUrl, ...extra }, fetchFn).execute({ id: "1", name: "t", args: {} }, new AbortController().signal)).rejects.toThrow(
      /plain http/,
    );
    expect(calls).toEqual([]);
  });

  it("names only the host in its message, never the path, the query or a credential", async () => {
    const { fetchFn } = asked();
    let error: unknown;
    try {
      await port({ serverUrl: "http://mcp.example.com/private/path?token=s3cret", headers: bearer }, fetchFn).list();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(McpAuthError);
    const message = (error as Error).message;
    expect(message).toContain("mcp.example.com");
    for (const secret of ["s3cret", "secret-token", "/private/path"]) expect(message).not.toContain(secret);
  });

  it.each([
    ["an https server", { headers: bearer }, "https://mcp.example.com/mcp"],
    ["a localhost server", { headers: bearer }, "http://localhost:9000/mcp"],
    ["a 127.0.0.1 server", { headers: bearer }, "http://127.0.0.1:9000/mcp"],
    ["an IPv6 loopback server", { headers: bearer }, "http://[::1]:9000/mcp"],
    ["a localhost server behind a localhost proxy", { headers: bearer, proxyUrl: "http://localhost:8787/" }, "http://localhost:9000/mcp"],
    ["an https server behind a localhost proxy", { headers: bearer, proxyUrl: "http://localhost:8787/" }, "https://mcp.example.com/mcp"],
    ["a plain http server with no credentials at all", {}, "http://mcp.example.com/mcp"],
    ["a plain http server with an empty header set", { headers: {} }, "http://mcp.example.com/mcp"],
  ])("still connects to %s", async (_label, extra, serverUrl) => {
    const { calls, fetchFn } = asked();
    await port({ serverUrl, ...extra }, fetchFn).list().catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
  });
});

function startServer(handle: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = createServer(handle);
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise((done) => {
            httpServer.close(() => done());
            httpServer.closeAllConnections();
          }),
      });
    });
  });
}

describe("mcpToolPort - a server that redirects to another origin", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  async function redirectingTo(target: string): Promise<string> {
    const redirector = await startServer((_request, response) => {
      response.writeHead(307, { location: target }).end();
    });
    closers.push(redirector.close);
    return redirector.url;
  }

  async function recordingServer(): Promise<{ url: string; sawKeys: Array<string | undefined> }> {
    const sawKeys: Array<string | undefined> = [];
    const recorder = await startServer((request, response) => {
      const key = request.headers["x-api-key"];
      sawKeys.push(typeof key === "string" ? key : undefined);
      response.writeHead(404).end();
    });
    closers.push(recorder.close);
    return { url: recorder.url, sawKeys };
  }

  it.each([
    ["a static header", { headers: { "x-api-key": "secret-key" } }],
    ["an auth header provider", { authHeaderProvider: async () => ({ "x-api-key": "secret-key" }) }],
  ])("does not pass %s on to that origin", async (_label, credentials) => {
    const elsewhere = await recordingServer();
    const port = mcpToolPort({ serverUrl: await redirectingTo(elsewhere.url), setupTimeoutMs: 2000, ...credentials });

    await expect(port.list()).rejects.toBeTruthy();
    expect(elsewhere.sawKeys).toEqual([]);
  });
});
