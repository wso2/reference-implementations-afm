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
import { checkSignature, inputText, isTextSchema, outputInstruction, outputValue, SchemaError, TEXT_SIGNATURE } from "./signature";

const weather = {
  type: "object",
  properties: { city: { type: "string", minLength: 2 }, days: { type: "integer", minimum: 1, maximum: 5 } },
  required: ["city"],
  additionalProperties: false,
};
const forecast = { type: "object", properties: { summary: { type: "string" }, degrees: { type: "number" } }, required: ["summary"] };

const fails = (run: () => unknown, source: "input" | "output", message: RegExp) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as SchemaError).source).toBe(source);
    expect((error as SchemaError).message).toMatch(message);
    return;
  }
  throw new Error("it did not fail");
};

describe("isTextSchema", () => {
  it("is true for a string schema, whatever else it says, and false for anything else", () => {
    expect(isTextSchema({ type: "string" })).toBe(true);
    expect(isTextSchema({ type: "string", minLength: 3 })).toBe(true);
    expect(isTextSchema({ type: "object" })).toBe(false);
    expect(isTextSchema({ type: ["string", "null"] })).toBe(false);
    expect(isTextSchema(true)).toBe(false);
    expect(isTextSchema(TEXT_SIGNATURE.input)).toBe(true);
  });
});

describe("inputText", () => {
  it("passes text through, and turns a value into JSON for the model", () => {
    expect(inputText("hello", { type: "string" })).toBe("hello");
    expect(inputText({ city: "Paris", days: 3 }, weather)).toBe('{"city":"Paris","days":3}');
    expect(inputText([1, 2], { type: "array", items: { type: "number" } })).toBe("[1,2]");
    expect(inputText(7, { type: "number" })).toBe("7");
  });

  it("refuses input that does not fit the schema, and says where", () => {
    fails(() => inputText({ days: 3 }, weather), "input", /city/);
    fails(() => inputText({ city: "P" }, weather), "input", /city: .*2 characters/);
    fails(() => inputText({ city: "Paris", days: 9 }, weather), "input", /days: .*5/);
    fails(() => inputText({ city: "Paris", extra: 1 }, weather), "input", /Unrecognized key/);
    fails(() => inputText("text", weather), "input", /expected object/);
    fails(() => inputText({ city: "Paris", days: "3" }, weather), "input", /days/);
    fails(() => inputText("ab", { type: "string", minLength: 3 }), "input", /3 characters/);
  });

  it("understands enums, alternatives and nested lists", () => {
    expect(inputText("a", { enum: ["a", "b"] })).toBe("a");
    fails(() => inputText("c", { enum: ["a", "b"] }), "input", /./);
    expect(inputText(1, { anyOf: [{ type: "string" }, { type: "number" }] })).toBe("1");
    fails(() => inputText(true, { anyOf: [{ type: "string" }, { type: "number" }] }), "input", /./);
    fails(() => inputText({ tags: [1] }, { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } }), "input", /tags\.0/);
  });
});

describe("outputInstruction", () => {
  it("is empty for text, and otherwise asks for JSON in a code block that fits the schema", () => {
    expect(outputInstruction({ type: "string" })).toBe("");
    const text = outputInstruction(forecast);
    expect(text).toContain("The final response MUST conform to the following JSON schema:");
    expect(text).toContain(JSON.stringify(forecast, null, 2));
    expect(text).toContain("Respond only with the JSON value enclosed between ``` and ```.");
  });
});

describe("outputValue", () => {
  const good = '{"summary":"sunny","degrees":21.5}';

  it("returns text as it is when the output is text", () => {
    expect(outputValue("  just words  ", { type: "string" })).toBe("  just words  ");
  });

  it("reads JSON from a json code block, from a plain code block, or from bare JSON", () => {
    expect(outputValue(`Here you go\n\`\`\`json\n${good}\n\`\`\`\nbye`, forecast)).toEqual({ summary: "sunny", degrees: 21.5 });
    expect(outputValue(`\`\`\`\n${good}\n\`\`\``, forecast)).toEqual({ summary: "sunny", degrees: 21.5 });
    expect(outputValue(`  ${good}  `, forecast)).toEqual({ summary: "sunny", degrees: 21.5 });
  });

  it("prefers a json block over an earlier plain one, and takes the first closed block", () => {
    const reply = `\`\`\`\nnot json\n\`\`\`\n\`\`\`json\n${good}\n\`\`\``;
    expect(outputValue(reply, forecast)).toEqual({ summary: "sunny", degrees: 21.5 });
    expect(outputValue(`\`\`\`\n{"summary":"a"}\n\`\`\` \`\`\`\n{"summary":"b"}\n\`\`\``, forecast)).toEqual({ summary: "a" });
  });

  it("falls back to the whole reply when a code block is never closed", () => {
    fails(() => outputValue(`\`\`\`json\n${good}`, forecast), "output", /Failed to parse response as JSON/);
  });

  it("refuses a reply that is not JSON, or that does not fit the schema", () => {
    fails(() => outputValue("I cannot do that", forecast), "output", /Failed to parse response as JSON/);
    fails(() => outputValue('{"degrees":3}', forecast), "output", /summary/);
    fails(() => outputValue('{"summary":5}', forecast), "output", /summary/);
  });

  it("works for values that are not objects", () => {
    expect(outputValue("[1,2,3]", { type: "array", items: { type: "number" } })).toEqual([1, 2, 3]);
    expect(outputValue("42", { type: "number" })).toBe(42);
    expect(outputValue("true", { type: "boolean" })).toBe(true);
    fails(() => outputValue('["a"]', { type: "array", items: { type: "number" } }), "output", /0/);
  });

  it("does not take long over a reply with a lot of white space and no closing fence", () => {
    const started = Date.now();
    expect(() => outputValue("```json" + " ".repeat(200_000), forecast)).toThrow(/Failed to parse response as JSON/);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("checkSignature", () => {
  it("accepts schemas it can use, and names the side and the interface of one it cannot", () => {
    expect(() => checkSignature({ input: weather, output: forecast }, "webchat")).not.toThrow();
    expect(() => checkSignature({ input: { type: "nonsense" }, output: forecast }, "webchat")).toThrow(/The input schema of the webchat interface is not valid/);
    expect(() => checkSignature({ input: weather, output: { type: "object", properties: { a: { $ref: "#/$defs/missing" } } } }, "consolechat")).toThrow(/The output schema of the consolechat interface is not valid/);
  });
});
