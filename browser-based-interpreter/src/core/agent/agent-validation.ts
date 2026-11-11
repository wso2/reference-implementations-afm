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

import { type AgentMetadata, agentMetadataSchema, describeError, parseAfm, splitFrontmatter } from "@afm/engine";
import { literalCredentialPaths } from "../links/share";
import { lineOfPath, pathFromText, SETTINGS_TOO_LONG, settingsRows, settingsTooLong } from "./frontmatter-lines";
import { declaredAgent } from "./browser-agent";
import { planForBrowser, type Plan } from "./browser-plan";
import { type SignIn, signInProblems, withoutSignIns } from "./sign-in";

type AgentPreview = { ok: true; metadata: AgentMetadata; plan: Plan } | { ok: false; error: string };

export function previewAgent(content: string): AgentPreview {
  if (settingsTooLong(content)) return { ok: false, error: SETTINGS_TOO_LONG };
  try {
    const metadata = declaredAgent(parseAfm(content).frontmatter);
    return { ok: true, metadata, plan: planForBrowser(metadata) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

type BuildableAgent = { ok: true; metadata: AgentMetadata } | { ok: false; error: string };

export function buildableAgent(content: string): BuildableAgent {
  if (settingsTooLong(content)) return { ok: false, error: SETTINGS_TOO_LONG };
  try {
    const { frontmatter } = splitFrontmatter(content);
    return { ok: true, metadata: declaredAgent(frontmatter ?? {}) };
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

const issue = (severity: AfmIssue["severity"], message: string, field = "", line: number | null = null): AfmIssue => ({
  severity,
  message,
  field,
  line,
});

interface ZodIssueLike {
  code: string;
  path: (string | number)[];
  message: string;
  keys?: string[];
  received?: unknown;
}

function schemaIssues(content: string, zodIssues: ZodIssueLike[]): AfmIssue[] {
  return zodIssues.flatMap((raw) => {
    if (raw.code === "unrecognized_keys" && raw.keys) {
      return raw.keys.map((key) =>
        issue("error", `Unknown field '${key}'.`, [...raw.path, key].join("."), lineOfPath(content, [...raw.path, key])),
      );
    }
    const field = raw.path.join(".");
    const missing = raw.code === "invalid_type" && raw.received === "undefined";
    return [issue("error", missing ? `\`${field}\` is required.` : raw.message, field, lineOfPath(content, raw.path))];
  });
}

function signInIssues(content: string, signIns: SignIn[]): AfmIssue[] {
  return signInProblems(signIns).map(({ path, message }) =>
    issue("error", message, path.join("."), lineOfPath(content, path)),
  );
}

export function collectAfmIssues(content: string): AfmIssue[] {
  if (settingsTooLong(content)) return [issue("error", SETTINGS_TOO_LONG)];

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseAfm(content).frontmatter;
  } catch (error) {
    return [issue("error", describeError(error))];
  }

  const { frontmatter: stripped, signIns } = withoutSignIns(frontmatter);
  const signInErrors = signInIssues(content, signIns);
  const result = agentMetadataSchema.safeParse(stripped);
  if (!result.success) return [...schemaIssues(content, result.error.issues as unknown as ZodIssueLike[]), ...signInErrors];
  if (signInErrors.length > 0) return signInErrors;

  const limitations = planForBrowser(declaredAgent(frontmatter)).issues.map((planIssue) =>
    issue("warning", planIssue.message, planIssue.path, lineOfPath(content, pathFromText(planIssue.path))),
  );
  return [...limitations, ...literalCredentialIssues(content), ...textBeforeHeading(content), ...variableProblems(content)];
}

const keyInFile = (field: string) =>
  `\`${field}\` holds what looks like a key, and anyone who gets this file can read it. ` +
  "Use a `${env:NAME}` reference instead.";

function literalCredentialIssues(content: string): AfmIssue[] {
  return literalCredentialPaths(content).map((path) => {
    const field = String(path.at(-1));
    return issue("warning", keyInFile(field), field, lineOfPath(content, path));
  });
}

function variableProblems(content: string): AfmIssue[] {
  const issues: AfmIssue[] = [];
  for (const { line, text } of settingsRows(content)) {
    for (let at = text.indexOf("${"); at !== -1; at = text.indexOf("${", at + 2)) {
      const end = text.indexOf("}", at);
      if (end === -1) {
        const shown = /^\$\{[^\s"']*/.exec(text.slice(at))?.[0] ?? "${";
        issues.push(issue("error", `Unclosed variable \`${shown}\`. Add the closing \`}\`.`, "", line));
        break;
      }
      const name = text.slice(at + 2, end).replace(/^[a-z]+:/i, "").trim();
      if (name === "") issues.push(issue("error", `Empty variable \`${text.slice(at, end + 1)}\`. Add a name.`, "", line));
    }
  }
  return issues;
}

function textBeforeHeading(content: string): AfmIssue[] {
  const lines = content.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^ {0,3}# (?:Role|Instructions)\s*$/i.test(line));
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1 || lines[first]!.trim() === "---" || heading <= first) return [];
  const looksLikeSettings = lines.slice(first, heading).some((line) => /^\s*[\w-]+\s*:/.test(line));
  const message = "Text before the first AFM heading is ignored. Add an opening '---' if these are settings.";
  return [issue(looksLikeSettings ? "error" : "warning", message, "", first + 1)];
}
