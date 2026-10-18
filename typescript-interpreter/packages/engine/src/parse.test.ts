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
import { parseAfm, splitFrontmatter, frontmatterEndOffset } from "./parse";
import { AfmParseError } from "./errors";

const FULL = `---
name: TestAgent
spec_version: "0.3.0"
max_iterations: 5
---

# Role
This is the agent role.

# Instructions
These are the instructions.
`;

describe("parseAfm", () => {
  it("parses frontmatter, role and instructions", () => {
    const r = parseAfm(FULL);
    expect(r.frontmatter.name).toBe("TestAgent");
    expect(r.frontmatter.max_iterations).toBe(5);
    expect(r.role).toBe("This is the agent role.");
    expect(r.instructions).toBe("These are the instructions.");
  });

  it("handles a file with no frontmatter", () => {
    const text = "# Role\nRole here.\n\n# Instructions\nInstructions here.\n";
    const r = parseAfm(text);
    expect(r.frontmatter).toEqual({});
    expect(r.role).toBe("Role here.");
    expect(r.instructions).toBe("Instructions here.");
  });

  it("keeps multi-line sections", () => {
    const text = `---
name: x
---

# Role
Line 1.
Line 2.

# Instructions
Do A.
Do B.
`;
    const r = parseAfm(text);
    expect(r.role).toBe("Line 1.\nLine 2.");
    expect(r.instructions).toBe("Do A.\nDo B.");
  });

  it("matches the heading exactly (# Roleplay is not # Role)", () => {
    const text = `# Roleplay
not the role.

# Role
the real role.

# Instructions
do it.
`;
    const r = parseAfm(text);
    expect(r.role).toBe("the real role.");
  });

  it("matches headings case-insensitively", () => {
    const text = "# ROLE\nupper role.\n\n# Instructions\ngo.\n";
    const r = parseAfm(text);
    expect(r.role).toBe("upper role.");
  });

  it("throws on unclosed frontmatter", () => {
    const text = "---\nname: x\n\n# Role\nr\n";
    expect(() => parseAfm(text)).toThrow(AfmParseError);
    expect(() => parseAfm(text)).toThrow(/Unclosed frontmatter/);
  });

  it("throws on invalid YAML", () => {
    const text = "---\nbad: [unclosed\n---\n\n# Role\nr\n\n# Instructions\ni\n";
    expect(() => parseAfm(text)).toThrow(/Invalid YAML/);
  });

  it("requires a Role section", () => {
    const text = "# Instructions\nonly instructions.\n";
    expect(() => parseAfm(text)).toThrow(/Role/);
  });

  it("requires an Instructions section", () => {
    const text = "# Role\nonly role.\n";
    expect(() => parseAfm(text)).toThrow(/Instructions/);
  });
});

describe("headings inside code fences", () => {
  it("keeps the instructions that follow a shell comment in a fence", () => {
    const text = `# Role
A helper.

# Instructions
Run this:

\`\`\`bash
# install first
npm ci
\`\`\`

Then report the result.
`;
    const r = parseAfm(text);
    expect(r.instructions).toContain("# install first");
    expect(r.instructions).toContain("Then report the result.");
  });

  it("does not let a fenced '# Role' steal the rest of the instructions", () => {
    const text = `# Role
the real role.

# Instructions
An AFM file looks like this:

\`\`\`markdown
# Role
You are an example.
\`\`\`

Follow that shape.
`;
    const r = parseAfm(text);
    expect(r.role).toBe("the real role.");
    expect(r.instructions).toContain("Follow that shape.");
  });

  it("closes a fence only with its own marker, so ``` inside ~~~ is content", () => {
    const text = `# Role
r.

# Instructions
~~~
\`\`\`
# not a heading
~~~

Still here.
`;
    const r = parseAfm(text);
    expect(r.instructions).toContain("# not a heading");
    expect(r.instructions).toContain("Still here.");
  });

  it("still treats a real heading after a closed fence as a heading", () => {
    const text = `# Role
r.

\`\`\`
code
\`\`\`

# Instructions
the instructions.
`;
    const r = parseAfm(text);
    expect(r.role).toContain("code");
    expect(r.instructions).toBe("the instructions.");
  });
});

describe("splitFrontmatter", () => {
  it("returns null frontmatter when there is no block", () => {
    const r = splitFrontmatter("# Role\nx");
    expect(r.frontmatter).toBeNull();
  });

  it("returns {} for an empty block", () => {
    const r = splitFrontmatter("---\n---\nbody");
    expect(r.frontmatter).toEqual({});
  });

  it("rejects non-mapping (list) frontmatter", () => {
    expect(() => splitFrontmatter("---\n- a\n- b\n---\nbody")).toThrow(/mapping/);
  });

  it("reads a CRLF file the same as an LF one", () => {
    const lf = splitFrontmatter("---\nname: x\n---\n# Role\nr\n");
    const crlf = splitFrontmatter("---\r\nname: x\r\n---\r\n# Role\r\nr\r\n");
    expect(crlf.frontmatter).toEqual(lf.frontmatter);
    expect(crlf.body.replace(/\r\n/g, "\n")).toBe(lf.body);
  });

  it("ends the frontmatter where splitFrontmatter stops reading it", () => {
    const text = "---\nname: x\n---\n# Role\nr\n";
    expect(text.slice(frontmatterEndOffset(text))).toBe("---\n# Role\nr\n");
  });

  it("reports no frontmatter region for an unclosed block, where split throws", () => {
    const text = "---\nname: x\n# Role\nr\n";
    expect(frontmatterEndOffset(text)).toBe(0);
    expect(() => splitFrontmatter(text)).toThrow(/Unclosed/);
  });

  it("ignores blank lines before the opening fence", () => {
    const r = splitFrontmatter("\n  \n\t\n---\nname: x\n---\n# Role\nr\n");
    expect(r.frontmatter).toEqual({ name: "x" });
    expect(r.body).toBe("# Role\nr\n");
  });

  it("ignores CRLF blank lines before the opening fence", () => {
    const r = splitFrontmatter("\r\n\r\n---\r\nname: x\r\n---\r\n# Role\r\nr\r\n");
    expect(r.frontmatter).toEqual({ name: "x" });
  });

  it("ends the frontmatter at the same place when blank lines come first", () => {
    const text = "\n\n---\nname: x\n---\n# Role\nr\n";
    expect(text.slice(frontmatterEndOffset(text))).toBe("---\n# Role\nr\n");
  });

  it("still treats text before the fence as no frontmatter", () => {
    const text = "intro\n---\nname: x\n---\nbody";
    expect(splitFrontmatter(text)).toEqual({ frontmatter: null, body: text });
    expect(frontmatterEndOffset(text)).toBe(0);
  });
});
