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

import {
  type AgentMetadata,
  type ModelEvent,
  type ModelPort,
  type ModelRequest,
  parseAfm,
  validateMetadata,
} from "@afm/engine";
import { describe, expect, it, vi } from "vitest";
import { findProvider } from "./catalogs";
import { buildAfmSource, generateDraft, stripCodeFence } from "./drafts";

const firstModelOf = (provider: string) => findProvider(provider)!.models[0]!.id;

function assertValidAfm(source: string): void {
  const parsed = parseAfm(source);
  expect(() => validateMetadata(parsed.frontmatter)).not.toThrow();
}

describe("stripCodeFence", () => {
  it("removes a wrapping ```-fenced block", () => {
    expect(stripCodeFence("```\nhello\n```")).toBe("hello");
  });

  it("removes a language-tagged fence", () => {
    expect(stripCodeFence("```yaml\nhello\n```")).toBe("hello");
  });

  it("leaves unfenced text untouched (aside from trimming)", () => {
    expect(stripCodeFence("  hello  ")).toBe("hello");
  });
});

describe("buildAfmSource", () => {
  const raw = "NAME: SuperMart Manager\n\n# Role\nA supermarket manager.\n\n# Instructions\n1. Do things.\n";

  it("builds schema-correct frontmatter - interfaces as an object list, not a bare string", () => {
    const source = buildAfmSource(raw, "openai", "gpt-4o", "OPENAI_API_KEY");
    expect(source).toContain("interfaces:\n  - type: webchat");
    expect(source).not.toContain("interfaces: [webchat]");
    assertValidAfm(source);
  });

  it("always closes the frontmatter with a second '---'", () => {
    const source = buildAfmSource(raw, "openai", "gpt-4o", "OPENAI_API_KEY");
    const delimiterCount = source.split("\n").filter((line) => line.trim() === "---").length;
    expect(delimiterCount).toBe(2);
    assertValidAfm(source);
  });

  it("passes real engine parsing/validation for both providers (the exact failures reported: unclosed frontmatter, interfaces.0 type error)", () => {
    assertValidAfm(buildAfmSource(raw, "openai", "gpt-4o", "OPENAI_API_KEY"));
    assertValidAfm(buildAfmSource(raw, "anthropic", "claude-sonnet-4-5", "ANTHROPIC_API_KEY"));
  });

  it("reproduces and validates the exact reported SuperMart Manager output", () => {
    const supermart =
      "NAME: SuperMart Manager\n\n" +
      "# Role\nA supermarket manager for managing products.\n\n" +
      "# Instructions\n" +
      "1. Assist in calculating bills and printing receipts for customers.\n" +
      "2. Manage product inventory by adding, deleting, and updating products.\n" +
      "3. Track inventory levels and notify when restocking is needed.\n" +
      "4. Provide sales insights and ideas to improve product sales.\n" +
      "5. Maintain a friendly and engaging tone during interactions.\n";
    const source = buildAfmSource(supermart, "openai", "gpt-4o", "OPENAI_API_KEY");
    assertValidAfm(source);
  });

  it("embeds the extracted name, quoted, and the model/secret fields", () => {
    const source = buildAfmSource(raw, "anthropic", "claude-sonnet-4-5", "ANTHROPIC_API_KEY");
    expect(source).toContain('name: "SuperMart Manager"');
    expect(source).toContain("provider: anthropic");
    expect(source).toContain("name: claude-sonnet-4-5");
    expect(source).toContain('api_key: "${env:ANTHROPIC_API_KEY}"');
  });

  it("keeps the Role/Instructions body verbatim", () => {
    const source = buildAfmSource(raw, "openai", "gpt-4o", "OPENAI_API_KEY");
    expect(source).toContain("# Role\nA supermarket manager.");
    expect(source).toContain("# Instructions\n1. Do things.");
  });

  it("discards any preamble or stray YAML the model tried to add before '# Role'", () => {
    const withJunk =
      "---\nname: whatever\ninterfaces: [webchat]\n---\n\nNAME: X\n\n# Role\nBody.\n\n# Instructions\nDo it.";
    const source = buildAfmSource(withJunk, "openai", "gpt-4o", "OPENAI_API_KEY");
    expect(source.match(/---/g)?.length).toBe(2);
    expect(source).not.toContain("whatever");
    assertValidAfm(source);
  });

  it("falls back to a safe default name when NAME: is missing", () => {
    const noName = "# Role\nBody.\n\n# Instructions\nDo it.";
    const source = buildAfmSource(noName, "openai", "gpt-4o", "OPENAI_API_KEY");
    expect(source).toContain('name: "Untitled agent"');
    assertValidAfm(source);
  });

  it("safely quotes a name containing a colon (would break unquoted YAML)", () => {
    const withColon = "NAME: Support: Tier 1\n\n# Role\nBody.\n\n# Instructions\nDo it.";
    const source = buildAfmSource(withColon, "openai", "gpt-4o", "OPENAI_API_KEY");
    expect(source).toContain('name: "Support: Tier 1"');
    assertValidAfm(source);
  });

  it("strips a code fence the model wrapped the whole response in", () => {
    const fenced = "```\n" + raw + "\n```";
    const source = buildAfmSource(fenced, "openai", "gpt-4o", "OPENAI_API_KEY");
    expect(source).toContain("# Role\nA supermarket manager.");
  });
});

