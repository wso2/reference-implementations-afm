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
import { createServer } from "node:http";
import { mcpToolPort } from "@afm/adapter-tool";
import {
  MAX_AGENT_FILE_BYTES,
  MAX_RESPONSE_BYTES,
  ResponseTooLargeError,
  limitBodies,
  limitResponses,
} from "./response-limit";

const encoder = new TextEncoder();

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function limited(chunks: string[], headers: Record<string, string> = {}, max = 10) {
  const fetchFn = (async () =>
    new Response(streamOf(chunks), { status: 200, statusText: "OK", headers })) as typeof fetch;
  return limitResponses(fetchFn, max)("https://proxy.example/");
}

const events = { "content-type": "text/event-stream" };

describe("limitResponses", () => {
  it("is 10 MB by default", () => {
    expect(MAX_RESPONSE_BYTES).toBe(10 * 1024 * 1024);
  });

  it("is 1 MB for an agent file", () => {
    expect(MAX_AGENT_FILE_BYTES).toBe(1024 * 1024);
  });

  it("hands a response that stays under the limit through unchanged", async () => {
    const response = await limited(["hello", "!"], { "x-kept": "yes" });
    expect(response.status).toBe(200);
    expect(response.statusText).toBe("OK");
    expect(response.headers.get("x-kept")).toBe("yes");
    expect(await response.text()).toBe("hello!");
  });

  it("lets a response with no body through", async () => {
    const fetchFn = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const response = await limitResponses(fetchFn, 10)("https://proxy.example/");
    expect(response.status).toBe(204);
  });

  it("refuses a response whose declared size is over the limit, and stops it from being sent", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => void (cancelled = true) });
    const fetchFn = (async () => new Response(body, { headers: { "content-length": "11" } })) as typeof fetch;
    await expect(limitResponses(fetchFn, 10)("https://proxy.example/")).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("stops reading a body that grows past the limit, though it declared no size, and says so as the request fails", async () => {
    await expect(limited(["12345", "6789", "0123"])).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("stops asking for the rest of a body once it is over the limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("12345678901"));
      },
      cancel: () => void (cancelled = true),
    });
    const fetchFn = (async () => new Response(body)) as typeof fetch;
    await expect(limitResponses(fetchFn, 10)("https://proxy.example/")).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("lets a body of exactly the limit through", async () => {
    expect(await (await limited(["12345", "67890"])).text()).toBe("1234567890");
  });

  it("says in words how big the limit is", () => {
    expect(new ResponseTooLargeError().message).toBe("The response was larger than 10 MB, so it was cut off.");
    expect(new ResponseTooLargeError(MAX_AGENT_FILE_BYTES).message).toBe(
      "The response was larger than 1 MB, so it was cut off.",
    );
  });

  it("names the limit it was given when a body goes over it", async () => {
    const big = new Uint8Array(MAX_AGENT_FILE_BYTES + 1);
    const fetchFn = (async () => new Response(big, { status: 200 })) as typeof fetch;
    await expect(limitResponses(fetchFn, MAX_AGENT_FILE_BYTES)("https://proxy.example/")).rejects.toThrow(
      /larger than 1 MB/,
    );
  });

  describe("an event stream", () => {
    it("is limited per message, so a long stream of small messages is not cut off", async () => {
      const message = "data: 12345\n\n";
      const response = await limited(
        Array.from({ length: 50 }, () => message),
        events,
        20,
      );
      expect((await response.text()).length).toBe(message.length * 50);
    });

    it("stops at a single message that is over the limit", async () => {
      const response = await limited(["data: ", "x".repeat(30), "\n\n"], events, 20);
      await expect(response.text()).rejects.toBeInstanceOf(ResponseTooLargeError);
    });

    it.each([
      ["a blank line split over two chunks", ["data: 12345\n", "\ndata: 12345\n", "\n"]],
      ["carriage returns and line feeds", ["data: 12345\r\n\r\ndata: 12345\r\n\r\n"]],
      ["carriage returns alone", ["data: 12345\r\rdata: 12345\r\r"]],
      ["a carriage return and line feed split over two chunks", ["data: 12345\r", "\n\r", "\ndata: 12345\r\n\r\n"]],
    ])("starts a new message after %s", async (_label, chunks) => {
      const response = await limited(chunks, events, 16);
      expect(await response.text()).toBe(chunks.join(""));
    });

    it("does not take one carriage return and line feed for the blank line that ends a message", async () => {
      const response = await limited(["data: 12345\r\ndata: 12345\r\ndata: 12345\r\n"], events, 20);
      await expect(response.text()).rejects.toBeInstanceOf(ResponseTooLargeError);
    });

    it("counts a message that has no blank line after it", async () => {
      const response = await limited(["data: 12345\n", "data: 12345\n", "data: 12345\n"], events, 20);
      await expect(response.text()).rejects.toBeInstanceOf(ResponseTooLargeError);
    });

    it("answers the request that is waiting with an error that says why, and ends the stream, when a message is too big", async () => {
      const fetchFn = (async () =>
        new Response(streamOf(["data: ", "x".repeat(30), "\n\n"]), { headers: events })) as typeof fetch;
      const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} });
      const text = await (await limitResponses(fetchFn, 20)("https://proxy.example/", { method: "POST", body })).text();
      const data = JSON.parse(text.split("data: ").at(-1)!.trim()) as {
        id: number;
        error: { code: number; message: string };
      };
      expect(data).toEqual({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32000, message: new ResponseTooLargeError(20).message },
      });
    });

    it("has nobody to answer for a request that carries no id, so the stream fails", async () => {
      const fetchFn = (async () =>
        new Response(streamOf(["data: ", "x".repeat(30), "\n\n"]), { headers: events })) as typeof fetch;
      for (const init of [
        undefined,
        { method: "GET" },
        { method: "POST", body: "not json" },
        { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) },
      ]) {
        const response = await limitResponses(fetchFn, 20)("https://proxy.example/", init);
        await expect(response.text()).rejects.toBeInstanceOf(ResponseTooLargeError);
      }
    });
  });
});

