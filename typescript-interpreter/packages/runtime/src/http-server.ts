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

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Reply {
  status: number;
  type: string;
  body: string;
  headers?: Record<string, string>;
}

export const json = (status: number, value: unknown): Reply => ({ status, type: "application/json", body: JSON.stringify(value) });
export const text = (status: number, body: string): Reply => ({ status, type: "text/plain; charset=utf-8", body });

export interface Request {
  url: URL;
  headers: IncomingHttpHeaders;
  body(limit: number): Promise<Buffer>;
  signal: AbortSignal;
}

export type Handler = (request: Request) => Promise<Reply>;
export type Routes = Map<string, { GET?: Handler; POST?: Handler }>;

export const headerOf = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function answer(req: IncomingMessage, routes: Routes, signal: AbortSignal): Promise<Reply> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    throw new HttpError(400, "Invalid URL");
  }
  const route = routes.get(url.pathname);
  if (route === undefined) throw new HttpError(404, "Not Found");
  const handler = req.method === "GET" || req.method === "POST" ? route[req.method] : undefined;
  if (handler === undefined) {
    const allowed = Object.keys(route).join(", ");
    return { ...json(405, { detail: "Method Not Allowed" }), headers: { Allow: allowed } };
  }
  return handler({ url, headers: req.headers, body: (limit) => readBody(req, limit), signal });
}

export function startServer(routes: Routes, host: string, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    answer(req, routes, abort.signal)
      .catch((error: unknown): Reply => {
        if (error instanceof HttpError) return { ...json(error.status, { detail: error.message }), headers: error.status === 413 ? { Connection: "close" } : {} };
        console.error(`Error while answering a request: ${error instanceof Error ? error.message : String(error)}`);
        return json(500, { detail: "Internal server error" });
      })
      .then((reply) => {
        res.writeHead(reply.status, {
          "Content-Type": reply.type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          ...reply.headers,
        });
        res.end(reply.body);
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

export function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
