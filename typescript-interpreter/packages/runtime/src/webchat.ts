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

import { isTextSchema, SchemaError, type Signature } from "@afm/engine";
import { type Handler, headerOf, HttpError, json, text } from "./http-server";
import { DEFAULT_SESSION, type Sessions } from "./sessions";

const MAX_BODY = 1024 * 1024;

function sessionOf(value: string | undefined): string {
  if (value === undefined || value === "") return DEFAULT_SESSION;
  if (!/^[\x20-\x7e]{1,256}$/.test(value)) throw new HttpError(400, "Invalid X-Session-Id header");
  return value;
}

function decode(raw: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new HttpError(400, "Request body must be valid UTF-8");
  }
}

function messageOf(raw: Buffer, contentType: string): string {
  const type = contentType.toLowerCase();
  const isJson = type.startsWith("application/json");
  if (!isJson && type !== "" && !type.startsWith("text/plain")) throw new HttpError(400, "Unsupported Content-Type for string input");
  const body = decode(raw);
  let message: unknown = body;
  if (isJson) {
    try {
      message = JSON.parse(body);
    } catch {
      throw new HttpError(400, "Invalid JSON in request body");
    }
    if (typeof message !== "string") throw new HttpError(400, "Expected JSON string for string input");
  }
  if ((message as string).trim() === "") throw new HttpError(400, "Message body must be a non-empty string");
  return message as string;
}

function textHandler(sessions: Sessions): Handler {
  return async (request) => {
    const session = sessionOf(headerOf(request.headers, "x-session-id"));
    const message = messageOf(await request.body(MAX_BODY), headerOf(request.headers, "content-type") ?? "");
    return text(200, (await sessions.ask(session, message, { signal: request.signal })) as string);
  };
}

function jsonHandler(sessions: Sessions, signature: Signature): Handler {
  return async (request) => {
    const session = sessionOf(headerOf(request.headers, "x-session-id"));
    if (!(headerOf(request.headers, "content-type") ?? "").toLowerCase().startsWith("application/json")) {
      throw new HttpError(400, "Content-Type must be application/json");
    }
    let input: unknown;
    try {
      input = JSON.parse(decode(await request.body(MAX_BODY)));
    } catch (error) {
      throw error instanceof HttpError ? error : new HttpError(400, "Invalid JSON in request body");
    }
    if (isTextSchema(signature.input) && typeof input !== "string") throw new HttpError(400, "Expected JSON string for string input");
    let value: unknown;
    try {
      value = await sessions.ask(session, input, { signature, signal: request.signal });
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;
      if (error.source === "input") throw new HttpError(400, error.message);
      console.error(`The agent's answer did not fit the output schema: ${error.message}`);
      throw new HttpError(500, "The agent's answer did not fit the output schema");
    }
    const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
    return json(200, isObject && !isTextSchema(signature.output) ? value : { response: value });
  };
}

export function webChatHandler(sessions: Sessions, signature: Signature): Handler {
  return isTextSchema(signature.input) && isTextSchema(signature.output) ? textHandler(sessions) : jsonHandler(sessions, signature);
}
