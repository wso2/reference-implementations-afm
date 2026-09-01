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
import { hostOf } from "../links/load-paths";
import { setFrontmatterValue } from "./agent-source-edit";

const KEYS = {
  name: "name",
  description: "description",
  icon: "icon_url",
  version: "version",
  authors: "authors",
  provider: "provider",
  license: "license",
};

export type AboutField = keyof typeof KEYS;
export type AboutDraft = Record<AboutField, string>;

export const ABOUT_FIELDS = Object.keys(KEYS) as AboutField[];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function present(text: string | undefined): string | null {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

export function startingDraft(metadata: AgentMetadata | null): AboutDraft {
  return {
    name: present(metadata?.name) ?? "",
    description: present(metadata?.description) ?? "",
    icon: present(metadata?.icon_url) ?? "",
    version: present(metadata?.version) ?? "",
    authors: present(metadata?.authors?.join(", ")) ?? "",
    provider: present(metadata?.provider?.name) ?? "",
    license: present(metadata?.license) ?? "",
  };
}

export function applyAbout(content: string, start: AboutDraft, draft: AboutDraft, providerUrl: string): string {
  let next = content;
  for (const field of ABOUT_FIELDS.filter((name) => draft[name].trim() !== start[name])) {
    const text = draft[field].trim();
    const value =
      field === "authors"
        ? text
            .split(",")
            .map((author) => author.trim())
            .filter((author) => author !== "")
        : field === "provider"
          ? { name: text, url: providerUrl }
          : text;
    next = setFrontmatterValue(next, KEYS[field], value);
  }
  return next;
}

export function versionError(text: string): string | null {
  const version = text.trim();
  return version === "" || SEMVER.test(version) ? null : "Use MAJOR.MINOR.PATCH, like 1.0.0";
}

export function aboutRows(
  metadata: AgentMetadata | null,
): { field: AboutField; label: string; value: string | null }[] {
  const providerUrl = present(metadata?.provider?.url);
  return [
    { field: "version", label: "Version", value: present(metadata?.version) },
    { field: "authors", label: "Authors", value: present(metadata?.authors?.join(", ")) },
    {
      field: "provider",
      label: "Provider",
      value: present(metadata?.provider?.name) ?? (providerUrl === null ? null : hostOf(providerUrl)),
    },
    { field: "license", label: "License", value: present(metadata?.license) },
  ];
}
