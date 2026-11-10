import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";

export interface FakeMcp {
  url: string;
  seen: { authorizations: (string | undefined)[]; calls: string[] };
  close(): Promise<void>;
}

export function startFakeMcp(): Promise<FakeMcp> {
  const seen: FakeMcp["seen"] = { authorizations: [], calls: [] };
  const server = createServer(async (req, res) => {
    seen.authorizations.push(req.headers.authorization);
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part as Buffer);
    const body: unknown = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const mcp = new McpServer({ name: "fake-docs", version: "0.0.0" });
    mcp.registerTool("search", { description: "Search the docs", inputSchema: { query: z.string() } }, async ({ query }) => {
      seen.calls.push(query);
      return { content: [{ type: "text" as const, text: `found ${query}` }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/mcp`, seen, close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }) });
    }),
  );
}
