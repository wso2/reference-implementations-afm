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
import { describe, expect, it } from "vitest";
import { previewAgent } from "../agent/agent-validation";
import {
  chipStatus,
  needsToRun,
  quietInRaw,
  readiness,
  type ReadinessInput,
  readinessSentence,
  runReason,
  serverNameByUrl,
} from "./readiness";

const MODEL = { provider: "openai", name: "gpt-4o" } as AgentMetadata["model"];

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    role: "You are a helpful assistant.",
    instructions: "Answer clearly.",
    metadata: { name: "A", model: MODEL },
    issues: [],
    status: "ready",
    current: false,
    failed: false,
    brokenServerIds: [],
    serverNameByUrl: new Map(),
    ...over,
  };
}

const sentence = (r: ReturnType<typeof readiness>) => `${r.lead}${r.subject ?? ""}${r.tail ?? ""}`;

describe("readiness", () => {
  it("says it is ready when nothing is missing", () => {
    const r = readiness(input());
    expect(r.tone).toBe("ok");
    expect(sentence(r)).toBe("Ready");
  });

  it("does not mention how many tools it has", () => {
    const metadata = {
      name: "A",
      model: MODEL,
      tools: {
        mcp: [
          { name: "web", transport: { type: "http", url: "u1" }, tool_filter: { allow: ["a", "b"] } },
          { name: "stock", transport: { type: "http", url: "u2" }, tool_filter: { allow: ["c"] } },
        ],
      },
    } as unknown as AgentMetadata;
    expect(sentence(readiness(input({ metadata })))).toBe("Ready");
  });

  it("names a missing role before anything else", () => {
    const r = readiness(input({ role: "   ", instructions: "" }));
    expect(r.tone).toBe("bad");
    expect(sentence(r)).toBe("Needs a role before it can run");
    expect(r.fix).toBeUndefined();
  });

  it("sends a missing model to the model panel", () => {
    const metadata = { name: "A", model: { provider: "openai", name: "" } } as AgentMetadata;
    const r = readiness(input({ metadata }));
    expect(r.fix).toBe("model");
    expect(sentence(r)).toBe("Needs a model before it can run - choose one");
  });

  it("words a missing role itself rather than repeating the validator", () => {
    const r = readiness(
      input({
        role: "",
        issues: [{ severity: "error", message: "Missing required '# Role' section", field: "", line: 3 }],
      }),
    );
    expect(sentence(r)).toBe("Needs a role before it can run");
  });

  it("sends any other file error to the file", () => {
    const r = readiness(
      input({ issues: [{ severity: "error", message: "tools.mcp must be a list", field: "tools", line: 8 }] }),
    );
    expect(r.fix).toBe("raw");
    expect(sentence(r)).toBe("Has a problem - tools.mcp must be a list");
  });

  it("ignores warnings", () => {
    const r = readiness(input({ issues: [{ severity: "warning", message: "no description", field: "", line: null }] }));
    expect(r.tone).toBe("ok");
  });

  it("reports the server that went quiet while running", () => {
    const r = readiness(
      input({
        status: "streaming",
        brokenServerIds: ["https://gh/mcp"],
        serverNameByUrl: new Map([["https://gh/mcp", "github"]]),
      }),
    );
    expect(r.tone).toBe("bad");
    expect(sentence(r)).toBe("Running - Github did not answer");
  });

  it("says it is running once the agent on screen has started", () => {
    expect(sentence(readiness(input({ current: true })))).toBe("Running");
  });

  it("goes back to ready when the file has changed since the run", () => {
    expect(sentence(readiness(input({ current: false })))).toBe("Ready");
  });

  it("does not call an agent that failed to start running", () => {
    expect(sentence(readiness(input({ current: false, failed: true, status: "not-ready" })))).not.toBe("Running");
  });

  it("says the agent did not start, and takes the person to the chat to see why", () => {
    const r = readiness(input({ failed: true, status: "not-ready" }));
    expect(r.tone).toBe("bad");
    expect(sentence(r)).toBe("Did not start - see why");
    expect(r.fix).toBe("chat");
  });

  it("leaves out a failure that belongs to an earlier version of the file", () => {
    expect(sentence(readiness(input({ failed: false, status: "not-ready" })))).toBe("Ready");
  });

  it("names a problem in the file before saying the agent did not start", () => {
    expect(sentence(readiness(input({ failed: true, status: "not-ready", role: "" })))).toBe(
      "Needs a role before it can run",
    );
  });

  it("says what a healthy run is doing", () => {
    expect(sentence(readiness(input({ status: "streaming" })))).toBe("Running - waiting on the model");
  });

  it("reports unreadable settings rather than guessing", () => {
    const r = readiness(input({ metadata: null }));
    expect(r.tone).toBe("bad");
    expect(r.fix).toBe("raw");
  });

  it("words missing instructions itself too", () => {
    const r = readiness(
      input({
        instructions: "  ",
        issues: [{ severity: "error", message: "Missing required '# Instructions' section", field: "", line: 5 }],
      }),
    );
    expect(r.tone).toBe("bad");
    expect(sentence(r)).toBe("Needs instructions before it can run");
  });

  it("asks for the role before the instructions", () => {
    expect(sentence(readiness(input({ role: "", instructions: "" })))).toBe("Needs a role before it can run");
  });
});

