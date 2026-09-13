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

const NOT_AN_END = /\b(e\.g|i\.e|etc|vs|approx|no|fig|mr|mrs|ms|dr|prof|st|jr|sr)\.$/i;

export function sentences(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const piece of text.split(/(?<=[.!?])\s+/)) {
    current = current === "" ? piece : `${current} ${piece}`;
    if (!NOT_AN_END.test(current.trim()) && !/(?:^|\s)\d+\.$/.test(current.trim())) {
      out.push(current.trim());
      current = "";
    }
  }
  if (current.trim() !== "") out.push(current.trim());
  return out.filter((entry) => entry !== "");
}

const STRUCTURED_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s?|\||`{3,}|~{3,}|(?:-{3,}|\*{3,}|_{3,})\s*$)/;
const TABLE_RULE = /^\s*(?:\|\s*)?:?-+:?\s*(?:\|\s*:?-+:?\s*)+(?:\|\s*)?$/;

function isStructured(block: string[]): boolean {
  return block.some((line) => STRUCTURED_LINE.test(line) || TABLE_RULE.test(line));
}

function blocksOf(markdown: string): string[] {
  const blocks: string[] = [];
  let lines: string[] = [];
  let fence: string | null = null;
  const finish = () => {
    if (lines.length > 0) blocks.push(lines.join("\n"));
    lines = [];
  };
  for (const line of markdown.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] ?? null;
    if (fence === null && line.trim() === "") finish();
    else {
      lines.push(line);
      if (fence === null) fence = marker;
      else if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    }
  }
  finish();
  return blocks;
}

export function tidyIntoBullets(markdown: string): string {
  const out = blocksOf(markdown).map((block) => {
    const lines = block.split("\n");
    if (isStructured(lines)) return block;

    const paragraph = lines.join(" ").replace(/\s+/g, " ").trim();
    if (paragraph === "") return block;

    const parts = sentences(paragraph);
    if (parts.length < 2) return paragraph;
    return parts.map((part) => `- ${part}`).join("\n");
  });
  return out.join("\n\n").trim();
}

export function canTidy(markdown: string): boolean {
  return tidyIntoBullets(markdown) !== markdown.trim();
}
