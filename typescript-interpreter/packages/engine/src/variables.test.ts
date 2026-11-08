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
import { VariableResolutionError } from "./errors";
import { fakeSecrets } from "./test-support";
import type { SecretPort } from "./types";
import { resolveVariables } from "./variables";

describe("resolveVariables", () => {
  it("fills ${env:NAME} from the SecretPort", async () => {
    const out = await resolveVariables({ token: "${env:API_KEY}" }, fakeSecrets({ API_KEY: "sk-123" }));
    expect(out).toEqual({ token: "sk-123" });
  });

  it("treats a no-prefix ${NAME} as env", async () => {
    const out = await resolveVariables({ x: "x ${FOO} y" }, fakeSecrets({ FOO: "bar" }));
    expect(out).toEqual({ x: "x bar y" });
  });

  it("resolves multiple references in one value", async () => {
    const out = await resolveVariables({ k: "${env:A}-${env:B}" }, fakeSecrets({ A: "1", B: "2" }));
    expect(out).toEqual({ k: "1-2" });
  });

  it("resolves inside nested maps and lists", async () => {
    const out = await resolveVariables(
      { model: { authentication: { api_key: "${env:KEY}" } }, tools: [{ url: "https://x/${env:KEY}" }, "${env:KEY}"] },
      fakeSecrets({ KEY: "k" }),
    );
    expect(out).toEqual({
      model: { authentication: { api_key: "k" } },
      tools: [{ url: "https://x/k" }, "k"],
    });
  });

  it("leaves values that are not text alone", async () => {
    const value = { count: 4, enabled: true, nothing: null };
    expect(await resolveVariables(value, fakeSecrets({}))).toEqual(value);
  });

  it("leaves ${http:...} untouched", async () => {
    const out = await resolveVariables({ p: "${http:payload.id}" }, fakeSecrets({}));
    expect(out).toEqual({ p: "${http:payload.id}" });
  });

  it("does not expand a value that itself looks like a reference", async () => {
    const out = await resolveVariables({ k: "${env:A}" }, fakeSecrets({ A: "${env:B}", B: "nope" }));
    expect(out).toEqual({ k: "${env:B}" });
  });

  it("asks for values one at a time, in file order", async () => {
    const asked: string[] = [];
    const secrets: SecretPort = {
      async resolve(ref) {
        asked.push(`${ref.name}:start`);
        await Promise.resolve();
        asked.push(`${ref.name}:end`);
        return { status: "resolved", value: ref.name };
      },
    };
    await resolveVariables({ first: "${A}", nested: { second: "${B}" }, list: ["${C}"] }, secrets);
    expect(asked).toEqual(["A:start", "A:end", "B:start", "B:end", "C:start", "C:end"]);
  });

  it("throws on an unknown prefix", async () => {
    await expect(resolveVariables({ k: "${vault:X}" }, fakeSecrets({ X: "v" }))).rejects.toThrow(
      VariableResolutionError,
    );
    await expect(resolveVariables({ k: "${vault:X}" }, fakeSecrets({}))).rejects.toThrow(
      /Unsupported variable prefix/,
    );
  });

  it("throws when a value is missing", async () => {
    await expect(resolveVariables({ k: "${env:MISSING}" }, fakeSecrets({}))).rejects.toThrow(
      VariableResolutionError,
    );
  });

  it("treats an empty value as unresolved", async () => {
    await expect(resolveVariables({ k: "${env:EMPTY}" }, fakeSecrets({ EMPTY: "" }))).rejects.toThrow(
      VariableResolutionError,
    );
  });

  it("leaves text without variables unchanged", async () => {
    const out = await resolveVariables({ k: "nothing here" }, fakeSecrets({}));
    expect(out).toEqual({ k: "nothing here" });
  });
});
