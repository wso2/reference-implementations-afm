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

import { type AgentMetadata } from "@afm/engine";
import type { LanguageModel } from "@afm/runtime";
import { completeText } from "../runtime/complete-text";
import { DEFAULT_PROVIDER, findProvider } from "./catalogs";
import { secretReference } from "./secret-reference";

export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:[a-zA-Z]*\n)?([\s\S]*?)```$/.exec(trimmed);
  return fenced !== null ? fenced[1]!.trim() : trimmed;
}

function extractNameAndBody(raw: string): { name: string; body: string } {
  const nameMatch = /^NAME:\s*(.+)$/m.exec(raw);
  const name = nameMatch?.[1]?.trim() || "Untitled agent";
  const roleIndex = raw.search(/^#{1,6}\s*Role\b/m);
  const body = roleIndex === -1 ? raw.trim() : raw.slice(roleIndex).trim();
  return { name, body };
}

export function buildAfmSource(rawText: string, provider: string, modelName: string, secretName: string): string {
  const { name, body } = extractNameAndBody(stripCodeFence(rawText));
  const frontmatter = [
    "---",
    `name: ${JSON.stringify(name)}`,
    "model:",
    `  provider: ${provider}`,
    `  name: ${modelName}`,
    "  authentication:",
    "    type: api-key",
    `    api_key: "${secretReference(secretName)}"`,
    "interfaces:",
    "  - type: webchat",
    "---",
    "",
  ].join("\n");
  return `${frontmatter}${body}\n`;
}

type DraftResult = { kind: "draft"; source: string } | { kind: "clarify"; questions: string[] };

function clarifyingQuestions(text: string): string[] | null {
  if (!text.startsWith("{")) return null;
  try {
    const { clarify } = JSON.parse(text) as { clarify?: unknown };
    return Array.isArray(clarify) && clarify.every((question) => typeof question === "string") ? clarify : null;
  } catch {
    return null;
  }
}

export async function generateDraft(
  promptText: string,
  model: AgentMetadata["model"],
  final: boolean,
  resolveAuthoringModel: (model: AgentMetadata["model"]) => Promise<LanguageModel>,
): Promise<DraftResult> {
  const languageModel = await resolveAuthoringModel(model);
  const provider = (model?.provider ?? DEFAULT_PROVIDER).toLowerCase();
  const catalog = findProvider(provider);
  const modelName = model?.name ?? catalog?.models[0]?.id ?? "";
  const secretName = catalog?.secretName ?? "";
  const fileSpec =
    "When you're ready to generate, reply with ONLY this - no YAML, no frontmatter, no code " +
    "fences, no commentary. The app builds the file's technical header (model, provider, " +
    "authentication, interface) itself from fixed values; you never write it and never " +
    "mention it:\n" +
    "NAME: <a short agent name>\n\n" +
    "# Role\n<1-2 sentences describing what the agent is>\n\n" +
    "# Instructions\n<clear, step-by-step instructions for what it should do>";
  const instruction = final
    ? "You write AFM agent files. The user has already answered your follow-up questions " +
      `below - do not ask any more questions, under any circumstances. ${fileSpec}\n\n` +
      `Request: ${promptText}`
    : "You write AFM agent files. First decide: is this request specific enough to write a " +
      "genuinely useful agent (clear purpose, tone, and what it should and shouldn't do)? " +
      "Only ask about the agent's purpose, behavior, tone, or content/domain needs - never " +
      "about the AI model, provider, or interface, since those are fixed by the app, not " +
      "something you or the user decide here. If something important is missing, reply with " +
      'ONLY this JSON and nothing else: {"clarify": ["question 1", "question 2"]} - 1 to 3 ' +
      "short, concrete questions.\n" +
      `Otherwise, ${fileSpec}\n\n` +
      `Request: ${promptText}`;
  const text = await completeText(languageModel, instruction);
  const questions = final ? null : clarifyingQuestions(stripCodeFence(text));
  if (questions !== null) return { kind: "clarify", questions };
  return { kind: "draft", source: buildAfmSource(text, provider, modelName, secretName) };
}