const SOURCE = `---
name: Tester
model:
  provider: openai
  name: gpt-4o
  authentication:
    type: api-key
    api_key: \${env:OPENAI_API_KEY}
tools:
  mcp:
    - name: gitlab
      transport:
        type: http
        url: https://gitlab.com/api/v4/mcp
    - name: deepwiki
      transport:
        type: http
        url: https://mcp.deepwiki.com/mcp
---

# Role

Test agent.

# Instructions

Do the thing.
`;

function servers(content: string) {
  const preview = previewAgent(content);
  if (!preview.ok) throw new Error(`invalid: ${preview.error}`);
  return preview.metadata.tools?.mcp ?? [];
}

describe("serverNameByUrl", () => {
  it("maps each server URL to the name the file gives it", () => {
    expect(serverNameByUrl(servers(SOURCE))).toEqual(
      new Map([
        ["https://gitlab.com/api/v4/mcp", "gitlab"],
        ["https://mcp.deepwiki.com/mcp", "deepwiki"],
      ]),
    );
  });
});

const WITH_MODEL = { name: "A", model: { provider: "openai", name: "gpt-4o" } } as AgentMetadata;
const NO_MODEL = { name: "A" } as AgentMetadata;

const needs = (role: string, instructions: string, metadata: AgentMetadata | null = WITH_MODEL) =>
  needsToRun({ role, instructions, metadata });

describe("needsToRun", () => {
  it("lists Role, Instructions and Model in that order", () => {
    expect(needs("a", "b")!.items.map((item) => item.label)).toEqual(["Role", "Instructions", "Model"]);
  });

  it("marks what is there and counts it", () => {
    const n = needs("You are a tutor.", "")!;
    expect(n.items.map((item) => item.done)).toEqual([true, false, true]);
    expect(n.done).toBe(2);
    expect(n.allDone).toBe(false);
  });

  it("counts blank text as missing", () => {
    expect(needs("   ", "\n")!.done).toBe(1);
  });

  it("is complete when all three are there", () => {
    expect(needs("a", "b")!.allDone).toBe(true);
  });

  it("counts a missing model", () => {
    const n = needs("a", "b", NO_MODEL)!;
    expect(n.items.map((item) => item.done)).toEqual([true, true, false]);
  });

  it("says nothing when the settings at the top of the file cannot be read", () => {
    expect(needs("a", "b", null)).toBeNull();
  });
});

