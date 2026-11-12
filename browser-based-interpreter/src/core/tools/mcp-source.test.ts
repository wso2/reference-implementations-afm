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

import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { RequestTimeoutError } from "../chat/failure";
import { mcpToolSource, probeMcpServer } from "./mcp-source";
import { createToolGuard } from "./tool-guard";
import { ToolNameError } from "./tool-names";

async function toolServer(tools: string[], answerTools = true, delay = 0) {
  const calls: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { id?: number; method?: string; params?: { protocolVersion?: string; arguments?: unknown } };
    await new Promise((resolve) => setTimeout(resolve, delay));
    const reply = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (String(message.method).startsWith("notifications/")) {
      res.writeHead(202);
      return res.end();
    }
    if (message.method === "initialize") return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "t", version: "0" } });
    if (message.method === "tools/list") {
      if (!answerTools) return;
      return reply({ tools: tools.map((name) => ({ name, description: `the ${name} tool`, inputSchema: { type: "object", properties: {} } })) });
    }
    if (message.method === "tools/call") {
      calls.push(message.params?.arguments);
      return reply({ content: [{ type: "text", text: "done" }] });
    }
    res.writeHead(400);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, calls, close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const guard = createToolGuard({ request: async () => "allow" });
const options = { toolCallId: "1", messages: [], abortSignal: new AbortController().signal };

async function offered(url: string, name: string) {
  const source = mcpToolSource({ name, url, fetch }, guard);
  try {
    return Object.keys(await source.tools());
  } finally {
    await source.close();
  }
}

describe("mcpToolSource", () => {
  it("offers each tool under the server's name, and keeps the server's address as its id", async () => {
    const server = await toolServer(["search", "get_page"]);
    const source = mcpToolSource({ name: "My Docs", url: server.url, fetch }, guard);
    try {
      expect(Object.keys(await source.tools())).toEqual(["My-Docs__search", "My-Docs__get_page"]);
      expect(source.serverId).toBe(server.url);
      expect(source.label).toBe("My Docs");
    } finally {
      await source.close();
      await server.close();
    }
  });

  it("connects once, however often the tools are asked for", async () => {
    const server = await toolServer(["search"]);
    let connections = 0;
    const counting: typeof fetch = async (input, init) => {
      if (String(init?.body).includes('"method":"initialize"')) connections += 1;
      return fetch(input, init);
    };
    const source = mcpToolSource({ name: "d", url: server.url, fetch: counting }, guard);
    try {
      await source.tools();
      await source.tools();
      expect(connections).toBe(1);
    } finally {
      await source.close();
      await server.close();
    }
  });

  it("writes a tool name the model cannot use with underscores, and skips one that would collide", async () => {
    const server = await toolServer(["get page", "get_page", "other.tool"]);
    try {
      expect(await offered(server.url, "d")).toEqual(["d__get_page", "d__other_tool"]);
    } finally {
      await server.close();
    }
  });

  it("refuses a name longer than providers allow, naming the tool and the server", async () => {
    const server = await toolServer(["x".repeat(70)]);
    const source = mcpToolSource({ name: "docs", url: server.url, fetch }, guard);
    try {
      await expect(source.tools()).rejects.toThrow(ToolNameError);
      await expect(source.tools()).rejects.toThrow(/'docs'.*longer than the 64 characters/);
    } finally {
      await source.close();
      await server.close();
    }
  });

  it("runs a tool through the guard and sends only the fields that were filled in", async () => {
    const server = await toolServer(["search"]);
    const source = mcpToolSource({ name: "docs", url: server.url, fetch }, guard);
    try {
      const tools = await source.tools();
      const result = await tools["docs__search"]!.execute!({ query: "standup", cursor: "" }, options);
      expect(result).toEqual({ ok: true, content: "done" });
      expect(server.calls).toEqual([{ query: "standup" }]);
    } finally {
      await source.close();
      await server.close();
    }
  });

  it("applies the file's tool_filter", async () => {
    const server = await toolServer(["search", "get_page", "delete_page"]);
    const source = mcpToolSource({ name: "docs", url: server.url, filter: { allow: ["search", "delete_page"], deny: ["delete_page"] }, fetch }, guard);
    try {
      expect(Object.keys(await source.tools())).toEqual(["docs__search"]);
    } finally {
      await source.close();
      await server.close();
    }
  });

  it("tries to connect again after a failure instead of remembering it", async () => {
    const server = await toolServer(["search"]);
    let fail = true;
    const flaky: typeof fetch = async (input, init) => (fail ? Promise.reject(new TypeError("Failed to fetch")) : fetch(input, init));
    const source = mcpToolSource({ name: "docs", url: server.url, fetch: flaky }, guard);
    try {
      await expect(source.tools()).rejects.toThrow();
      fail = false;
      expect(Object.keys(await source.tools())).toEqual(["docs__search"]);
    } finally {
      await source.close();
      await server.close();
    }
  });
});

describe("probeMcpServer", () => {
  it("lists the server's own tool names and descriptions, without the server's name in front", async () => {
    const server = await toolServer(["search", "get_page"]);
    try {
      expect(await probeMcpServer({ name: "docs", url: server.url, fetch }, 5_000)).toEqual([
        { name: "search", description: "the search tool" },
        { name: "get_page", description: "the get_page tool" },
      ]);
    } finally {
      await server.close();
    }
  });

  it("says the server was slow when it does not answer within the time given", async () => {
    const server = await toolServer(["search"], false);
    try {
      await expect(probeMcpServer({ name: "docs", url: server.url, fetch }, 300)).rejects.toBeInstanceOf(RequestTimeoutError);
    } finally {
      await server.close();
    }
  });

  it("gives each request its own time, so a slow server that does answer is not cut off at the total", async () => {
    const server = await toolServer(["search"], true, 400);
    try {
      const started = Date.now();
      expect(await probeMcpServer({ name: "docs", url: server.url, fetch }, 900)).toEqual([{ name: "search", description: "the search tool" }]);
      expect(Date.now() - started).toBeGreaterThan(900);
    } finally {
      await server.close();
    }
  });

  it("passes on any other failure as it is", async () => {
    const down: typeof fetch = async () => Promise.reject(new TypeError("Failed to fetch"));
    await expect(probeMcpServer({ name: "docs", url: "http://127.0.0.1:9/mcp", fetch: down }, 5_000)).rejects.toThrow(/fetch/i);
  });
});
