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
import { compileTemplate, evaluateTemplate, TemplateError } from "./template";

const run = (template: string, payload: unknown = {}, headers: Record<string, string | string[] | undefined> = {}): string =>
  evaluateTemplate(compileTemplate(template), payload, headers);

describe("a prompt template", () => {
  it("keeps plain text and any variable that is not an http one", () => {
    expect(run("no variables here")).toBe("no variables here");
    expect(run("key is ${env:KEY} and ${other}")).toBe("key is ${env:KEY} and ${other}");
    expect(run("")).toBe("");
  });

  it("keeps text after a ${ that is never closed", () => {
    expect(run("a ${http:payload.x and more")).toBe("a ${http:payload.x and more");
  });

  it("puts in a field of the payload, and a whole non-text value as JSON", () => {
    const payload = { event: "push", count: 3, ok: true, nothing: null, tags: ["a", "b"], repo: { name: "afm" } };
    expect(run("${http:payload.event}", payload)).toBe("push");
    expect(run("${http:payload.count}/${http:payload.ok}/${http:payload.nothing}", payload)).toBe("3/true/null");
    expect(run("${http:payload.tags}", payload)).toBe('["a","b"]');
    expect(run("${http:payload.repo}", payload)).toBe('{"name":"afm"}');
  });

  it("puts in the whole payload as JSON", () => {
    expect(run("got ${http:payload}", { a: 1 })).toBe('got {"a":1}');
  });

  it("follows dots, quoted brackets and array positions", () => {
    const payload = { repo: { name: "afm" }, "nested.field": "dotted", list: [{ id: 7 }, { id: 8 }] };
    expect(run("${http:payload.repo.name}", payload)).toBe("afm");
    expect(run("${http:payload['nested.field']}", payload)).toBe("dotted");
    expect(run('${http:payload["nested.field"]}', payload)).toBe("dotted");
    expect(run("${http:payload.list[1].id}", payload)).toBe("8");
    expect(run("${http:payload['repo']['name']}", payload)).toBe("afm");
  });

  it("finds a header whatever its case, and joins repeated ones", () => {
    expect(run("${http:header.X-GitHub-Event}", {}, { "x-github-event": "push" })).toBe("push");
    expect(run("${http:header.user-agent}", {}, { "User-Agent": "curl" })).toBe("curl");
    expect(run("${http:header.Accept}", {}, { accept: ["a", "b"] })).toBe("a, b");
  });

  it("fails clearly for a field, position or header that is not there", () => {
    expect(() => run("${http:payload.missing}", { a: 1 })).toThrow(/Cannot resolve payload variable '\${http:payload.missing}': Field 'missing' not found/);
    expect(() => run("${http:payload.a.b}", { a: "text" })).toThrow(/on non-object/);
    expect(() => run("${http:payload[0]}", { a: 1 })).toThrow(/on non-array/);
    expect(() => run("${http:payload.list[2]}", { list: [1] })).toThrow(/out of bounds/);
    expect(() => run("${http:payload.list[-1]}", { list: [1] })).toThrow(/out of bounds/);
    expect(() => run("${http:payload.list[x]}", { list: [1] })).toThrow(/Invalid array index/);
    expect(() => run("${http:payload.list[1}", { list: [1] })).toThrow(TemplateError);
    expect(() => run("${http:payload.a..b}", { a: { b: 1 } })).toThrow(/Empty field name/);
    expect(() => run("${http:header.X-Missing}", {}, { a: "b" })).toThrow(/header not found/);
    expect(() => run("${http:header.A}", {}, { a: undefined })).toThrow(/header not found/);
  });

  it("never reaches the built-in properties of an object", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(() => run(`\${http:payload.${name}}`, { a: 1 })).toThrow(/not found/);
      expect(() => run(`\${http:payload['${name}']}`, { a: 1 })).toThrow(/not found/);
    }
  });

  it("refuses a badly written http variable when the template is compiled", () => {
    expect(() => compileTemplate("${http:payload.}")).toThrow(/Invalid http variable format/);
    expect(() => compileTemplate("${http:header.}")).toThrow(/Invalid http variable format/);
    expect(() => compileTemplate("${http:body.x}")).toThrow(/Unknown http variable prefix: body/);
    expect(() => compileTemplate("${http:}")).toThrow(/Unknown http variable prefix/);
  });

  it("does not look into what it put in", () => {
    expect(run("${http:payload.a} ${http:payload.b}", { a: "${http:payload.b}", b: "x" })).toBe("${http:payload.b} x");
  });
});
