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
import { readFileSync, writeFileSync } from "node:fs";
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

function deploymentFiles(proxyOrigin: string | null): Plugin {
  let outDir = "";
  return {
    name: "afm-deployment-files",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
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
    plugins: [react(), productionCsp(proxyOrigin), deploymentFiles(proxyOrigin)],
  };
});
