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
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDynamicMcpAuthHeaderProvider, McpAuthError, mcpAuthHeaders } from "./mcp-auth";
import type { ToolOutput } from "./run";
import { effectiveUrl, type McpServerOptions, mcpServerTools, probeMcpServer, toolOutput } from "./mcp";
import { createToolGuard } from "./tool-guard";

const guard = createToolGuard({ request: async () => "allow" });

type Options = Partial<McpServerOptions> & { url: string };
const source = (options: Options) => mcpServerTools({ name: "t", setupTimeoutMs: 2000, ...options }, guard);

async function execute(tools: ToolSet, name: string, args: unknown = {}): Promise<ToolOutput> {
  const found = tools[name] as Tool | undefined;
  return (await found?.execute?.(args, { toolCallId: "c1", messages: [], abortSignal: new AbortController().signal })) as ToolOutput;
}

const names = async (options: Options) => Object.keys(await source(options).tools());

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


describe("an MCP server's tool list", () => {
  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("offers each tool under the server's prefix, with the server it belongs to", async () => {
    server = await startTestMcpServer();
    const toolSource = source({ url: server.url, name: "My Server" });
    expect(Object.keys(await toolSource.tools())).toEqual(["My-Server__whoami"]);
    expect(toolSource.serverId).toBe(server.url);
    await toolSource.close();
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
    expect(await names({ url: server.url })).toEqual(["t__a", "t__b", "t__c", "t__d", "t__e"]);
  });

  it("asks only once when the server sends everything at once", async () => {
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["a", "b"] })));
    await names({ url: server.url });
    expect(server.received.filter((method) => method === "tools/list")).toHaveLength(1);
  });

  it("refuses a server that hands out the same cursor again and again", async () => {
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["a"], next: "same" })));
    await expect(source({ url: server.url }).tools()).rejects.toThrow(/without ever finishing/);
    expect(server.received.filter((method) => method === "tools/list").length).toBeLessThanOrEqual(3);
  });

  it("refuses a server whose list never ends, after a bounded number of pages", async () => {
    let counter = 0;
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: [`t${counter}`], next: String((counter += 1)) })));
    await expect(source({ url: server.url }).tools()).rejects.toThrow(/without ever finishing/);
    expect(server.received.filter((method) => method === "tools/list")).toHaveLength(50);
  });

  it("offers a tool whose name providers would refuse under a usable name, and runs it under its own", async () => {
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["files.read"] })));
    const tools = await source({ url: server.url }).tools();
    expect(Object.keys(tools)).toEqual(["t__files_read"]);
  });

  it("leaves out a renamed tool that would take the name of another tool of the same server", async () => {
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["files_read", "files.read"] })));
    expect(await names({ url: server.url })).toEqual(["t__files_read"]);
  });

  it("refuses a server that lists the same tool twice, saying so", async () => {
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["a", "a"] })));
    await expect(source({ url: server.url }).tools()).rejects.toThrow(/server 't' lists the tool 'a' more than once/);
  });

  it("refuses a name one character too long, saying which server and tool", async () => {
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["x".repeat(62)] })));
    await expect(source({ url: server.url }).tools()).rejects.toThrow(/server 't'.*longer than the 64 characters/);
  });

  it("accepts a name of exactly the longest length providers allow", async () => {
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["x".repeat(61)] })));
    expect(await names({ url: server.url })).toEqual([`t__${"x".repeat(61)}`]);
  });

  describe("probing a server to choose its tools", () => {
    it("gives the server's own tool names, with no prefix and no renaming", async () => {
      server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["search", "files.read"] })));
      expect((await probeMcpServer({ name: "docs", url: server.url, setupTimeoutMs: 2000 })).map((tool) => tool.name)).toEqual([
        "search",
        "files.read",
      ]);
      expect(server.received.filter((method) => method === "tools/call")).toEqual([]);
    });

    it("applies the tool_filter to the server's own names", async () => {
      server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["a", "b", "c"] })));
      const tools = await probeMcpServer({ name: "docs", url: server.url, filter: { deny: ["b"] }, setupTimeoutMs: 2000 });
      expect(tools.map((tool) => tool.name)).toEqual(["a", "c"]);
    });

    it("refuses credentials over plain http like a real connection", async () => {
      await expect(
        probeMcpServer({ name: "docs", url: "http://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } }),
      ).rejects.toThrow(McpAuthError);
    });
  });

  describe("tool_filter", () => {
    const three = pagedServer(() => ({ names: ["a", "b", "c"] }));

    it("offers only the allowed tools", async () => {
      server = await startTestMcpServer(undefined, three);
      expect(await names({ url: server.url, filter: { allow: ["a", "b", "zzz"] } })).toEqual(["t__a", "t__b"]);
    });

    it("removes the denied tools, and deny wins over allow", async () => {
      server = await startTestMcpServer(undefined, three);
      expect(await names({ url: server.url, filter: { deny: ["b"] } })).toEqual(["t__a", "t__c"]);
      expect(await names({ url: server.url, filter: { allow: ["a", "b"], deny: ["b"] } })).toEqual(["t__a"]);
    });

    it("offers nothing for an empty allow list, and everything with no filter", async () => {
      server = await startTestMcpServer(undefined, three);
      expect(await names({ url: server.url, filter: { allow: [] } })).toEqual([]);
      expect(await names({ url: server.url })).toEqual(["t__a", "t__b", "t__c"]);
    });

    it("does not let a hidden tool be called, even by its prefixed name", async () => {
      server = await startTestMcpServer(undefined, three);
      const tools = await source({ url: server.url, filter: { allow: ["a"] } }).tools();
      expect(tools["t__b"]).toBeUndefined();
      expect(server.received).not.toContain("tools/call");
    });
  });
});

