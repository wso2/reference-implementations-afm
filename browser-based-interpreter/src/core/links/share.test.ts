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
import { decodeInlineAfm } from "./load-paths";
import { buildShareLink, literalCredentialFields } from "./share";

const SOURCE = "---\nname: Demo\n---\n\n# Role\nr\n\n# Instructions\ni\n";
const ADDRESS = "https://afm.example/";

describe("buildShareLink", () => {
  it("inline -> the trust-screen view, agent in the fragment", () => {
    const link = buildShareLink(ADDRESS, "inline", SOURCE, null)!;
    expect(link.startsWith(`${ADDRESS}?view=chat#afm=`)).toBe(true);
    expect(decodeInlineAfm(link.split("#afm=")[1]!)).toBe(SOURCE);
  });

  it("keeps the folder a project site is served from, so the link opens AFM and not the owner's root", () => {
    const address = "https://wso2.github.io/reference-implementations-afm/";
    expect(buildShareLink(address, "inline", SOURCE, null)!.startsWith(`${address}?view=chat#afm=`)).toBe(true);
    expect(buildShareLink(address, "url", SOURCE, "https://example.com/a.afm.md")).toBe(
      `${address}?view=chat&file=${encodeURIComponent("https://example.com/a.afm.md")}`,
    );
  });

  it("keeps the inline agent out of the query string", () => {
    expect(buildShareLink(ADDRESS, "inline", SOURCE, null)).not.toContain("?afm=");
  });

  it("url -> the trust-screen view with the encoded file url", () => {
    const link = buildShareLink(ADDRESS, "url", SOURCE, "https://gist.github.com/u/a/raw");
    expect(link).toBe(`${ADDRESS}?view=chat&file=${encodeURIComponent("https://gist.github.com/u/a/raw")}`);
  });

  it("returns null for the url method until a url is supplied", () => {
    expect(buildShareLink(ADDRESS, "url", SOURCE, null)).toBeNull();
    expect(buildShareLink(ADDRESS, "url", SOURCE, "")).toBeNull();
  });

  it("never leaks the agent source into a url-method link", () => {
    const link = buildShareLink(ADDRESS, "url", SOURCE, "https://example.com/a.afm.md")!;
    expect(link).not.toContain("afm=");
  });
});

describe("literalCredentialFields", () => {
  const file = (authentication: string) => `---
name: Demo
model:
  provider: openai
  authentication:
${authentication}
---

# Role
r

# Instructions
i
`;

  it("finds nothing when every credential is a reference", () => {
    expect(literalCredentialFields(file('    type: api-key\n    api_key: "${env:OPENAI_API_KEY}"'))).toEqual([]);
  });

  it("finds a key typed into the model's authentication", () => {
    expect(literalCredentialFields(file("    type: api-key\n    api_key: sk-secret"))).toEqual(["api_key"]);
  });

  it("finds credentials typed into a tool server's authentication too", () => {
    const source = `---
name: Demo
tools:
  mcp:
    - name: docs
      transport:
        type: http
        url: https://docs.example.com/mcp
        authentication:
          type: basic
          username: someone
          password: hunter2
---

# Role
r

# Instructions
i
`;
    expect(literalCredentialFields(source)).toEqual(["password"]);
  });

  it("does not count a field that only names a header or a user", () => {
    expect(literalCredentialFields(file("    type: api-key\n    header_name: X-Key\n    api_key: ${env:K}"))).toEqual(
      [],
    );
  });

  it("finds nothing in a file it cannot read", () => {
    expect(literalCredentialFields("---\nname: [unclosed")).toEqual([]);
    expect(literalCredentialFields("no frontmatter at all")).toEqual([]);
  });
});

describe("literalCredentialFields on a file with a very long settings block", () => {
  it("looks at nothing and returns at once", () => {
    const long = `---\nname: X\n${Array.from({ length: 2500 }, (_, index) => `k${index}: 1`).join("\n")}\n---\n`;
    const started = Date.now();
    expect(literalCredentialFields(long)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
