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

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { toolsFromMetadata } from "./factories";
import type { ServerMessage } from "./protocol";
import { AgentSession } from "./session";
import type { FakeEvent } from "../../test-support/test-model";
import { sessionDeps } from "../../test-support/test-ports";
import { type PermissionBroker, type ToolCall } from "../tools/tool-guard";

const noSecrets = () => ({ env: {}, refused: new Map<string, string>() });

interface Relay {
  url: string;
  calls: { name?: string; arguments?: unknown }[];
  close: () => Promise<void>;
}

function startRelay(): Promise<Relay> {
  const calls: Relay["calls"] = [];
  const httpServer: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString() || "{}") as {
      id?: number;
      method?: string;
      params?: { protocolVersion?: string; name?: string; arguments?: unknown };
    };
    const reply = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    if (String(message.method).startsWith("notifications/")) {
      res.writeHead(202);
      return res.end();
    }
    if (message.method === "initialize") {
      return reply({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "t", version: "0" } });
    }
    if (message.method === "tools/list") {
      return reply({ tools: [{ name: "search", description: "Search", inputSchema: { type: "object", properties: { query: { type: "string" } } } }] });
    }
    if (message.method === "tools/call") {
      calls.push({ name: message.params?.name, arguments: message.params?.arguments });
      return reply({ content: [{ type: "text", text: "found it" }] });
    }
    res.writeHead(400);
    res.end();
  });
  return new Promise((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/`, calls, close: () => new Promise((done) => httpServer.close(() => done())) });
    });
  });
}

const AGENT = `---
name: Researcher
interfaces:
  - type: webchat
tools:
  mcp:
    - name: docs
      transport:
        type: http
        url: https://docs.example.com/mcp
---

# Role
r

# Instructions
i
`;

describe("an agent that uses a real tool server through the whole stack", () => {
  let relay: Relay | null = null;
  afterEach(async () => {
    await relay?.close();
    relay = null;
  });

  async function chat(permission: PermissionBroker) {
    relay = await startRelay();
    const sent: unknown[][] = [];
    let turn = 0;
    const emitted: ServerMessage[] = [];
    const deps = sessionDeps(
      { secrets: noSecrets, permission, emit: (message) => emitted.push(message) },
      {
        createModel: async () => ({
          async *stream(request): AsyncIterable<FakeEvent> {
            sent.push(request.messages.map((message) => message.content));
            turn += 1;
            if (turn === 1) {
              yield { type: "tool-call", id: "c1", name: "docs__search", args: { query: "x", cursor: "" } };
              yield { type: "finish", reason: "tool-calls" };
              return;
            }
            yield { type: "text-delta", text: "All done." };
            yield { type: "finish", reason: "stop" };
          },
        }),
      },
    );
    const session = new AgentSession({
      ...deps,
      createTools: (metadata, guard) => toolsFromMetadata(metadata, { url: relay!.url }, guard),
    });
    await session.load(AGENT);
    emitted.length = 0;
    await session.send("find x");
    return { emitted, sent, relay };
  }

  it("asks first with the arguments the model chose, then sends the server only the fields that have a value", async () => {
    const asked: ToolCall[] = [];
    const { emitted, relay: server } = await chat({
      request: async (call) => {
        asked.push(call);
        return "allow";
      },
    });
    expect(asked).toEqual([{ id: "c1", name: "docs__search", args: { query: "x", cursor: "" }, serverId: "https://docs.example.com/mcp" }]);
    expect(server!.calls).toEqual([{ name: "search", arguments: { query: "x" } }]);
    expect(emitted.find((message) => message.type === "tool-result")).toEqual({
      type: "tool-result",
      id: "c1",
      name: "docs__search",
      ok: true,
      content: "found it",
    });
    expect(emitted.at(-1)).toEqual({ type: "turn-finished", reason: "stop" });
  });

  it("never reaches the server when the user says no, and the model is told", async () => {
    const { emitted, sent, relay: server } = await chat({ request: async () => "deny" });
    expect(server!.calls).toEqual([]);
    expect(emitted.find((message) => message.type === "tool-result")).toMatchObject({ ok: false, content: "Tool call was denied by the user." });
    expect(JSON.stringify(sent[1])).toContain("Tool call was denied by the user.");
    expect(emitted.at(-1)).toEqual({ type: "turn-finished", reason: "stop" });
  });
});
