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

import { MAX_AGENT_FILE_BYTES } from "../runtime/response-limit";

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function encodeInlineAfm(content: string): string {
  return bytesToBase64(new TextEncoder().encode(content)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const MAX_ENCODED_LENGTH = Math.ceil((MAX_AGENT_FILE_BYTES * 4) / 3);
const TOO_LARGE = `An agent file larger than ${MAX_AGENT_FILE_BYTES / (1024 * 1024)} MB is not opened.`;

export function agentFileSizeError(bytes: number): string | null {
  return bytes > MAX_AGENT_FILE_BYTES ? TOO_LARGE : null;
}

export function decodeInlineAfm(encoded: string): string {
  if (encoded.length > MAX_ENCODED_LENGTH) throw new Error(TOO_LARGE);
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const sizeError = agentFileSizeError(binary.length);
  if (sizeError !== null) throw new Error(sizeError);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

type AgentFileUrl = { ok: true; url: string } | { ok: false; error: string };

export function normalizeAgentFileUrl(input: string): AgentFileUrl {
  const trimmed = input.trim();
  if (trimmed === "") {
    return { ok: false, error: "Enter the URL of your .afm.md file." };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "That doesn't look like a full URL - include https://" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "The URL must start with https://" };
  }

  if (url.host === "gist.github.com" && !/\/raw(\/|$)/.test(url.pathname)) {
    const parts = url.pathname.split("/").filter((part) => part !== "");
    if (parts.length >= 2) {
      return { ok: true, url: `https://gist.github.com/${parts[0]}/${parts[1]}/raw` };
    }
  }

  if (url.host === "github.com" && url.pathname.includes("/blob/")) {
    const [owner, repo, , ...rest] = url.pathname.split("/").filter((part) => part !== "");
    if (owner !== undefined && repo !== undefined && rest.length > 0) {
      return { ok: true, url: `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}` };
    }
  }

  return { ok: true, url: url.toString() };
}

export function inlineAfmParam(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, "")).get("afm");
}

export function httpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export async function fetchAgentFile(url: string, fetchFn: typeof fetch): Promise<string> {
  if (httpsUrl(url) === null) throw new Error("An agent file link must start with https://");
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`Failed to fetch agent file: ${response.status} ${response.statusText}`);
  return await response.text();
}
