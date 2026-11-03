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

import { parse as parseYaml, YAMLParseError } from "yaml";
import { AfmParseError } from "./errors";

const DELIMITER = "---";
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#\s+(\S.*)$/;
const SECTIONS = ["role", "instructions"] as const;

type Section = (typeof SECTIONS)[number];

export interface FrontmatterSplit {
  frontmatter: Record<string, unknown> | null;
  body: string;
}

interface RoleAndInstructions {
  role: string;
  instructions: string;
}

export interface ParsedAfm {
  frontmatter: Record<string, unknown>;
  role: string;
  instructions: string;
}

type FrontmatterScan =
  | { kind: "none" }
  | { kind: "unclosed" }
  | { kind: "found"; yamlStart: number; end: number; bodyStart: number };

function lineAt(content: string, start: number): { end: number; next: number } {
  const breakAt = content.indexOf("\n", start);
  return breakAt === -1 ? { end: content.length, next: content.length } : { end: breakAt, next: breakAt + 1 };
}

function scanFrontmatter(content: string): FrontmatterScan {
  let cursor = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (cursor < content.length && content.slice(cursor, lineAt(content, cursor).end).trim() === "") {
    cursor = lineAt(content, cursor).next;
  }
  const opening = lineAt(content, cursor);
  if (content.slice(cursor, opening.end).trimEnd() !== DELIMITER) return { kind: "none" };

  const yamlStart = opening.next;
  for (let start = yamlStart; start < content.length; ) {
    const line = lineAt(content, start);
    if (content.slice(start, line.end).trimEnd() === DELIMITER) {
      return { kind: "found", yamlStart, end: start, bodyStart: line.next };
    }
    start = line.next;
  }
  return { kind: "unclosed" };
}

function refersToItself(value: unknown, active = new Set<object>(), checked = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null || checked.has(value)) return false;
  if (active.has(value)) return true;
  active.add(value);
  const found = Object.values(value).some((child) => refersToItself(child, active, checked));
  active.delete(value);
  checked.add(value);
  return found;
}

function parseMapping(yamlText: string): Record<string, unknown> {
  if (yamlText.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (error) {
    if (error instanceof YAMLParseError) throw new AfmParseError(`Invalid YAML in frontmatter: ${error.message}`);
    throw error;
  }

  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) throw new AfmParseError("Frontmatter must be a YAML mapping");
  if (refersToItself(parsed)) throw new AfmParseError("Frontmatter must not refer back to itself");
  return parsed as Record<string, unknown>;
}

export function frontmatterEndOffset(content: string): number {
  const scan = scanFrontmatter(content);
  return scan.kind === "found" ? scan.end : 0;
}

export function splitFrontmatter(content: string): FrontmatterSplit {
  const scan = scanFrontmatter(content);
  if (scan.kind === "none") return { frontmatter: null, body: content };
  if (scan.kind === "unclosed") throw new AfmParseError("Unclosed frontmatter - missing closing '---'");
  return { frontmatter: parseMapping(content.slice(scan.yamlStart, scan.end)), body: content.slice(scan.bodyStart) };
}

interface Fence {
  marker: string;
  length: number;
}

function updateFence(fence: Fence | null, line: string): Fence | null {
  const marker = FENCE.exec(line)?.[1];
  if (marker === undefined) return fence;
  if (fence === null) return { marker: marker[0]!, length: marker.length };
  const closes =
    marker[0] === fence.marker &&
    marker.length >= fence.length &&
    /^\s*$/.test(line.slice(line.indexOf(marker) + marker.length));
  return closes ? null : fence;
}

function sectionOf(heading: string): Section | null {
  const name = heading.toLowerCase();
  return SECTIONS.find((section) => section === name) ?? null;
}

function extractRoleAndInstructions(body: string): RoleAndInstructions {
  const sections: Record<Section, string[]> = { role: [], instructions: [] };
  let current: Section | null = null;
  let fence: Fence | null = null;

  for (const line of body.split(/\r?\n/)) {
    const isFenceLine = FENCE.test(line);
    fence = updateFence(fence, line);
    const heading = isFenceLine || fence !== null ? undefined : HEADING.exec(line)?.[1]?.trimEnd();
    if (heading !== undefined) {
      current = sectionOf(heading);
      continue;
    }
    if (current !== null) sections[current].push(line);
  }

  const role = sections.role.join("\n").trim();
  const instructions = sections.instructions.join("\n").trim();
  if (role === "") throw new AfmParseError("Missing required '# Role' section");
  if (instructions === "") throw new AfmParseError("Missing required '# Instructions' section");
  return { role, instructions };
}

export function parseAfm(content: string): ParsedAfm {
  const { frontmatter, body } = splitFrontmatter(content);
  const { role, instructions } = extractRoleAndInstructions(body);
  return { frontmatter: frontmatter ?? {}, role, instructions };
}
