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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

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

const BASE_URI_EXPRESSION = "new URL(self.location.origin + self.location.pathname + location.search)";

export const BLOB_SAFE_BASE_URI =
  'new URL(self.location.protocol === "blob:" ? self.location.origin + "/" : self.location.origin + self.location.pathname + location.search)';

export function blobSafeBaseUri(code: string): string | null {
  return code.includes(BASE_URI_EXPRESSION) ? code.replace(BASE_URI_EXPRESSION, BLOB_SAFE_BASE_URI) : null;
}

function schemaValidatorInBlobWorker(): Plugin {
  return {
    name: "afm-schema-validator-in-blob-worker",
    transform(code, id) {
      if (!/@cfworker[\\/]json-schema[\\/]dist[\\/]esm[\\/]dereference\.js$/.test(id.split("?")[0] ?? "")) return null;
      const fixed = blobSafeBaseUri(code);
      if (fixed === null)
        this.error("The MCP schema validator no longer needs this fix: remove schemaValidatorInBlobWorker.");
      return fixed;
    },
  };
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

function productionCsp(proxyOrigin: string | null): Plugin {
  return {
    name: "afm-production-csp",
    transformIndexHtml(html, ctx) {
      if (ctx.server !== undefined) return html;
      const config = JSON.parse(readFileSync(resolve(__dirname, "public/staticwebapp.config.json"), "utf8"));
      const csp = cspForMetaTag(
        withConnectSource(config.globalHeaders["Content-Security-Policy"] as string, proxyOrigin),
      );
      return html.replace(
        '<meta charset="utf-8" />',
        `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

function deploymentFiles(clientIdUrl: string | undefined, proxyOrigin: string | null): Plugin {
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
      if (proxyOrigin !== null) {
        const file = join(outDir, "staticwebapp.config.json");
        const config = JSON.parse(readFileSync(file, "utf8"));
        config.globalHeaders["Content-Security-Policy"] = withConnectSource(
          config.globalHeaders["Content-Security-Policy"],
          proxyOrigin,
        );
        writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "VITE_");
  const proxyOrigin = originOf(env.VITE_MCP_PROXY_URL);
  return {
    plugins: [react(), productionCsp(proxyOrigin), deploymentFiles(env.VITE_OAUTH_CLIENT_ID_URL, proxyOrigin)],
    worker: { format: "es" as const, plugins: () => [schemaValidatorInBlobWorker()] },
  };
});
