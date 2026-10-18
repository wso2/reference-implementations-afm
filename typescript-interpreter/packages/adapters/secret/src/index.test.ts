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
import { configSecretPort, promptSecretPort, chainSecretPort } from "./index";
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

describe("promptSecretPort", () => {
  it("resolves whatever the ask callback returns", async () => {
    const port = promptSecretPort(async () => "typed-value");
    expect(await port.resolve(ref("X"))).toEqual({ status: "resolved", value: "typed-value" });
  });

  it("is unresolved if the user cancels (null) or enters nothing", async () => {
    expect((await promptSecretPort(async () => null).resolve(ref("X"))).status).toBe("unresolved");
    expect((await promptSecretPort(async () => "").resolve(ref("X"))).status).toBe("unresolved");
  });
});

describe("chainSecretPort", () => {
  it("returns the first source that resolves", async () => {
    const chain = chainSecretPort(configSecretPort({}), configSecretPort({ K: "from-second" }));
    expect(await chain.resolve(ref("K"))).toEqual({ status: "resolved", value: "from-second" });
  });

  it("is unresolved when no source has it", async () => {
    const chain = chainSecretPort(configSecretPort({}), promptSecretPort(async () => null));
    expect((await chain.resolve(ref("K"))).status).toBe("unresolved");
  });

  it("stops at the first resolver (later sources are not consulted)", async () => {
    let askCalled = false;
    const chain = chainSecretPort(
      configSecretPort({ K: "v" }),
      promptSecretPort(async () => {
        askCalled = true;
        return "x";
      }),
    );
    await chain.resolve(ref("K"));
    expect(askCalled).toBe(false);
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

  it("resolves a session value ahead of the prompt in the chain", async () => {
    const session: Record<string, string> = { KEY: "from-session" };
    let asked = 0;
    const chain = chainSecretPort(
      configSecretPort(session),
      promptSecretPort(async () => {
        asked += 1;
        return "from-prompt";
      }),
    );

    expect(await chain.resolve({ prefix: "env", name: "KEY", raw: "" })).toEqual({
      status: "resolved",
      value: "from-session",
    });
    expect(asked).toBe(0);
  });
});
