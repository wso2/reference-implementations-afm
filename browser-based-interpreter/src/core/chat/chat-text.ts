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

import { type UserContent } from "@afm/runtime";
import { type ImageAttachment } from "../runtime/protocol";

export function userContent(text: string, images?: ImageAttachment[]): UserContent {
  if (images === undefined || images.length === 0) return text;
  return [
    ...(text.trim() !== "" ? [{ type: "text" as const, text }] : []),
    ...images.map((image) => ({ type: "image" as const, image: image.data, mediaType: image.mediaType })),
  ];
}

export const OPENERS = [
  "What can you help me with?",
  "What should I know before I start?",
  "Give me an example of something you do well.",
] as const;

export function selfDescription(description: string, role: string): string {
  const said = description.trim();
  if (said !== "") return said;

  const first =
    role
      .trim()
      .split(/(?<=[.!?])\s+/)[0]
      ?.trim() ?? "";
  if (first === "") return "";
  return first
    .replace(/^You are\b/i, "I am")
    .replace(/^You\b/i, "I")
    .replace(/\byour\b/gi, "my")
    .replace(/\byou\b/gi, "me");
}

export function agentInitial(name: string): string {
  const letter = name
    .trim()
    .replace(/[^A-Za-z0-9]/g, "")
    .charAt(0);
  return letter === "" ? "A" : letter.toUpperCase();
}