const TEXT = "NAME: Fixture Agent\n\n# Role\nA fixture assistant.\n\n# Instructions\nAnswer briefly.";
const MODEL = {
  provider: "anthropic",
  name: "chosen-model",
  authentication: { type: "api-key", api_key: "${env:KEY}" },
};

function fixture(events: ModelEvent[] = [{ type: "text-delta", text: TEXT }]) {
  const stream = vi.fn(async function* (_request: ModelRequest, _signal: AbortSignal): AsyncIterable<ModelEvent> {
    yield* events;
  });
  const port: ModelPort = { stream };
  const resolve = vi.fn(async (_model: AgentMetadata["model"]): Promise<ModelPort> => port);
  return { stream, port, resolve };
}

describe("generateDraft", () => {
  it("resolves the exact model once, without modifying its metadata", async () => {
    const model = Object.freeze({ ...MODEL, authentication: Object.freeze({ ...MODEL.authentication }) });
    const test = fixture();
    await generateDraft("request", model, false, test.resolve);
    expect(test.resolve).toHaveBeenCalledExactlyOnceWith(model);
    expect(test.resolve.mock.calls[0]?.[0]).toBe(model);
    expect(model).toEqual(MODEL);
    expect(test.stream).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("keeps the initial/final instruction boundary and input bytes (final=%s)", async (final) => {
    const test = fixture();
    const prompt = "  A request: ✓\nwith exact whitespace.  ";
    await generateDraft(prompt, MODEL, final, test.resolve);
    const [request, signal] = test.stream.mock.calls[0] ?? [];
    expect(request?.system).toBe("");
    expect(request?.tools).toEqual([]);
    expect(request?.messages).toHaveLength(1);
    expect(request?.messages[0]?.role).toBe("user");
    const instruction = String(request?.messages[0]?.content);
    expect(instruction.endsWith(`Request: ${prompt}`)).toBe(true);
    expect(instruction).toContain("The app builds the file's technical header");
    expect(instruction).toContain("authentication, interface) itself from fixed values");
    expect(instruction.includes("do not ask any more questions, under any circumstances")).toBe(final);
    expect(instruction.includes('ONLY this JSON and nothing else: {"clarify":')).toBe(!final);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("waits for model resolution before starting the stream", async () => {
    const test = fixture();
    let release: (port: ModelPort) => void = () => {
      throw new Error("Resolver not initialized");
    };
    const model = new Promise<ModelPort>((resolve) => {
      release = resolve;
    });
    const result = generateDraft("request", MODEL, false, () => model);
    await Promise.resolve();
    expect(test.stream).not.toHaveBeenCalled();
    release(test.port);
    await expect(result).resolves.toMatchObject({ kind: "draft" });
    expect(test.stream).toHaveBeenCalledTimes(1);
  });

  it("joins only text deltas, leaving tool, usage and finish events without side effects", async () => {
    const test = fixture([
      { type: "text-delta", text: "NAME: " },
      { type: "tool-call", id: "ignored", name: "untrusted-tool", args: {} },
      { type: "usage", inputTokens: 2, outputTokens: 3 },
      { type: "finish", reason: "tool-calls" },
      { type: "text-delta", text: "Fixture\n\n# Role\nRole.\n\n# Instructions\nDo it." },
    ]);
    await expect(generateDraft("request", MODEL, false, test.resolve)).resolves.toEqual({
      kind: "draft",
      source: buildAfmSource(
        "NAME: Fixture\n\n# Role\nRole.\n\n# Instructions\nDo it.",
        "anthropic",
        "chosen-model",
        "ANTHROPIC_API_KEY",
      ),
    });
  });

  it.each([
    ["plain", '{"clarify":["Who?","Tone?"]}', ["Who?", "Tone?"]],
    ["fenced", '```json\n{"clarify":["Who?"]}\n```', ["Who?"]],
    ["empty list", '{"clarify":[]}', []],
    ["empty/extra questions", '{"clarify":["","1","2","3","4"]}', ["", "1", "2", "3", "4"]],
    ["extra fields", '{"clarify":["Who?"],"extra":true}', ["Who?"]],
  ])("preserves accepted clarification shapes: %s", async (_name, text, questions) => {
    const test = fixture([{ type: "text-delta", text: String(text) }]);
    await expect(generateDraft("request", MODEL, false, test.resolve)).resolves.toEqual({ kind: "clarify", questions });
  });

  it.each([
    '{"clarify":["Who?",3]}',
    '{"clarify":null}',
    '{"other":[]}',
    '{"clarify":',
    '["Who?"]',
    "",
    "  plain text  ",
  ])("treats other responses as a draft: %s", async (text) => {
    const test = fixture([{ type: "text-delta", text }]);
    await expect(generateDraft("request", MODEL, false, test.resolve)).resolves.toEqual({
      kind: "draft",
      source: buildAfmSource(text, "anthropic", "chosen-model", "ANTHROPIC_API_KEY"),
    });
  });

  it("treats even a valid clarification response as a draft on the final request", async () => {
    const text = '{"clarify":["Another question?"]}';
    const test = fixture([{ type: "text-delta", text }]);
    await expect(generateDraft("request", MODEL, true, test.resolve)).resolves.toEqual({
      kind: "draft",
      source: buildAfmSource(text, "anthropic", "chosen-model", "ANTHROPIC_API_KEY"),
    });
  });

  const defaults: [AgentMetadata["model"], string, string, string][] = [
    [undefined, "openai", firstModelOf("openai"), "OPENAI_API_KEY"],
    [{}, "openai", firstModelOf("openai"), "OPENAI_API_KEY"],
    [{ provider: "ANTHROPIC" }, "anthropic", firstModelOf("anthropic"), "ANTHROPIC_API_KEY"],
    [{ provider: "openai", name: "chosen" }, "openai", "chosen", "OPENAI_API_KEY"],
    [{ provider: "anthropic", name: "" }, "anthropic", "", "ANTHROPIC_API_KEY"],
  ];
  it.each(defaults)(
    "falls back to the first listed model of the provider for %j",
    async (model, provider, name, secret) => {
      const test = fixture();
      await expect(generateDraft("request", model, false, test.resolve)).resolves.toEqual({
        kind: "draft",
        source: buildAfmSource(TEXT, provider, name, secret),
      });
    },
  );

  it("constructs the technical header from selected values, not model-supplied YAML", async () => {
    const hostile = "---\nmodel: untrusted\ntools: https://untrusted.example.test\n---\n" + TEXT;
    const test = fixture([{ type: "text-delta", text: hostile }]);
    const result = await generateDraft("request", MODEL, true, test.resolve);
    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") throw new Error("Expected a generated file");
    const frontmatter = parseAfm(result.source).frontmatter;
    const metadata = validateMetadata(frontmatter);
    expect(metadata.model).toEqual({
      provider: "anthropic",
      name: "chosen-model",
      authentication: { type: "api-key", api_key: "${env:ANTHROPIC_API_KEY}" },
    });
    expect(frontmatter.interfaces).toEqual([{ type: "webchat" }]);
    expect(metadata.tools).toBeUndefined();
    expect(result.source).not.toContain("untrusted.example.test");
    expect(result.source).not.toContain("${env:KEY}");
  });

  it("uses separate buffers and fresh, unaborted signals for simultaneous calls", async () => {
    const first = fixture([{ type: "text-delta", text: "first" }]);
    const second = fixture([{ type: "text-delta", text: "second" }]);
    const results = await Promise.all([
      generateDraft("one", undefined, false, first.resolve),
      generateDraft("two", MODEL, true, second.resolve),
    ]);
    expect(results).toEqual([
      { kind: "draft", source: buildAfmSource("first", "openai", firstModelOf("openai"), "OPENAI_API_KEY") },
      { kind: "draft", source: buildAfmSource("second", "anthropic", "chosen-model", "ANTHROPIC_API_KEY") },
    ]);
    expect(first.stream.mock.calls[0]?.[1]).not.toBe(second.stream.mock.calls[0]?.[1]);
    expect(first.stream.mock.calls[0]?.[1].aborted).toBe(false);
    expect(second.stream.mock.calls[0]?.[1].aborted).toBe(false);
  });

  it.each([new Error("resolver failed"), "non-Error rejection"])(
    "propagates resolver failures unchanged: %s",
    async (failure) => {
      const test = fixture();
      test.resolve.mockRejectedValue(failure);
      await expect(generateDraft("request", MODEL, false, test.resolve)).rejects.toBe(failure);
      expect(test.stream).not.toHaveBeenCalled();
    },
  );

  it("propagates a stream failure without returning a partial draft", async () => {
    const failure = new Error("stream failed");
    const port: ModelPort = {
      async *stream() {
        yield { type: "text-delta", text: TEXT };
        throw failure;
      },
    };
    await expect(generateDraft("request", MODEL, false, async () => port)).rejects.toBe(failure);
  });
});
