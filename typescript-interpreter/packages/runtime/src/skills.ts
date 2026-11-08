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


import { splitFrontmatter } from "@afm/engine";
import type { ToolSet } from "ai";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { textTool } from "./run";

interface Skill {
  name: string;
  description: string;
  body: string;
  folder: string;
  resources: string[];
}

const SKILL_FILE = "SKILL.md";
const RESOURCE_FOLDERS = ["references", "assets"];

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then(
    (found) => found.isDirectory(),
    () => false,
  );

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (found) => found.isFile(),
    () => false,
  );

async function namesIn(folder: string, check: (path: string) => Promise<boolean>): Promise<string[]> {
  const names = (await readdir(folder)).sort();
  const keep = await Promise.all(names.map((name) => check(join(folder, name))));
  return names.filter((_, index) => keep[index]);
}

async function resourcesOf(folder: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of RESOURCE_FOLDERS) {
    if (!(await isDirectory(join(folder, name)))) continue;
    found.push(...(await namesIn(join(folder, name), isFile)).map((file) => `${name}/${file}`));
  }
  return found;
}

async function readSkill(folder: string): Promise<Skill> {
  const { frontmatter, body } = splitFrontmatter(await readFile(join(folder, SKILL_FILE), "utf-8"));
  if (frontmatter === null) throw new Error("SKILL.md must start with YAML frontmatter (---)");
  const { name, description } = frontmatter;
  if (typeof name !== "string" || name.trim() === "") throw new Error("SKILL.md 'name' field is required and must not be empty");
  if (typeof description !== "string" || description.trim() === "") throw new Error("SKILL.md 'description' field is required and must not be empty");
  return { name: name.trim(), description: description.trim(), body: body.trim(), folder, resources: await resourcesOf(folder) };
}

async function foldersOf(path: string): Promise<string[]> {
  if (await exists(join(path, SKILL_FILE))) return [path];
  if (!(await exists(path))) return [];
  const names = await namesIn(path, isDirectory);
  const withSkill = await Promise.all(names.map(async (name) => ((await exists(join(path, name, SKILL_FILE))) ? join(path, name) : undefined)));
  return withSkill.filter((folder) => folder !== undefined);
}

async function discoverSkills(sources: { path: string }[], baseDir: string): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();
  for (const source of sources) {
    for (const folder of await foldersOf(resolve(baseDir, source.path))) {
      try {
        const skill = await readSkill(folder);
        if (skills.has(skill.name)) console.warn(`Skill '${skill.name}' was already found, skipping the duplicate at ${folder}`);
        else skills.set(skill.name, skill);
      } catch (error) {
        console.warn(`Skipping the skill at ${folder}: ${(error as Error).message}`);
      }
    }
  }
  return skills;
}

function catalogOf(skills: Skill[]): string {
  const entries = skills.map((skill) => `    <skill>\n        <name>${skill.name}</name>\n        <description>${skill.description}</description>\n    </skill>`);
  return [
    "",
    "## Available Skills",
    "",
    "The following skills provide specialized instructions for specific tasks.",
    "When a task matches a skill's description, call the activate_skill tool",
    "with the skill's name to load its full instructions.",
    "",
    "<available_skills>",
    ...entries,
    "</available_skills>",
    "",
  ].join("\n");
}

function skillNamed(skills: Map<string, Skill>, name: string): Skill {
  const skill = skills.get(name);
  if (skill === undefined) throw new Error(`Skill '${name}' not found. Available skills: ${[...skills.keys()].join(", ")}`);
  return skill;
}

function activate(skill: Skill): string {
  const files = skill.resources.map((resource) => `<file>${resource}</file>`).join("\n");
  const resources = files === "" ? "" : `\n<skill_resources>\n${files}\n</skill_resources>\nUse the read_skill_resource tool to read any of these files if needed.\n`;
  return `<skill_content name="${skill.name}">\n${skill.body}\n${resources}</skill_content>\n`;
}

async function readResource(skill: Skill, path: string): Promise<string> {
  const parts = path.split("/");
  if (parts.length < 2 || !RESOURCE_FOLDERS.includes(parts[0]!)) throw new Error(`Resource path must start with '${RESOURCE_FOLDERS.join("/' or '")}/'`);
  if (parts.includes("..")) throw new Error("Path traversal is not allowed in resource paths");
  if (!skill.resources.includes(path)) throw new Error(`Resource '${path}' not found in skill '${skill.name}'. Available: ${skill.resources.join(", ")}`);
  const outside = relative(await realpath(skill.folder), await realpath(join(skill.folder, path)));
  if (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside)) throw new Error("Path traversal is not allowed in resource paths");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(join(skill.folder, path)));
  } catch {
    throw new Error(`Resource '${path}' is a binary file and cannot be read as text`);
  }
}

export async function loadSkills(sources: { path: string }[], baseDir: string): Promise<{ catalog: string; tools: ToolSet } | undefined> {
  const skills = await discoverSkills(sources, baseDir);
  if (skills.size === 0) return undefined;
  const tools: ToolSet = {
    activate_skill: textTool({
      description: "Load the full instructions of a skill when the task matches the skill's description.",
      inputSchema: z.object({ name: z.string().describe("The name of the skill to activate, from the available skills") }),
      execute: async ({ name }) => ({ ok: true, content: activate(skillNamed(skills, name)) }),
    }),
    read_skill_resource: textTool({
      description: "Read a file that was listed in skill_resources after activating a skill.",
      inputSchema: z.object({
        skill_name: z.string().describe("The skill that owns the file"),
        resource_path: z.string().describe("The path as listed, for example references/REFERENCE.md"),
      }),
      execute: async ({ skill_name, resource_path }) => ({ ok: true, content: await readResource(skillNamed(skills, skill_name), resource_path) }),
    }),
  };
  return { catalog: catalogOf([...skills.values()]), tools };
}
