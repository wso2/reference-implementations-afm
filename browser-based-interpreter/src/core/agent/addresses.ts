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


export function parseUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

export function httpsUrl(text: string): URL | null {
  const url = parseUrl(text);
  return url?.protocol === "https:" ? url : null;
}

export function isHttps(value: unknown): boolean {
  return typeof value === "string" && httpsUrl(value) !== null;
}

export function hostOf(address: string): string {
  return parseUrl(address)?.host ?? address;
}

export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

export function isLocalAddress(address: string): boolean {
  const url = parseUrl(address);
  return url !== null && isLocalHost(url.hostname);
}

export function isInsecure(address: string): boolean {
  const url = parseUrl(address);
  return url?.protocol === "http:" && !isLocalHost(url.hostname);
}

export function serverAddress(address: unknown): string | undefined {
  if (typeof address !== "string" || address.includes("${")) return undefined;
  const url = parseUrl(address);
  if (url === null || url.origin === "null") return undefined;
  return `${url.origin}${url.pathname}${url.search}`;
}
