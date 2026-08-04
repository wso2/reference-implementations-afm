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

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  cspForMetaTag,
  originOf,
  withConnectSource,
} from "./vite.config";

const configPath = fileURLToPath(new URL("./public/staticwebapp.config.json", import.meta.url));
const config = JSON.parse(readFileSync(configPath, "utf8"));
const csp: string = config.globalHeaders["Content-Security-Policy"];

function directive(name: string): string[] {
  const found = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return found === undefined ? [] : found.split(/\s+/).slice(1);
}

describe("the shipped Content-Security-Policy", () => {
  it("does not allow connect-src to any https host", () => {
    const values = directive("connect-src");
    expect(values).not.toContain("https:");
    for (const value of values) {
      expect(value === "'self'" || /^https:\/\/[a-z0-9.-]+$/.test(value)).toBe(true);
    }
  });

  it("lists only the two model providers, because every other request goes through the MCP proxy", () => {
    expect(directive("connect-src")).toEqual(["'self'", "https://api.openai.com", "https://api.anthropic.com"]);
  });

  it("does not let the page reach an MCP registry", () => {
    expect(directive("connect-src").join(" ")).not.toContain("registry.modelcontextprotocol.io");
  });

  it("keeps script-src to 'self' with no inline or eval", () => {
    const values = directive("script-src");
    expect(values).toEqual(["'self'"]);
    expect(values).not.toContain("'unsafe-inline'");
    expect(values).not.toContain("'unsafe-eval'");
  });

  it("keeps style-src to 'self', so no style comes from inline text in the page", () => {
    expect(directive("style-src")).toEqual(["'self'"]);
  });

  it("starts workers only from blob: URLs, so a worker runs under this policy", () => {
    expect(directive("worker-src")).toEqual(["blob:"]);
  });

  it("still locks down object-src, base-uri and form-action", () => {
    expect(directive("object-src")).toEqual(["'none'"]);
    expect(directive("base-uri")).toEqual(["'none'"]);
    expect(directive("form-action")).toEqual(["'none'"]);
  });

  it("lets img-src load https images for agent icons, and nothing wider", () => {
    expect(directive("img-src")).toEqual(["'self'", "data:", "blob:", "https:"]);
  });

  it("refuses to be framed by anyone", () => {
    expect(directive("frame-ancestors")).toEqual(["'none'"]);
    expect(config.globalHeaders["X-Frame-Options"]).toBe("DENY");
  });

  it("strips frame-ancestors from the <meta> fallback, keeping the rest", () => {
    const meta = cspForMetaTag(csp);
    expect(meta).not.toContain("frame-ancestors");
    expect(meta).toContain("connect-src");
    expect(meta).toContain("script-src 'self'");
  });
});

describe("index.html", () => {
  it("sends no referrer with anything the page requests", () => {
    const html = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");
    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
  });

  it("names an icon in each format, and every one of them is shipped", () => {
    const html = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");
    const icons = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="\/([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(icons).toEqual(["favicon.svg"]);
    for (const icon of icons) {
      expect(existsSync(fileURLToPath(new URL(`./public/${icon}`, import.meta.url)))).toBe(true);
    }
  });
});

describe("values that belong to one deployment", () => {
  it("are not named in the files the repository ships", () => {
    expect(csp).not.toContain("azurewebsites.net");
    expect(existsSync(fileURLToPath(new URL("./public/oauth/client-metadata.json", import.meta.url)))).toBe(false);
  });

  describe("originOf", () => {
    it("keeps only the scheme, host and port", () => {
      expect(originOf("https://afm-proxy.example.net/relay/")).toBe("https://afm-proxy.example.net");
      expect(originOf("http://localhost:8787/")).toBe("http://localhost:8787");
    });

    it("is empty for nothing, blank text or something that is not a URL", () => {
      expect(originOf(undefined)).toBeNull();
      expect(originOf("  ")).toBeNull();
      expect(originOf("not a url")).toBeNull();
    });
  });

  describe("withConnectSource", () => {
    const base = "default-src 'self'; connect-src 'self' https://api.openai.com; img-src 'self'";

    it("adds the origin to connect-src and leaves the other directives alone", () => {
      expect(withConnectSource(base, "https://proxy.example.net")).toBe(
        "default-src 'self'; connect-src 'self' https://api.openai.com https://proxy.example.net; img-src 'self'",
      );
    });

    it("does not add an origin twice", () => {
      const once = withConnectSource(base, "https://proxy.example.net");
      expect(withConnectSource(once, "https://proxy.example.net")).toBe(once);
    });

    it("changes nothing when there is no origin", () => {
      expect(withConnectSource(base, null)).toBe(base);
    });
  });

});
