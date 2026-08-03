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

import { describe, expect, it } from "vitest";
import { hostOf, httpsUrl, isHttps, isInsecure, isLocalAddress, isLocalHost, parseUrl, serverAddress } from "./addresses";

describe("serverAddress", () => {
  it("has no address when the text holds a variable, so a key can never be tied to a name that is filled in later", () => {
    for (const text of [
      "https://docs.example.com${SUFFIX}/mcp",
      "https://${env:HOST}/mcp",
      "${env:MCP_URL}",
      "https://docs.example.com/${env:PART}",
    ]) {
      expect(serverAddress(text)).toBeUndefined();
    }
  });

  it("keeps the origin, path and query, so two paths on one host are two addresses", () => {
    expect(serverAddress("https://docs.example.com/mcp")).toBe("https://docs.example.com/mcp");
    expect(serverAddress("https://docs.example.com/other")).not.toBe(serverAddress("https://docs.example.com/mcp"));
    expect(serverAddress("https://docs.example.com/mcp?team=a")).not.toBe(serverAddress("https://docs.example.com/mcp?team=b"));
  });

  it("tells ports and schemes apart", () => {
    expect(serverAddress("https://docs.example.com:8443/mcp")).not.toBe(serverAddress("https://docs.example.com/mcp"));
    expect(serverAddress("http://docs.example.com/mcp")).not.toBe(serverAddress("https://docs.example.com/mcp"));
  });

  it("writes the same address however the url was spelled", () => {
    expect(serverAddress("HTTPS://Docs.Example.com:443/mcp#top")).toBe(serverAddress("https://docs.example.com/mcp"));
    expect(serverAddress("https://docs.example.com")).toBe("https://docs.example.com/");
  });

  it("is undefined for anything that is not an address", () => {
    expect(serverAddress("not-a-url")).toBeUndefined();
    expect(serverAddress("mailto:someone@example.com")).toBeUndefined();
    expect(serverAddress(undefined)).toBeUndefined();
    expect(serverAddress(42)).toBeUndefined();
  });
});

describe("isInsecure", () => {
  it.each([
    ["http://example.com/mcp"],
    ["http://example.com:8080/mcp"],
    ["HTTP://EXAMPLE.COM/mcp"],
    ["http://192.168.1.20/mcp"],
    ["http://0.0.0.0/mcp"],
  ])("is true for the plain http address %s", (address) => {
    expect(isInsecure(address)).toBe(true);
  });

  it.each([
    ["http://localhost.evil.com/mcp"],
    ["http://localhost@evil.com/mcp"],
    ["http://127.0.0.1.evil.com/mcp"],
    ["http://evil.com/localhost"],
    ["http://evil.com/?next=http://localhost"],
    ["http://localhost.:8787/mcp"],
  ])("is true for the lookalike %s, which is not this machine", (address) => {
    expect(isInsecure(address)).toBe(true);
  });

  it.each([
    ["http://localhost/mcp"],
    ["http://localhost:8787/mcp"],
    ["http://LOCALHOST:8787/mcp"],
    ["http://127.0.0.1:5000/mcp"],
    ["http://127.8.9.10/mcp"],
    ["http://127.1/mcp"],
    ["http://[::1]:3000/mcp"],
  ])("is false for the address on this machine %s", (address) => {
    expect(isInsecure(address)).toBe(false);
  });

  it.each([["https://example.com/mcp"], ["HTTPS://EXAMPLE.COM"], ["https://localhost/mcp"]])("is false for the https address %s", (address) => {
    expect(isInsecure(address)).toBe(false);
  });

  it.each([[""], ["not a url"], ["${env:MCP_URL}"], ["/relative/path"]])("is false for %j, which is not an address it can judge", (address) => {
    expect(isInsecure(address)).toBe(false);
  });
});

describe("httpsUrl", () => {
  it("gives the address of an https link and nothing for any other text", () => {
    expect(httpsUrl("https://example.com/a")?.href).toBe("https://example.com/a");
    expect(httpsUrl("http://example.com")).toBeNull();
    expect(httpsUrl("javascript:alert(1)")).toBeNull();
    expect(httpsUrl("not a link")).toBeNull();
  });
});

describe("isHttps", () => {
  it("is true only for an https address given as text", () => {
    expect(isHttps("https://auth.example.com/token")).toBe(true);
  });

  it.each([["http://auth.example.com/token"], ["javascript:alert(1)"], ["not a url"], [""], [undefined], [null], [5], [["https://example.com"]]])(
    "is false for %j",
    (value) => {
      expect(isHttps(value)).toBe(false);
    },
  );
});

describe("parseUrl", () => {
  it("gives the address, or null when the text is not one", () => {
    expect(parseUrl("https://example.com/a")?.host).toBe("example.com");
    expect(parseUrl("not a url")).toBeNull();
    expect(parseUrl("")).toBeNull();
  });
});

describe("hostOf", () => {
  it("gives the host with its port, or the text itself when it is not an address", () => {
    expect(hostOf("https://docs.example.com:8443/mcp")).toBe("docs.example.com:8443");
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("isLocalHost and isLocalAddress", () => {
  it.each(["localhost", "[::1]", "127.0.0.1", "127.8.9.10"])("accepts %s", (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each(["localhost.evil.com", "127.0.0.1.evil.com", "128.0.0.1", "example.com", ""])("refuses %s", (host) => {
    expect(isLocalHost(host)).toBe(false);
  });

  it("judges a whole address, and refuses what is not one", () => {
    expect(isLocalAddress("http://127.0.0.1:8787/mcp")).toBe(true);
    expect(isLocalAddress("http://[::1]:3000/")).toBe(true);
    expect(isLocalAddress("https://example.com")).toBe(false);
    expect(isLocalAddress("not a url")).toBe(false);
  });
});