describe("runReason", () => {
  it("names a role and instructions together", () => {
    expect(runReason(needs("", "")!)).toBe("Add a role and instructions to run");
  });

  it("names only the role when only the role is missing", () => {
    expect(runReason(needs("", "b")!)).toBe("Add a role to run");
  });

  it("says the role is done when only the instructions are missing", () => {
    expect(runReason(needs("a", "")!)).toBe("Add instructions to run. Role is done.");
  });

  it("names a missing model", () => {
    expect(runReason(needs("a", "b", NO_MODEL)!)).toBe("Add a model to run");
  });

  it("lists all three", () => {
    expect(runReason(needs("", "", NO_MODEL)!)).toBe("Add a role, instructions and a model to run");
  });

  it("has nothing to say when nothing is missing", () => {
    expect(runReason(needs("a", "b")!)).toBeNull();
  });
});

function chipInput(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    role: "You are a tutor.",
    instructions: "Be brief.",
    metadata: WITH_MODEL,
    issues: [],
    status: "ready",
    current: false,
    failed: false,
    brokenServerIds: [],
    serverNameByUrl: new Map(),
    ...over,
  };
}

describe("chipStatus", () => {
  it("shows the chip while something is missing", () => {
    expect(chipStatus(needs("", "b"), readiness(chipInput({ role: "" })))).toBe("missing");
  });

  it("is ready when all three are there and nothing else is wrong", () => {
    expect(chipStatus(needs("a", "b"), readiness(chipInput()))).toBe("ready");
  });

  it("leaves it to the line under the editor when the file has another problem", () => {
    const problem = readiness(
      chipInput({ issues: [{ severity: "error", message: "Unknown field 'x'.", field: "x", line: 2 }] }),
    );
    expect(chipStatus(needs("a", "b"), problem)).toBe("none");
  });

  it("shows nothing when the settings cannot be read", () => {
    expect(chipStatus(null, readiness(chipInput({ metadata: null })))).toBe("none");
  });
});

describe("the line under the editor and the chip", () => {
  it("lets the chip say what is missing", () => {
    expect(readiness(chipInput({ role: "" })).chip).toBe(true);
    expect(readiness(chipInput({ instructions: "" })).chip).toBe(true);
    expect(readiness(chipInput({ metadata: NO_MODEL })).chip).toBe(true);
  });

  it("lets the chip say it is ready", () => {
    expect(readiness(chipInput()).chip).toBe(true);
  });

  it("stays quiet under the banner that says the file is invalid", () => {
    const state = readiness(chipInput({ metadata: null }));
    expect(readinessSentence(state)).toBe("Invalid AFM file");
    expect(state.chip).toBe(true);
  });

  it("keeps speaking for everything the chip does not cover", () => {
    expect(readiness(chipInput({ status: "streaming" })).chip).toBeUndefined();
    expect(readiness(chipInput({ current: true })).chip).toBeUndefined();
    expect(readiness(chipInput({ failed: true })).chip).toBeUndefined();
    expect(
      readiness(chipInput({ issues: [{ severity: "error", message: "x", field: "", line: null }] })).chip,
    ).toBeUndefined();
  });
});

describe("readinessSentence", () => {
  it("reads the lead, subject and tail as one line", () => {
    expect(readinessSentence({ tone: "bad", lead: "Has a problem - ", subject: "bad field" })).toBe(
      "Has a problem - bad field",
    );
    expect(readinessSentence({ tone: "ok", lead: "Ready" })).toBe("Ready");
  });
});

describe("the line under the editor in Raw", () => {
  const problem = readiness(chipInput({ issues: [{ severity: "error", message: "x", field: "", line: null }] }));

  it("stays quiet about a problem the pill under the Raw editor already says", () => {
    expect(problem.fix).toBe("raw");
    expect(quietInRaw(problem, true).chip).toBe(true);
  });

  it("still speaks in Build, where there is no pill", () => {
    expect(quietInRaw(problem, false).chip).toBeUndefined();
  });

  it("keeps speaking in Raw about things the pill does not cover", () => {
    const running = readiness(chipInput({ status: "streaming" }));
    expect(quietInRaw(running, true)).toEqual(running);
  });
});
