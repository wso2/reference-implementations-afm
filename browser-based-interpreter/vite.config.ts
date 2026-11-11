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

import { join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { CONTENT_SECURITY_POLICY } from "./csp";

const META_INVALID_DIRECTIVES = new Set(["frame-ancestors", "report-uri", "sandbox"]);

export function cspForMetaTag(headerCsp: string): string {
  return headerCsp
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => !META_INVALID_DIRECTIVES.has(directive.split(/\s+/)[0] ?? ""))
    .join("; ");
}

export function originOf(url: string | undefined): string | null {
  if (url === undefined || url.trim() === "") return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function withConnectSource(csp: string, origin: string | null): string {
  if (origin === null) return csp;
  return csp
    .split(";")
    .map((directive) => {
      const parts = directive.trim().split(/\s+/);
      return parts[0] === "connect-src" && !parts.includes(origin) ? [...parts, origin].join(" ") : parts.join(" ");
    })
    .join("; ");
}

export function clientMetadata(clientIdUrl: string) {
  const address = new URL("../", clientIdUrl).href;
  return {
    client_id: clientIdUrl,
    client_name: "AFM",
    client_uri: address,
    redirect_uris: [address],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

const CSP_ANCHOR = '<meta charset="utf-8" />';

export function productionCsp(proxyOrigin: string | null): Plugin {
  return {
    name: "afm-production-csp",
    transformIndexHtml(html, ctx) {
      if (ctx.server !== undefined) return html;
      if (!html.includes(CSP_ANCHOR)) {
        throw new Error("afm-production-csp: the charset meta tag was not found in index.html, so the Content-Security-Policy tag cannot be added.");
      }
      const csp = cspForMetaTag(withConnectSource(CONTENT_SECURITY_POLICY, proxyOrigin));
      return html.replace(CSP_ANCHOR, () => `${CSP_ANCHOR}\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    },
  };
}

function deploymentFiles(clientIdUrl: string | undefined): Plugin {
  let outDir = "";
  return {
    name: "afm-deployment-files",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (clientIdUrl !== undefined && clientIdUrl !== "") {
        if (originOf(clientIdUrl) === null) throw new Error("VITE_OAUTH_CLIENT_ID_URL is not a URL");
        mkdirSync(join(outDir, "oauth"), { recursive: true });
        writeFileSync(
          join(outDir, "oauth/client-metadata.json"),
          `${JSON.stringify(clientMetadata(clientIdUrl), null, 2)}\n`,
        );
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "VITE_");
  const proxyOrigin = originOf(env.VITE_MCP_PROXY_URL);
  return {
    plugins: [react(), productionCsp(proxyOrigin), deploymentFiles(env.VITE_OAUTH_CLIENT_ID_URL)],
    worker: { format: "es" as const },
  };
});
