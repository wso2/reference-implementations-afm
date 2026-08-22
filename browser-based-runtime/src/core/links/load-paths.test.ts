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

import { describe, expect, it, vi } from "vitest";
import {
  agentFileSizeError,
  decodeInlineAfm,
  encodeInlineAfm,
  fetchAgentFile,
  httpsUrl,
  inlineAfmParam,
  normalizeAgentFileUrl,
} from "./load-paths";

describe("inline encode/decode", () => {
  it("opens an agent file of exactly 1 MB and refuses one byte more", () => {
    const limit = 1024 * 1024;
    expect(decodeInlineAfm(encodeInlineAfm("a".repeat(limit)))).toHaveLength(limit);
    expect(() => decodeInlineAfm(encodeInlineAfm("a".repeat(limit + 1)))).toThrow(/larger than 1 MB/);
  });

  it("refuses a very long fragment without decoding it", () => {
    expect(() => decodeInlineAfm("A".repeat(2 * 1024 * 1024))).toThrow(/larger than 1 MB/);
  });

  it("says how large a picked file may be", () => {
    expect(agentFileSizeError(1024 * 1024)).toBeNull();
    expect(agentFileSizeError(1024 * 1024 + 1)).toMatch(/larger than 1 MB/);
  });

  it("round-trips content including unicode", () => {
    const content = "# Role\nYou are 🤖 a café agent.\n";
    expect(decodeInlineAfm(encodeInlineAfm(content))).toBe(content);
  });

  it("produces a URL-safe string (no + / =)", () => {
    expect(encodeInlineAfm("some content needing padding???")).not.toMatch(/[+/=]/);
  });
});

describe("fetchAgentFile", () => {
  const okFetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "remote-content",
  })) as unknown as typeof fetch;

  it("fetches the text of an https link", async () => {
    expect(await fetchAgentFile("https://h/f", okFetch)).toBe("remote-content");
  });

  it("throws on a failed fetch", async () => {
    const badFetch = (async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "",
    })) as unknown as typeof fetch;
    await expect(fetchAgentFile("https://h/f", badFetch)).rejects.toThrow(/404/);
  });

  it("refuses a link that is not https, without fetching it", async () => {
    const fetchFn = vi.fn(okFetch);
    for (const url of ["http://h/f", "ftp://h/f", "javascript:alert(1)", "x"]) {
      await expect(fetchAgentFile(url, fetchFn)).rejects.toThrow(/must start with https:\/\//);
    }
    expect(fetchFn).not.toHaveBeenCalled();
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

describe("inlineAfmParam", () => {
  it("reads the agent from the fragment only", () => {
    expect(inlineAfmParam("#afm=abc&view=chat")).toBe("abc");
    expect(inlineAfmParam("afm=abc")).toBe("abc");
    expect(inlineAfmParam("#view=chat")).toBeNull();
    expect(inlineAfmParam("")).toBeNull();
  });
});

describe("normalizeAgentFileUrl", () => {
  it("accepts a raw https URL unchanged", () => {
    const out = normalizeAgentFileUrl("https://example.com/agent.afm.md");
    expect(out).toEqual({ ok: true, url: "https://example.com/agent.afm.md" });
  });

  it("trims surrounding whitespace", () => {
    const out = normalizeAgentFileUrl("  https://example.com/a.afm.md  ");
    expect(out.ok && out.url).toBe("https://example.com/a.afm.md");
  });

  it("rewrites a Gist page URL to its raw URL", () => {
    const out = normalizeAgentFileUrl("https://gist.github.com/user1234/54a85");
    expect(out.ok && out.url).toBe("https://gist.github.com/user1234/54a85/raw");
  });

  it("leaves an already-raw Gist URL alone", () => {
    const out = normalizeAgentFileUrl("https://gist.github.com/user1234/54a85/raw");
    expect(out.ok && out.url).toBe("https://gist.github.com/user1234/54a85/raw");
  });

  it("rewrites a GitHub blob URL to raw.githubusercontent.com", () => {
    const out = normalizeAgentFileUrl("https://github.com/wso2/afm/blob/main/examples/a.afm.md");
    expect(out.ok && out.url).toBe("https://raw.githubusercontent.com/wso2/afm/main/examples/a.afm.md");
  });

  it("rejects an empty value", () => {
    const out = normalizeAgentFileUrl("   ");
    expect(out.ok).toBe(false);
  });

  it("rejects something that is not a URL", () => {
    const out = normalizeAgentFileUrl("agent.afm.md");
    expect(out.ok).toBe(false);
  });

  it("rejects a scheme other than https", () => {
    expect(normalizeAgentFileUrl("javascript:alert(1)").ok).toBe(false);
    expect(normalizeAgentFileUrl("file:///etc/passwd").ok).toBe(false);
    expect(normalizeAgentFileUrl("http://example.com/a.afm.md").ok).toBe(false);
  });
});