describe("an MCP server that is called", () => {
  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("sends a configured bearer token, and the server receives exactly it", async () => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer secret-token" });
    const tools = await source({ url: server.url, headers: mcpAuthHeaders({ type: "bearer", token: "secret-token" }) }).tools();
    expect(await execute(tools, "t__whoami")).toEqual({ ok: true, content: "Bearer secret-token" });
  });

  it("does not repeat a tool call when the server has forgotten the session, and starts a new session for the next call", async () => {
    server = await startTestMcpServer();
    const toolSource = source({ url: server.url });
    const tools = await toolSource.tools();
    server.forgetSessions();

    const failed = await execute(tools, "t__whoami");
    expect(failed.ok).toBe(false);
    expect(failed.content).toMatch(/session had ended.*not repeated/);
    expect(server.received.filter((method) => method === "tools/call")).toHaveLength(1);

    const next = await execute(tools, "t__whoami");
    expect(next.ok).toBe(true);
    expect(server.received.filter((method) => method === "initialize")).toHaveLength(2);
    await toolSource.close();
  });

  it("fails to connect when the required bearer token is missing or wrong", async () => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer secret-token" });
    await expect(source({ url: server.url }).tools()).rejects.toBeTruthy();
    await expect(
      source({ url: server.url, headers: mcpAuthHeaders({ type: "bearer", token: "wrong-token" }) }).tools(),
    ).rejects.toBeTruthy();
  });

  it("sends api-key auth on a custom header name", async () => {
    server = await startTestMcpServer({ name: "x-api-key", value: "k-123" });
    const tools = await source({ url: server.url, headers: mcpAuthHeaders({ type: "api-key", api_key: "k-123", header_name: "X-Api-Key" }) }).tools();
    expect(await execute(tools, "t__whoami")).toEqual({ ok: true, content: "k-123" });
  });

  it("connects with no auth at all when the server requires none", async () => {
    server = await startTestMcpServer();
    expect(await names({ url: server.url })).toContain("t__whoami");
  });

  describe("when the server answers 401", () => {
    const provider = (token: () => string, renew: (rejected: Record<string, string>) => Promise<boolean>) =>
      Object.assign(async () => ({ Authorization: `Bearer ${token()}` }), { renew });

    it("asks the provider to renew the token it sent, and gives up with the 401 when it cannot", async () => {
      server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
      const renew = vi.fn(async () => false);
      await expect(source({ url: server.url, authHeaderProvider: provider(() => "revoked-token", renew) }).tools()).rejects.toBeTruthy();
      expect(renew).toHaveBeenCalledWith({ Authorization: "Bearer revoked-token" });
    });

    it("repeats the request once with the renewed token, so the call succeeds", async () => {
      server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
      let token = "revoked-token";
      const renew = vi.fn(async () => {
        token = "good-token";
        return true;
      });
      expect(await names({ url: server.url, authHeaderProvider: provider(() => token, renew) })).toContain("t__whoami");
      expect(renew).toHaveBeenCalledWith({ Authorization: "Bearer revoked-token" });
    });

    it("gives up with the 401 instead of looping when the renewed token is turned down too", async () => {
      server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
      const renew = vi.fn(async () => true);
      await expect(source({ url: server.url, authHeaderProvider: provider(() => "revoked-token", renew) }).tools()).rejects.toBeTruthy();
      expect(renew).toHaveBeenCalled();
    });

    it("does not ask for a renewal while the server accepts the token", async () => {
      server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
      const renew = vi.fn(async () => true);
      expect(await names({ url: server.url, authHeaderProvider: provider(() => "good-token", renew) })).toContain("t__whoami");
      expect(renew).not.toHaveBeenCalled();
    });

    it("renews an interactive sign-in through the app, naming the provider", async () => {
      server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
      let token = "revoked-token";
      const renewInteractiveToken = vi.fn(async () => {
        token = "good-token";
        return true;
      });
      const authHeaderProvider = createDynamicMcpAuthHeaderProvider(
        { type: "oauth2", grant_type: "authorization_code", authorize_url: "https://a.example.com/authorize", token_url: "https://a.example.com/token", client_id: "c" },
        { getInteractiveToken: async () => token, renewInteractiveToken },
        server.url,
      );
      expect(await names({ url: server.url, authHeaderProvider })).toContain("t__whoami");
      expect(renewInteractiveToken).toHaveBeenCalledWith(expect.objectContaining({ clientId: "c", resource: server.url }), "revoked-token");
    });
  });

  it.each([
    ["static headers", { headers: { Authorization: "Bearer good-token" } }],
    ["a dynamic auth provider", { authHeaderProvider: async () => ({ Authorization: "Bearer good-token" }) }],
  ])("sends every POST and the event-stream GET through the fetch it is given, with %s", async (_name, auth) => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer good-token" });
    const calls: { method: string | undefined; authorization: string | null }[] = [];
    const fetchFn = ((url: string | URL, init?: RequestInit) => {
      calls.push({ method: init?.method, authorization: new Headers(init?.headers).get("authorization") });
      return fetch(url, init);
    }) as typeof fetch;
    const toolSource = source({ url: server.url, fetchFn, ...auth });
    expect(Object.keys(await toolSource.tools())).toContain("t__whoami");
    await vi.waitFor(() => expect(calls.map((c) => c.method)).toContain("GET"));
    expect(calls.filter((c) => c.method === "POST").length).toBeGreaterThanOrEqual(3);
    expect(calls.every((c) => c.authorization === "Bearer good-token")).toBe(true);
    await toolSource.close();
  });
});

