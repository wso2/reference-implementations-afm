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

import { describe, expect, it } from "vitest";
import { setFrontmatterValue } from "./agent-source-edit";
import { buildableAgent } from "./agent-validation";
import { findProvider, LICENSES, MODEL_PROVIDERS, shortModelLabel } from "./catalogs";

describe("the model catalogue", () => {
  it("finds a provider by id, and reports one it does not know", () => {
    expect(findProvider("anthropic")?.secretName).toBe("ANTHROPIC_API_KEY");
    expect(findProvider("mystery")).toBeUndefined();
  });

  it("names every provider's key differently, so saving one never overwrites another", () => {
    const names = MODEL_PROVIDERS.map((provider) => provider.secretName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every provider at least one model, each with its own id", () => {
    for (const provider of MODEL_PROVIDERS) {
      const ids = provider.models.map((model) => model.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("shortens a known model and leaves an unlisted one as it is", () => {
    expect(shortModelLabel("gpt-4o-mini")).toBe("GPT-4o mini");
    expect(shortModelLabel("some-new-model")).toBe("some-new-model");
  });

  describe("OpenAI", () => {
    const openai = findProvider("openai")!;
    const ids = openai.models.map((model) => model.id);

    it("lists the six newest models first, the balanced one leading", () => {
      expect(ids.slice(0, 6)).toEqual([
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
      ]);
    });

    it("starts from the balanced model wherever the first model is the default", () => {
      expect(openai.models[0]?.id).toBe("gpt-6.1-sol");
    });

    it("still lists the older models, so an agent that names one keeps its label", () => {
      expect(ids).toEqual(expect.arrayContaining(["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"]));
      expect(shortModelLabel("gpt-4o")).toBe("GPT-4o");
    });

    it("gives each new model a label that reads like its id", () => {
      expect(shortModelLabel("gpt-6-astra")).toBe("GPT-6 Astra");
      expect(shortModelLabel("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
      expect(shortModelLabel("gpt-5.6-terra")).toBe("GPT-5.6 Terra");
    });

    it("writes every id in a form a file and an address can carry", () => {
      for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
    });
  });
});

describe("LICENSES", () => {
  it("lists each license once, with a note", () => {
    expect(new Set(LICENSES.map((license) => license.id)).size).toBe(LICENSES.length);
    for (const license of LICENSES) expect(license.note).not.toBe("");
  });

  it("writes every choice into a file that reads back as that license", () => {
    for (const license of LICENSES) {
      const next = setFrontmatterValue("---\nname: A\n---\n\n# Role\nr\n", "license", license.id);
      expect(next).toContain(`license: ${license.id}`);
      const read = buildableAgent(next);
      expect(read.ok && read.metadata.license).toBe(license.id);
    }
  });
});
