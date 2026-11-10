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
import { AfmValidationError, VariableResolutionError } from "./errors";
import { checkHttpVariables, resolveText, resolveValues } from "./variables";

const parsed = (frontmatter: Record<string, unknown>, role = "r", instructions = "i") => ({ frontmatter, role, instructions });

describe("resolveText", () => {
  it("fills ${env:NAME} from the environment", () => {
    expect(resolveText("Bearer ${env:TOKEN}", { TOKEN: "abc" })).toBe("Bearer abc");
  });

  it("treats a no-prefix ${NAME} as env", () => {
    expect(resolveText("${TOKEN}", { TOKEN: "abc" })).toBe("abc");
  });

  it("resolves several references in one value", () => {
    expect(resolveText("${env:A}-${env:B}", { A: "1", B: "2" })).toBe("1-2");
  });

  it("leaves ${http:...} untouched", () => {
    expect(resolveText("${http:payload.id} ${env:A}", { A: "x" })).toBe("${http:payload.id} x");
  });

  it("does not expand a value that itself looks like a reference", () => {
    expect(resolveText("${env:A}", { A: "${env:B}", B: "nope" })).toBe("${env:B}");
  });

  it("puts the value in as it is, even when it holds replacement patterns", () => {
    expect(resolveText("${env:A}", { A: "$& $1 $$" })).toBe("$& $1 $$");
  });

  it("leaves text without variables unchanged", () => {
    expect(resolveText("nothing here", {})).toBe("nothing here");
  });

  it.each(["file", "secret", "other"])("throws on the unknown prefix %s:", (prefix) => {
    expect(() => resolveText(`\${${prefix}:X}`, { X: "1" })).toThrow(VariableResolutionError);
    expect(() => resolveText(`\${${prefix}:X}`, { X: "1" })).toThrow(/Only 'env:' and 'http:' are supported/);
  });

  it("throws when a value is missing, naming the variable", () => {
    expect(() => resolveText("${env:MISSING}", {})).toThrow(/'MISSING' is not set/);
  });

  it("treats an empty value as missing", () => {
    expect(() => resolveText("${env:EMPTY}", { EMPTY: "" })).toThrow(VariableResolutionError);
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("does not find %s on the object itself", (name) => {
    expect(() => resolveText(`\${env:${name}}`, {})).toThrow(/is not set/);
  });

  it("never puts a value in the error message", () => {
    const message = (() => {
      try {
        resolveText("${env:A} ${file:B}", { A: "SECRET-VALUE" });
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    })();
    expect(message).not.toContain("SECRET-VALUE");
  });
});

describe("resolveValues", () => {
  it("resolves inside nested maps and lists", () => {
    const out = resolveValues({ a: ["${env:X}", { b: "${env:Y}" }], c: 1, d: true, e: null }, { X: "1", Y: "2" });
    expect(out).toEqual({ a: ["1", { b: "2" }], c: 1, d: true, e: null });
  });

  it("does not change its input", () => {
    const input = { a: "${env:X}" };
    resolveValues(input, { X: "1" });
    expect(input).toEqual({ a: "${env:X}" });
  });
});

describe("checkHttpVariables", () => {
  it("allows ${http:...} in the prompt of a webhook and of a platform chat", () => {
    expect(() =>
      checkHttpVariables(
        parsed({
          interfaces: [
            { type: "webhook", prompt: "${http:payload.a} ${http:header.X-Event}" },
            { type: "platformchat", platform: "slack", mode: "notification", prompt: "${http:payload.b}" },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("accepts a file with no ${http:...} at all", () => {
    expect(() => checkHttpVariables(parsed({ name: "x", interfaces: [{ type: "consolechat" }] }))).not.toThrow();
  });

  it("rejects it in Role and Instructions, saying where", () => {
    expect(() => checkHttpVariables(parsed({}, "a ${http:payload.x}", "b ${http:payload.y}"))).toThrow(/found in: role, instructions/);
  });

  it("rejects it in other fields, with the path of each", () => {
    const file = parsed({
      name: "${http:payload.n}",
      model: { url: "https://x/${http:payload.m}" },
      tools: { mcp: [{ name: "s", transport: { type: "http", url: "https://s/mcp", authentication: { type: "bearer", token: "${http:header.Authorization}" } } }] },
    });
    expect(() => checkHttpVariables(file)).toThrow(AfmValidationError);
    expect(() => checkHttpVariables(file)).toThrow(/found in: name, model\.url, tools\.mcp\[0\]\.transport\.authentication\.token/);
  });

  it("rejects it in a prompt that belongs to an interface that does not take one", () => {
    expect(() => checkHttpVariables(parsed({ interfaces: [{ type: "consolechat", prompt: "${http:payload.x}" }] }))).toThrow(/interfaces\[0\]\.prompt/);
  });

  it("rejects it in a webhook field other than the prompt", () => {
    expect(() => checkHttpVariables(parsed({ interfaces: [{ type: "webhook", exposure: { http: { path: "/${http:payload.p}" } } }] }))).toThrow(/interfaces\[0\]\.exposure\.http\.path/);
  });
});
