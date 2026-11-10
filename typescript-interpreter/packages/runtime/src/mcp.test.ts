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
import type { Tool, ToolSet } from "ai";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { type HttpMcpServer, mcpTools, toolOutput, toolsFromClient } from "./mcp";
import type { ToolOutput } from "./run";

type Extra = Partial<HttpMcpServer["transport"]> & { tool_filter?: HttpMcpServer["tool_filter"]; fetch?: typeof fetch };

const connect = (url: string, { tool_filter, fetch, ...transport }: Extra = {}) => mcpTools({ transport: { url, ...transport }, tool_filter }, { fetch });
const names = async (url: string, extra: Extra = {}) => Object.keys((await connect(url, extra)).tools);

async function execute(tools: ToolSet, name: string, args: unknown = {}): Promise<ToolOutput> {
  const found = tools[name] as Tool | undefined;
  return (await found?.execute?.(args, { toolCallId: "c1", messages: [], abortSignal: new AbortController().signal })) as ToolOutput;
}

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

  it("offers each tool under the name the server gives it", async () => {
    server = await startTestMcpServer();
    const connection = await connect(server.url);
    expect(Object.keys(connection.tools)).toEqual(["whoami"]);
    await connection.close();
  });

  it("keeps a tool name exactly as the server gives it, even with a dot", async () => {
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["files.read"] })));
    expect(await names(server.url)).toEqual(["files.read"]);
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
    expect(await names(server.url)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("asks only once when the server sends everything at once", async () => {
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["a", "b"] })));
    await names(server.url);
    expect(server.received.filter((method) => method === "tools/list")).toHaveLength(1);
  });

  it("refuses a server that hands out the same cursor again and again", async () => {
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["a"], next: "same" })));
    await expect(connect(server.url)).rejects.toThrow(/without ever finishing/);
    expect(server.received.filter((method) => method === "tools/list").length).toBeLessThanOrEqual(3);
  });

  it("refuses a server whose list never ends, after a bounded number of pages", async () => {
    let counter = 0;
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: [`t${counter}`], next: String((counter += 1)) })));
    await expect(connect(server.url)).rejects.toThrow(/without ever finishing/);
    expect(server.received.filter((method) => method === "tools/list")).toHaveLength(50);
  });

  it("refuses a server that lists the same tool twice, saying so", async () => {
    server = await startTestMcpServer(undefined, pagedServer(() => ({ names: ["a", "a"] })));
    await expect(connect(server.url)).rejects.toThrow(/lists the tool 'a' more than once/);
  });

  describe("tool_filter", () => {
    const three = pagedServer(() => ({ names: ["a", "b", "c"] }));

    it("offers only the allowed tools", async () => {
      server = await startTestMcpServer(undefined, three);
      expect(await names(server.url, { tool_filter: { allow: ["a", "b", "zzz"] } })).toEqual(["a", "b"]);
    });

    it("removes the denied tools, and deny wins over allow", async () => {
      server = await startTestMcpServer(undefined, three);
      expect(await names(server.url, { tool_filter: { deny: ["b"] } })).toEqual(["a", "c"]);
      expect(await names(server.url, { tool_filter: { allow: ["a", "b"], deny: ["b"] } })).toEqual(["a"]);
    });

    it("offers nothing for an empty allow list, and everything with no filter", async () => {
      server = await startTestMcpServer(undefined, three);
      expect(await names(server.url, { tool_filter: { allow: [] } })).toEqual([]);
      expect(await names(server.url)).toEqual(["a", "b", "c"]);
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
    const { tools } = await connect(server.url, { authentication: { type: "bearer", token: "secret-token" } });
    expect(await execute(tools, "whoami")).toEqual({ ok: true, content: "Bearer secret-token" });
  });

  it("sends basic authentication as the base64 of user and password", async () => {
    server = await startTestMcpServer({ name: "authorization", value: `Basic ${btoa("alice:s3cret")}` });
    const { tools } = await connect(server.url, { authentication: { type: "basic", username: "alice", password: "s3cret" } });
    expect(await execute(tools, "whoami")).toEqual({ ok: true, content: `Basic ${btoa("alice:s3cret")}` });
  });

  it("sends api-key auth on a custom header name", async () => {
    server = await startTestMcpServer({ name: "x-api-key", value: "k-123" });
    const { tools } = await connect(server.url, { authentication: { type: "api-key", api_key: "k-123", header_name: "X-Api-Key" } });
    expect(await execute(tools, "whoami")).toEqual({ ok: true, content: "k-123" });
  });

  it("fails to connect when the required bearer token is missing or wrong", async () => {
    server = await startTestMcpServer({ name: "authorization", value: "Bearer secret-token" });
    await expect(connect(server.url)).rejects.toBeTruthy();
    await expect(connect(server.url, { authentication: { type: "bearer", token: "wrong-token" } })).rejects.toBeTruthy();
  });

  it("connects with no auth at all when the server requires none", async () => {
    server = await startTestMcpServer();
    expect(await names(server.url)).toContain("whoami");
  });

  it("does not repeat a tool call when the server has forgotten the session, and starts a new session for the next call", async () => {
    server = await startTestMcpServer();
    const connection = await connect(server.url);
    server.forgetSessions();

    const failed = await execute(connection.tools, "whoami").catch((error: Error) => error);
    expect(String(failed)).toMatch(/session had ended.*not repeated/);
    expect(server.received.filter((method) => method === "tools/call")).toHaveLength(1);

    expect((await execute(connection.tools, "whoami")).ok).toBe(true);
    expect(server.received.filter((method) => method === "initialize")).toHaveLength(2);
    await connection.close();
  });

  it("tries again to reconnect when the first try after a forgotten session failed, and closes without an error", async () => {
    server = await startTestMcpServer();
    let down = false;
    const flaky = ((input: string | URL, init?: RequestInit) =>
      down && String(init?.body).includes('"method":"initialize"') ? Promise.reject(new TypeError("fetch failed")) : fetch(input, init)) as typeof fetch;
    const connection = await connect(server.url, { fetch: flaky });
    server.forgetSessions();
    await execute(connection.tools, "whoami").catch(() => undefined);

    down = true;
    await expect(execute(connection.tools, "whoami")).rejects.toBeTruthy();
    down = false;
    expect((await execute(connection.tools, "whoami")).ok).toBe(true);
    await expect(connection.close()).resolves.toBeUndefined();
  });

  it("closes without an error when the last reconnect failed", async () => {
    server = await startTestMcpServer();
    let down = false;
    const flaky = ((input: string | URL, init?: RequestInit) =>
      down && String(init?.body).includes('"method":"initialize"') ? Promise.reject(new TypeError("fetch failed")) : fetch(input, init)) as typeof fetch;
    const connection = await connect(server.url, { fetch: flaky });
    server.forgetSessions();
    await execute(connection.tools, "whoami").catch(() => undefined);
    down = true;
    await execute(connection.tools, "whoami").catch(() => undefined);
    await expect(connection.close()).resolves.toBeUndefined();
  });

  it("sends every request through the fetch it is given, so a host can add its own routing or headers", async () => {
    server = await startTestMcpServer({ name: "x-host", value: "yes" });
    const seen: string[] = [];
    const hostFetch = ((input: string | URL, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${String(input)}`);
      const headers = new Headers(init?.headers);
      headers.set("x-host", "yes");
      return fetch(input, { ...init, headers });
    }) as typeof fetch;
    const { tools } = await connect(server.url, { fetch: hostFetch });
    expect((await execute(tools, "whoami")).ok).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((line) => line.includes(server!.url))).toBe(true);
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
    expect(toolOutput({ content: [{ type: "resource", resource: { uri: "file:///d.bin", blob: "b64" } }] }).content).toBe("[resource: file:///d.bin]");
  });

  it("hands structuredContent to the model as JSON, after any text", () => {
    expect(toolOutput({ content: [{ type: "text", text: "Summary:" }], structuredContent: { total: 42 } }).content).toBe('Summary:\n{"total":42}');
  });
});

describe("credentials over plain http", () => {
  const bearer = { type: "bearer", token: "secret-token" };
  const asked = () => {
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL) => {
      calls.push(String(input));
      return new Response("", { status: 500 });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  };

  it.each([
    ["a plain http server", "http://mcp.example.com/mcp"],
    ["a lookalike of localhost", "http://localhost.evil.com/mcp"],
    ["an address whose real host is not localhost", "http://localhost@evil.com/mcp"],
    ["a lookalike of 127.0.0.1", "http://127.0.0.1.evil.com/mcp"],
  ])("refuses to connect to %s with credentials, and sends nothing", async (_label, url) => {
    const { calls, fetchFn } = asked();
    await expect(connect(url, { authentication: bearer, fetch: fetchFn })).rejects.toThrow(/plain http/);
    expect(calls).toEqual([]);
  });

  it("names only the host in its message, never the path, the query or a credential", async () => {
    const { fetchFn } = asked();
    const error = await connect("http://mcp.example.com/private/path?token=s3cret", { authentication: bearer, fetch: fetchFn }).catch((caught: unknown) => caught);
    const message = (error as Error).message;
    expect(message).toContain("mcp.example.com");
    for (const secret of ["s3cret", "secret-token", "/private/path"]) expect(message).not.toContain(secret);
  });

  it.each([
    ["an https server", bearer, "https://mcp.example.com/mcp"],
    ["a localhost server", bearer, "http://localhost:9000/mcp"],
    ["a 127.0.0.1 server", bearer, "http://127.0.0.1:9000/mcp"],
    ["an IPv6 loopback server", bearer, "http://[::1]:9000/mcp"],
    ["a plain http server with no credentials at all", undefined, "http://mcp.example.com/mcp"],
  ])("still connects to %s", async (_label, authentication, url) => {
    const { calls, fetchFn } = asked();
    await connect(url, { authentication, fetch: fetchFn }).catch(() => undefined);
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("a server that redirects to another origin", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it("does not pass credentials on to that origin", async () => {
    const sawKeys: Array<string | undefined> = [];
    const recorder = await startServer((request, response) => {
      const key = request.headers["x-api-key"];
      sawKeys.push(typeof key === "string" ? key : undefined);
      response.writeHead(404).end();
    });
    const redirector = await startServer((_request, response) => {
      response.writeHead(307, { location: recorder.url }).end();
    });
    closers.push(recorder.close, redirector.close);
    await expect(connect(redirector.url, { authentication: { type: "api-key", api_key: "secret-key", header_name: "x-api-key" } })).rejects.toBeTruthy();
    expect(sawKeys).toEqual([]);
  });

  it("is refused even when the redirect stays on the same server, and the new address is never asked", async () => {
    const asked: Array<string | undefined> = [];
    const redirector = await startServer((request, response) => {
      asked.push(request.url);
      response.writeHead(307, { location: "/elsewhere" }).end();
    });
    closers.push(redirector.close);
    await expect(connect(redirector.url)).rejects.toBeTruthy();
    expect(asked.length).toBeGreaterThan(0);
    expect(asked).not.toContain("/elsewhere");
  });
});

describe("a tool server connection that is managed with fake clients", () => {
  const reply = async () => ({ content: [{ type: "text", text: "ok" }] });
  const fakeClient = (names: string[], run: () => Promise<unknown> = reply) => {
    const client = {
      closed: 0,
      listTools: async () => ({ tools: names.map((name) => ({ name, description: "", inputSchema: { type: "object" } })) }),
      toolsFromDefinitions: () => Object.fromEntries(names.map((name) => [name, { execute: run }])),
      close: async () => {
        client.closed += 1;
      },
    };
    return client;
  };

  it("closes the connection it opened when the server lists a tool twice", async () => {
    const client = fakeClient(["a", "a"]);
    await expect(toolsFromClient(async () => client as never)).rejects.toThrow(/lists the tool 'a' more than once/);
    expect(client.closed).toBe(1);
  });

  it("does not call a duplicate an error when the tool filter hides one of them", async () => {
    const client = fakeClient(["a", "a", "b"]);
    const connection = await toolsFromClient(async () => client as never, { allow: ["b"] });
    expect(Object.keys(connection.tools)).toEqual(["b"]);
    await connection.close();
  });

  it("keeps a newer session when a second call of the older session also finds it ended", async () => {
    const failures: ((error: unknown) => void)[] = [];
    const old = fakeClient(["t"], () => new Promise<never>((_, reject) => failures.push(reject)));
    const fresh = fakeClient(["t"]);
    const clients = [old, fresh];
    let connects = 0;
    const connection = await toolsFromClient(async () => clients[connects++] as never);
    const call = () => execute(connection.tools, "t");

    const first = call().catch((error: Error) => error);
    const second = call().catch((error: Error) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    failures[0]!({ statusCode: 404 });
    expect(String(await first)).toMatch(/session had ended/);
    expect((await call()).ok).toBe(true);
    failures[1]!({ statusCode: 404 });
    expect(String(await second)).toMatch(/session had ended/);

    expect(connects).toBe(2);
    await connection.close();
    expect(fresh.closed).toBe(1);
  });
});
