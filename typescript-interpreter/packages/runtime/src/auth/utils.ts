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

function binaryString(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return binary;
}

export function base64(value: string): string {
  return btoa(binaryString(new TextEncoder().encode(value)));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(binaryString(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomString(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function requireHttpsUrl(raw: string, field: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`This agent file's ${field} is not a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `This agent file's ${field} uses ${url.protocol}// - it must use https://. ` +
        "Sign-in credentials are never sent over an unencrypted connection.",
    );
  }
  return url.toString();
}

export function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

const DEFAULT_LIFETIME_SECONDS = 3600;

export const EXPIRY_SKEW_MS = 30_000;

export const TOKEN_REQUEST_HEADERS = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };

export interface TokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

class TokenRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "TokenRequestError";
    this.status = status;
    this.code = code;
  }
}

export function isGrantRejected(error: unknown): boolean {
  return error instanceof TokenRequestError && error.code === "invalid_grant";
}

async function errorCodeOf(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

export async function postTokenRequest(
  tokenUrl: string,
  request: { headers: Record<string, string>; body: URLSearchParams },
  failure: string,
  fetchFn: typeof fetch,
): Promise<TokenPayload> {
  const response = await fetchFn(requireHttpsUrl(tokenUrl, "token_url"), { method: "POST", redirect: "error", ...request });
  if (!response.ok) {
    throw new TokenRequestError(`${failure}: ${response.status}`, response.status, await errorCodeOf(response));
  }
  return (await response.json()) as TokenPayload;
}

export function expiryOf(payload: TokenPayload): number {
  const lifetimeSeconds = typeof payload.expires_in === "number" ? payload.expires_in : DEFAULT_LIFETIME_SECONDS;
  return Date.now() + lifetimeSeconds * 1000;
}
