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


import type { Tool } from "ai";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolOutput } from "./run";
import { loadSkills } from "./skills";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "afm-skills-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function skill(folder: string, name: string, description = `${name} helps`, body = `Use ${name}.`, files: Record<string, string> = {}): Promise<string> {
  const path = join(root, folder);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(path, file, ".."), { recursive: true });
    await writeFile(join(path, file), text);
  }
  return path;
}

async function run(tools: Record<string, Tool>, name: string, input: object): Promise<string> {
  const output = (await tools[name]!.execute!(input, { toolCallId: "c", messages: [], abortSignal: new AbortController().signal })) as ToolOutput;
  return output.content;
}

describe("finding skills", () => {
  it("reads a folder that is itself a skill", async () => {
    await skill("pdf", "pdf-tools");
    const loaded = await loadSkills([{ path: "pdf" }], root);
    expect(loaded?.catalog).toContain("<name>pdf-tools</name>");
    expect(loaded?.catalog).toContain("<description>pdf-tools helps</description>");
  });

  it("reads every skill folder of a parent folder, in name order", async () => {
    await skill("all/b-skill", "b");
    await skill("all/a-skill", "a");
    const catalog = (await loadSkills([{ path: "all" }], root))!.catalog;
    expect(catalog.indexOf("<name>a</name>")).toBeLessThan(catalog.indexOf("<name>b</name>"));
  });

  it("resolves a relative path from the folder of the agent file, and accepts an absolute one", async () => {
    const absolute = await skill("elsewhere/x", "x");
    await skill("here/y", "y");
    const catalog = (await loadSkills([{ path: "here" }, { path: absolute }], root))!.catalog;
    expect(catalog).toContain("<name>y</name>");
    expect(catalog).toContain("<name>x</name>");
  });

  it("tells the model how to use the skills", async () => {
    await skill("s", "s");
    const catalog = (await loadSkills([{ path: "s" }], root))!.catalog;
    expect(catalog).toContain("## Available Skills");
    expect(catalog).toContain("call the activate_skill tool");
  });

  it("finds nothing for a missing folder or an empty one", async () => {
    await mkdir(join(root, "empty"));
    expect(await loadSkills([{ path: "missing" }, { path: "empty" }], root)).toBeUndefined();
  });

  it("skips a skill that is not valid, and a repeated name, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await skill("all/good", "good");
    await skill("all/twin", "good", "the second one");
    await mkdir(join(root, "all/nofront"));
    await writeFile(join(root, "all/nofront/SKILL.md"), "just text");
    await mkdir(join(root, "all/noname"));
    await writeFile(join(root, "all/noname/SKILL.md"), "---\ndescription: d\n---\nbody");
    const loaded = await loadSkills([{ path: "all" }], root);
    expect(loaded?.catalog).toContain("<name>good</name>");
    expect(loaded?.catalog).not.toContain("the second one");
    const warnings = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(warnings).toMatch(/must start with YAML frontmatter/);
    expect(warnings).toMatch(/'name' field is required/);
    expect(warnings).toMatch(/already found/);
  });
});

describe("the activate_skill tool", () => {
  it("returns the instructions and the files the skill lists", async () => {
    await skill("s", "demo", "d", "Step one.", { "references/GUIDE.md": "guide", "assets/logo.txt": "logo", "notes.md": "not listed" });
    const { tools } = (await loadSkills([{ path: "s" }], root))!;
    const text = await run(tools as Record<string, Tool>, "activate_skill", { name: "demo" });
    expect(text).toContain('<skill_content name="demo">');
    expect(text).toContain("Step one.");
    expect(text).toContain("<file>references/GUIDE.md</file>");
    expect(text).toContain("<file>assets/logo.txt</file>");
    expect(text).not.toContain("notes.md");
  });

  it("says which skills exist when the name is wrong", async () => {
    await skill("s", "demo");
    const { tools } = (await loadSkills([{ path: "s" }], root))!;
    await expect(run(tools as Record<string, Tool>, "activate_skill", { name: "nope" })).rejects.toThrow(/not found. Available skills: demo/);
  });
});

describe("the read_skill_resource tool", () => {
  const read = async (path: string, name = "demo") => {
    const { tools } = (await loadSkills([{ path: "s" }], root))!;
    return run(tools as Record<string, Tool>, "read_skill_resource", { skill_name: name, resource_path: path });
  };

  beforeEach(async () => {
    await skill("s", "demo", "d", "b", { "references/GUIDE.md": "guide text", "assets/data.bin": "x" });
    await writeFile(join(root, "s/assets/data.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    await writeFile(join(root, "secret.txt"), "outside");
  });

  it("reads a listed file as text", async () => {
    expect(await read("references/GUIDE.md")).toBe("guide text");
  });

  it.each([
    ["a file that is not listed", "references/other.md", /not found in skill 'demo'/],
    ["a file outside references and assets", "SKILL.md", /must start with 'references\/' or 'assets\/'/],
    ["a path with .. in it", "references/../SKILL.md", /Path traversal is not allowed/],
    ["an absolute path", "/etc/passwd", /must start with/],
    ["a path with no folder", "GUIDE.md", /must start with/],
    ["a binary file", "assets/data.bin", /binary file/],
  ])("refuses %s", async (_label, path, message) => {
    await expect(read(path)).rejects.toThrow(message);
  });

  it("refuses a skill that does not exist", async () => {
    await expect(read("references/GUIDE.md", "other")).rejects.toThrow(/Skill 'other' not found/);
  });

  it("refuses a listed file that really lives outside the skill folder, through a link", async () => {
    await skill("linked", "linked");
    await symlink(root, join(root, "linked/references"));
    const { tools } = (await loadSkills([{ path: "linked" }], root))!;
    expect(await run(tools as Record<string, Tool>, "activate_skill", { name: "linked" })).toContain("references/secret.txt");
    await expect(run(tools as Record<string, Tool>, "read_skill_resource", { skill_name: "linked", resource_path: "references/secret.txt" })).rejects.toThrow(/Path traversal is not allowed/);
  });
});
