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

import {
  type AgentMetadata,
  agentMetadataSchema,
  describeError,
  parseAfm,
  type Plan,
  planForBrowser,
  splitFrontmatter,
  validateMetadata,
} from "@afm/engine";
import { lineOfPath, pathFromText, SETTINGS_TOO_LONG, settingsRows, settingsTooLong } from "./frontmatter-lines";

type AgentPreview = { ok: true; metadata: AgentMetadata; plan: Plan } | { ok: false; error: string };

export function previewAgent(content: string): AgentPreview {
  if (settingsTooLong(content)) return { ok: false, error: SETTINGS_TOO_LONG };
  try {
    const { frontmatter } = parseAfm(content);
    const metadata = validateMetadata(frontmatter);
    const plan = planForBrowser(metadata);
    return { ok: true, metadata, plan };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

type BuildableAgent = { ok: true; metadata: AgentMetadata } | { ok: false; error: string };

export function buildableAgent(content: string): BuildableAgent {
  if (settingsTooLong(content)) return { ok: false, error: SETTINGS_TOO_LONG };
  try {
    const { frontmatter } = splitFrontmatter(content);
    return { ok: true, metadata: validateMetadata(frontmatter ?? {}) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export interface AfmIssue {
  severity: "error" | "warning";
  message: string;
  field: string;
  line: number | null;
}

interface ZodIssueLike {
  code: string;
  path: (string | number)[];
  message: string;
  keys?: string[];
  received?: unknown;
}

function messageFor(issue: ZodIssueLike, field: string): string {
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return `\`${field}\` is required.`;
  }
  return issue.message;
}

export function collectAfmIssues(content: string): AfmIssue[] {
  if (settingsTooLong(content)) return [{ severity: "error", message: SETTINGS_TOO_LONG, field: "", line: null }];
  const issues: AfmIssue[] = [];

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseAfm(content).frontmatter;
  } catch (error) {
    issues.push({
      severity: "error",
      message: describeError(error),
      field: "",
      line: null,
    });
    return issues;
  }

  const result = agentMetadataSchema.safeParse(frontmatter);
  if (!result.success) {
    for (const raw of result.error.issues as unknown as ZodIssueLike[]) {
      const field = raw.path.map(String).join(".");
      if (raw.code === "unrecognized_keys" && raw.keys) {
        for (const key of raw.keys) {
          issues.push({
            severity: "error",
            message: `Unknown field '${key}'.`,
            field: [...raw.path.map(String), key].join("."),
            line: lineOfPath(content, [...raw.path, key]),
          });
        }
      } else {
        issues.push({
          severity: "error",
          message: messageFor(raw, field),
          field,
          line: lineOfPath(content, raw.path),
        });
      }
    }
    return issues;
  }

  const metadata = validateMetadata(frontmatter);
  for (const planIssue of planForBrowser(metadata).issues) {
    issues.push({
      severity: "warning",
      message: planIssue.message,
      field: planIssue.path ?? "",
      line: lineOfPath(content, pathFromText(planIssue.path)),
    });
  }
  issues.push(...quietMistakes(content));
  return issues;
}

function variableProblems(content: string): AfmIssue[] {
  const issues: AfmIssue[] = [];
  for (const { line, text } of settingsRows(content)) {
    for (let at = text.indexOf("${"); at !== -1; at = text.indexOf("${", at + 2)) {
      const end = text.indexOf("}", at);
      const shown = /^\$\{[^\s"']*/.exec(text.slice(at))?.[0] ?? "${";
      if (end === -1) {
        issues.push({
          severity: "error",
          message: `Unclosed variable \`${shown}\`. Add the closing \`}\`.`,
          field: "",
          line,
        });
        break;
      }
      const name = text
        .slice(at + 2, end)
        .replace(/^[a-z]+:/i, "")
        .trim();
      if (name === "")
        issues.push({
          severity: "error",
          message: `Empty variable \`${text.slice(at, end + 1)}\`. Add a name.`,
          field: "",
          line,
        });
    }
  }
  return issues;
}

function quietMistakes(content: string): AfmIssue[] {
  const preamble = content.split(/\r?\n/).findIndex((line) => /^ {0,3}# (?:Role|Instructions)\s*$/i.test(line));
  const lines = content.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() !== "");
  const ignored =
    first !== -1 && lines[first]?.trim() !== "---" && preamble > first
      ? lines.slice(first, preamble).findIndex((line) => line.trim() !== "")
      : -1;
  const preambleIssues: AfmIssue[] =
    ignored === -1
      ? []
      : [
          {
            severity: lines.slice(first, preamble).some((line) => /^\s*[\w-]+\s*:/.test(line)) ? "error" : "warning",
            message: "Text before the first AFM heading is ignored. Add an opening '---' if these are settings.",
            field: "",
            line: first + ignored + 1,
          },
        ];
  return [...preambleIssues, ...variableProblems(content)];
}
