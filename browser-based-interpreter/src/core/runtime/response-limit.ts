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

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_AGENT_FILE_BYTES = 1024 * 1024;

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const JSON_RPC_SERVER_ERROR = -32000;

export class ResponseTooLargeError extends Error {
  constructor(maxBytes = MAX_RESPONSE_BYTES) {
    super(`The response was larger than ${maxBytes / (1024 * 1024)} MB, so it was cut off.`);
    this.name = "ResponseTooLargeError";
  }
}

async function readWithin(body: ReadableStream<Uint8Array<ArrayBuffer>>, maxBytes: number): Promise<Blob> {
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new Blob(chunks);
    size += value.length;
    if (size > maxBytes) {
      void reader.cancel();
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
}

function requestIdOf(body: BodyInit | null | undefined): string | number | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const message = JSON.parse(body) as { id?: unknown; method?: unknown };
    return message.method !== undefined && (typeof message.id === "string" || typeof message.id === "number")
      ? message.id
      : undefined;
  } catch {
    return undefined;
  }
}

function refusalFor(id: string | number, maxBytes: number): Uint8Array {
  const error = { code: JSON_RPC_SERVER_ERROR, message: new ResponseTooLargeError(maxBytes).message };
  return new TextEncoder().encode(`\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, error })}\n\n`);
}

function eachMessage(maxBytes: number, requestId: string | number | undefined): Transformer<Uint8Array, Uint8Array> {
  let size = 0;
  let lineEnds = 0;
  let afterCarriageReturn = false;
  let skipLineFeed = false;
  return {
    transform(chunk, controller) {
      for (const byte of chunk) {
        if (skipLineFeed) {
          skipLineFeed = false;
          if (byte === LINE_FEED) {
            afterCarriageReturn = false;
            continue;
          }
        }
        const lineEnd = byte === LINE_FEED ? !afterCarriageReturn : byte === CARRIAGE_RETURN;
        lineEnds = lineEnd ? lineEnds + 1 : byte === LINE_FEED ? lineEnds : 0;
        afterCarriageReturn = byte === CARRIAGE_RETURN;
        if (lineEnds === 2) {
          size = 0;
          lineEnds = 0;
          skipLineFeed = byte === CARRIAGE_RETURN;
        } else if (++size > maxBytes) {
          if (requestId === undefined) {
            controller.error(new ResponseTooLargeError(maxBytes));
          } else {
            controller.enqueue(refusalFor(requestId, maxBytes));
            controller.terminate();
          }
          return;
        }
      }
      controller.enqueue(chunk);
    },
  };
}

function withBody(response: Response, body: BodyInit): Response {
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function readWhole(response: Response, maxBytes: number): Promise<Response> {
  if (response.body === null) return response;
  if (Number(response.headers.get("content-length")) > maxBytes) {
    void response.body.cancel();
    throw new ResponseTooLargeError(maxBytes);
  }
  return withBody(response, await readWithin(response.body, maxBytes));
}

export function limitBodies(fetchFn: typeof fetch, maxBytes = MAX_RESPONSE_BYTES): typeof fetch {
  return async (input, init) => readWhole(await fetchFn(input, init), maxBytes);
}

export function limitResponses(fetchFn: typeof fetch, maxBytes = MAX_RESPONSE_BYTES): typeof fetch {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    const isEventStream = response.headers.get("content-type")?.includes("text/event-stream") === true;
    if (response.body === null || !isEventStream) return readWhole(response, maxBytes);
    return withBody(
      response,
      response.body.pipeThrough(new TransformStream(eachMessage(maxBytes, requestIdOf(init?.body)))),
    );
  };
}
