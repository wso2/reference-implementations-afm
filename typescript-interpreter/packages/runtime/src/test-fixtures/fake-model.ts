import { createServer } from "node:http";

type Json = Record<string, unknown>;
type Message = { role: string; content: unknown };

const chunk = (delta: Json, finish: string | null = null): Json => ({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] });
const usage: Json = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: "fake", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
const sse = (items: Json[]): string => `${items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`;

function answer(messages: Message[]): string | undefined {
  const last = messages[messages.length - 1]!;
  if (last.role === "tool") return sse([chunk({ role: "assistant", content: "The answer " }), chunk({ content: `is: ${String(last.content)}` }), chunk({}, "stop"), usage]);
  const text = String(last.content);
  if (text.includes("fail")) return undefined;
  if (text.includes("find")) {
    const call = { index: 0, id: "call_1", type: "function", function: { name: "search", arguments: JSON.stringify({ query: "x" }) } };
    return sse([chunk({ role: "assistant", tool_calls: [call] }), chunk({}, "tool_calls"), usage]);
  }
  return sse([chunk({ role: "assistant", content: `You said: ${text}` }), chunk({}, "stop"), usage]);
}

export interface FakeModel {
  url: string;
  requests: { url: string | undefined; authorization: string | undefined; body: { messages: Message[]; tools?: { function: { name: string } }[] } }[];
  close(): Promise<void>;
}

export function startFakeModel(): Promise<FakeModel> {
  const requests: FakeModel["requests"] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as FakeModel["requests"][number]["body"];
    requests.push({ url: req.url, authorization: req.headers.authorization, body });
    const reply = answer(body.messages);
    if (reply === undefined) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "the fake model refuses this", type: "invalid_request_error" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(reply);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections(); }) });
    }),
  );
}