describe("an MCP tool result", () => {
  let server: TestServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  const withOutputSchema = (result: () => Record<string, unknown>) => () => {
    const protocol = new McpProtocolServer({ name: "typed", version: "0.0.0" }, { capabilities: { tools: {} } });
    protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "typed",
          inputSchema: { type: "object" as const },
          outputSchema: { type: "object" as const, properties: { total: { type: "number" } }, required: ["total"] },
        },
      ],
    }));
    protocol.setRequestHandler(CallToolRequestSchema, async () => result() as never);
    return protocol;
  };

  it("is checked against the output schema the tool announced", async () => {
    server = await startTestMcpServer(undefined, withOutputSchema(() => ({ content: [], structuredContent: { total: "many" } })));
    const failed = await execute(await source({ url: server.url }).tools(), "t__typed");
    expect(failed.ok).toBe(false);
    expect(failed.content).toMatch(/does not match the tool's output schema/);
  });

  it("is refused when the tool announced a schema but sent no structured content", async () => {
    server = await startTestMcpServer(undefined, withOutputSchema(() => ({ content: [{ type: "text", text: "hi" }] })));
    const failed = await execute(await source({ url: server.url }).tools(), "t__typed");
    expect(failed).toMatchObject({ ok: false });
    expect(failed.content).toMatch(/no structured content/);
  });

  it("is handed to the model as JSON when it fits the schema", async () => {
    server = await startTestMcpServer(undefined, withOutputSchema(() => ({ content: [], structuredContent: { total: 3 } })));
    expect(await execute(await source({ url: server.url }).tools(), "t__typed")).toEqual({ ok: true, content: '{"total":3}' });
  });

  it("leaves out fields the model filled with empty text", async () => {
    let seen: unknown;
    const echo = () => {
      const protocol = new McpProtocolServer({ name: "echo", version: "0.0.0" }, { capabilities: { tools: {} } });
      protocol.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" as const } }] }));
      protocol.setRequestHandler(CallToolRequestSchema, async (request) => {
        seen = request.params.arguments;
        return { content: [{ type: "text" as const, text: "ok" }] };
      });
      return protocol;
    };
    server = await startTestMcpServer(undefined, echo);
    await execute(await source({ url: server.url }).tools(), "t__echo", { query: "cats", filter: "", nested: { keep: "" } });
    expect(seen).toEqual({ query: "cats", nested: { keep: "" } });
  });
});