describe("limitBodies", () => {
  const bodies = (chunks: string[], headers: Record<string, string> = {}, max = 10) => {
    const fetchFn = (async () =>
      new Response(streamOf(chunks), { status: 200, statusText: "OK", headers })) as typeof fetch;
    return limitBodies(fetchFn, max)("https://proxy.example/");
  };

  it("hands a response that stays under the limit through unchanged", async () => {
    const response = await bodies(["hello", "!"], { "x-kept": "yes" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-kept")).toBe("yes");
    expect(await response.text()).toBe("hello!");
  });

  it("lets a response with no body through", async () => {
    const fetchFn = (async () => new Response(null, { status: 204 })) as typeof fetch;
    expect((await limitBodies(fetchFn, 10)("https://proxy.example/")).status).toBe(204);
  });

  it("stops a body that grows past the limit", async () => {
    await expect(bodies(["12345", "6789", "0123"])).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("counts an event stream as a whole, so a stream of small messages is cut off at the limit", async () => {
    const message = "data: 12345\n\n";
    await expect(
      bodies(
        Array.from({ length: 50 }, () => message),
        events,
        20,
      ),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("refuses an event stream whose declared size is over the limit", async () => {
    await expect(bodies(["data: 1\n\n"], { ...events, "content-length": "100" })).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });
});

describe("limitResponses with a tool server", () => {
  async function serverReturning(textLength: number, asEventStream = false) {
    const httpServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const message = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
        id?: number;
        method?: string;
        params?: { protocolVersion?: string };
      };
      const reply = (result: unknown) => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        const stream = asEventStream && message.method === "tools/call";
        res.writeHead(200, {
          "content-type": stream ? "text/event-stream" : "application/json",
          "mcp-session-id": "s",
        });
        res.end(stream ? `event: message\ndata: ${body}\n\n` : body);
      };
      if (String(message.method).startsWith("notifications/")) {
        res.writeHead(202);
        return res.end();
      }
      if (message.method === "initialize")
        return reply({
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "big", version: "0" },
        });
      if (message.method === "tools/list")
        return reply({ tools: [{ name: "dump", description: "", inputSchema: { type: "object", properties: {} } }] });
      if (message.method === "tools/call") return reply({ content: [{ type: "text", text: "A".repeat(textLength) }] });
      res.writeHead(400);
      res.end();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as { port: number };
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
    };
  }

  const run = async (url: string, max: number) => {
    const port = mcpToolPort({ serverUrl: url, fetchFn: limitResponses(fetch, max) });
    try {
      await port.list();
      return await port.execute({ id: "1", name: "dump", args: {} }, new AbortController().signal);
    } finally {
      await port.dispose?.();
    }
  };

  it("fails a tool call whose result is bigger than the limit, saying why", async () => {
    const server = await serverReturning(200_000);
    try {
      const outcome = await run(server.url, 100_000).then(
        (result) => result,
        (error: unknown) => error,
      );
      const text = outcome instanceof Error ? outcome.message : (outcome as { content: string }).content;
      expect(text).toMatch(/larger than/);
    } finally {
      await server.close();
    }
  });

  it("fails a tool call whose result arrives as one event bigger than the limit, rather than waiting for it", async () => {
    const server = await serverReturning(200_000, true);
    try {
      const outcome = await Promise.race([
        run(server.url, 100_000).then(
          (result) => result,
          (error: unknown) => error,
        ),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 5_000)),
      ]);
      const text =
        outcome instanceof Error
          ? outcome.message
          : typeof outcome === "string"
            ? outcome
            : (outcome as { content: string }).content;
      expect(text).toMatch(/larger than/);
    } finally {
      await server.close();
    }
  }, 15_000);

  it("lets a result under the limit through", async () => {
    const server = await serverReturning(1_000);
    try {
      const result = await run(server.url, 100_000);
      expect(result.ok).toBe(true);
      expect(result.content).toHaveLength(1_000);
    } finally {
      await server.close();
    }
  });
});
