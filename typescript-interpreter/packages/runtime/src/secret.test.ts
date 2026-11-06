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

import { describe, it, expect } from "vitest";
import { configSecretPort } from "./secret";
import type { SecretRef } from "@afm/engine";

const ref = (name: string): SecretRef => ({ prefix: "env", name, raw: `\${env:${name}}` });

describe("configSecretPort", () => {
  it("resolves a known value", async () => {
    const port = configSecretPort({ API_KEY: "sk-1" });
    expect(await port.resolve(ref("API_KEY"))).toEqual({ status: "resolved", value: "sk-1" });
  });

  it.each(["constructor", "toString", "__proto__"])("does not read the built-in %s as a value", async (name) => {
    const port = configSecretPort({});
    expect((await port.resolve(ref(name))).status).toBe("unresolved");
  });

  it("is unresolved for missing or empty values", async () => {
    const port = configSecretPort({ EMPTY: "" });
    expect((await port.resolve(ref("EMPTY"))).status).toBe("unresolved");
    expect((await port.resolve(ref("NOPE"))).status).toBe("unresolved");
  });
});

describe("configSecretPort as a live session store", () => {
  it("sees values added after the port was created", async () => {
    const session: Record<string, string> = {};
    const port = configSecretPort(session);

    expect(await port.resolve({ prefix: "env", name: "OPENAI_API_KEY", raw: "" })).toMatchObject({
      status: "unresolved",
    });

    session.OPENAI_API_KEY = "sk-typed-at-consent-time";

    expect(await port.resolve({ prefix: "env", name: "OPENAI_API_KEY", raw: "" })).toEqual({
      status: "resolved",
      value: "sk-typed-at-consent-time",
    });
  });

  it("sees values removed again", async () => {
    const session: Record<string, string> = { HF_TOKEN: "hf-1" };
    const port = configSecretPort(session);
    delete session.HF_TOKEN;
    expect(await port.resolve({ prefix: "env", name: "HF_TOKEN", raw: "" })).toMatchObject({
      status: "unresolved",
    });
  });
});