describe("credentials over plain http", () => {
  const bearer = { Authorization: "Bearer secret-token" };
  const asked = () => {
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL) => {
      calls.push(String(input));
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  };

  it.each([
    ["static credentials", { headers: bearer }, "http://mcp.example.com/mcp"],
    ["an auth header provider", { authHeaderProvider: async () => bearer }, "http://mcp.example.com/mcp"],
    ["credentials sent through a plain http proxy", { headers: bearer, proxyUrl: "http://proxy.example.com/mcp" }, "https://mcp.example.com/mcp"],
    ["credentials for a plain http server behind an https proxy", { headers: bearer, proxyUrl: "https://proxy.example.com/mcp" }, "http://mcp.example.com/mcp"],
    ["credentials for a lookalike of localhost", { headers: bearer }, "http://localhost.evil.com/mcp"],
    ["credentials for an address whose real host is not localhost", { headers: bearer }, "http://localhost@evil.com/mcp"],
    ["credentials for a lookalike of 127.0.0.1", { headers: bearer }, "http://127.0.0.1.evil.com/mcp"],
  ])("refuses to connect with %s, and sends nothing", async (_label, extra, url) => {
    const { calls, fetchFn } = asked();
    await expect(source({ url, fetchFn, ...extra }).tools()).rejects.toThrow(McpAuthError);
    expect(calls).toEqual([]);
  });

  it("names only the host in its message, never the path, the query or a credential", async () => {
    const { fetchFn } = asked();
    const error = await source({ url: "http://mcp.example.com/private/path?token=s3cret", fetchFn, headers: bearer }).tools().catch((caught: unknown) => caught);
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
  ])("still connects to %s", async (_label, extra, url) => {
    const { calls, fetchFn } = asked();
    await source({ url, fetchFn, ...extra }).tools().catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("a server that redirects to another origin", () => {
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
    const toolSource = source({ url: await redirectingTo(elsewhere.url), ...credentials });
    await expect(toolSource.tools()).rejects.toBeTruthy();
    expect(elsewhere.sawKeys).toEqual([]);
  });
});

describe("effectiveUrl", () => {
  it("routes through the proxy when one is set", () => {
    const url = effectiveUrl({ serverUrl: "https://mcp.example.com/rpc", proxyUrl: "https://proxy.afm.dev/mcp" });
    expect(url.origin + url.pathname).toBe("https://proxy.afm.dev/mcp");
    expect(url.searchParams.get("target")).toBe("https://mcp.example.com/rpc");
  });

  it("connects directly when no proxy is set", () => {
    expect(effectiveUrl({ serverUrl: "https://mcp.example.com/rpc" }).href).toBe("https://mcp.example.com/rpc");
  });
});

describe("toolOutput", () => {
  it("joins text blocks and marks a normal result ok", () => {
    expect(toolOutput({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toEqual({ ok: true, content: "a\nb" });
  });

  it("skips a block that lacks the fields its type needs", () => {
    expect(toolOutput({ content: [{ type: "text" }, { type: "image" }, { type: "text", text: "ok" }] }).content).toBe("ok");
  });

  it("treats isError as a failed result", () => {
    expect(toolOutput({ content: [{ type: "text", text: "bad" }], isError: true })).toEqual({ ok: false, content: "bad" });
  });

  it("says so when there is no text at all", () => {
    expect(toolOutput({ content: [] }).content).toBe("(tool returned no text content)");
  });

  it("never passes pictures or sound to the model, only counts them when nothing else came back", () => {
    expect(toolOutput({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }).content).toBe("(tool returned 1 attachment, no text)");
    const two = toolOutput({ content: [{ type: "image", data: "A", mimeType: "image/png" }, { type: "audio", data: "B", mimeType: "audio/wav" }] });
    expect(two.content).toBe("(tool returned 2 attachments, no text)");
    expect(toolOutput({ content: [{ type: "image", data: "A", mimeType: "image/png" }, { type: "text", text: "caption" }] }).content).toBe("caption");
  });

  it("names a resource link", () => {
    expect(toolOutput({ content: [{ type: "resource_link", name: "report", uri: "file:///r" }] }).content).toBe("[resource: report]");
  });

  it("inlines an embedded text resource and names a binary one", () => {
    expect(toolOutput({ content: [{ type: "resource", resource: { uri: "file:///a", text: "inline" } }] }).content).toBe("inline");
    expect(
      toolOutput({ content: [{ type: "resource", resource: { uri: "file:///d.bin", mimeType: "application/octet-stream", blob: "b64" } }] }).content,
    ).toBe("[resource: file:///d.bin (application/octet-stream)]");
  });

  it("hands structuredContent to the model as JSON, after any text", () => {
    expect(toolOutput({ content: [{ type: "text", text: "Summary:" }], structuredContent: { total: 42 } }).content).toBe('Summary:\n{"total":42}');
  });
});
