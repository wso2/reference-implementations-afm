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


import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeMcp, startFakeMcp } from "./test-fixtures/fake-mcp-http";
import { type FakeModel, startFakeModel } from "./test-fixtures/fake-model";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const stdioScript = fileURLToPath(new URL("./test-fixtures/stdio-server.mjs", import.meta.url));
const { execPath, env: processEnv } = (globalThis as unknown as { process: { execPath: string; env: Record<string, string | undefined> } }).process;

let folder = "";
let main = "";
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "afm-e2e-"));
  main = join(folder, "main.js");
  await new Promise<void>((done, fail) => execFile(execPath, ["build.mjs", main], { cwd: root }, (error) => (error === null ? done() : fail(error))));
  await mkdir(join(folder, "skills/demo"), { recursive: true });
  await writeFile(join(folder, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: Demonstrates skills\n---\n\nSkill body.\n");
}, 60_000);
afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], input: string, env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn(execPath, [main, ...args], { cwd: folder, env: { PATH: processEnv["PATH"] ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => (stdout += data.toString()));
    child.stderr.on("data", (data: Buffer) => (stderr += data.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function agentFile(name: string, model: string, mcp: string, extra = ""): Promise<string> {
  const path = join(folder, name);
  await writeFile(
    path,
    `---
spec_version: "0.4.0"
name: E2E
max_iterations: 5
model:
  provider: openai
  name: fake-model
  url: "${model}"
  authentication:
    type: api-key
    api_key: \${env:TEST_KEY}
tools:
  mcp:
    - name: docs
      transport:
        type: http
        url: "${mcp}"
        authentication:
          type: bearer
          token: \${env:DOCS_TOKEN}
    - name: files
      transport:
        type: stdio
        command: "${execPath}"
        args: ["${stdioScript}"]
        env:
          AFM_TEST_VALUE: from-the-file
${extra}skills:
  - type: local
    path: ./skills
---

# Role
You are \${env:AGENT_NAME}.

# Instructions
Use the docs tool.
`,
  );
  return path;
}

const ENV = { TEST_KEY: "test-key", DOCS_TOKEN: "docs-token", AGENT_NAME: "Ada" };

describe("the built interpreter, started with an agent file", () => {
  let model: FakeModel;
  let mcp: FakeMcp;
  beforeAll(async () => {
    model = await startFakeModel();
    mcp = await startFakeMcp();
  });
  afterAll(async () => {
    await model.close();
    await mcp.close();
  });

  it("chats, runs a tool server tool without asking, and keeps the conversation", async () => {
    const file = await agentFile("chat.afm.md", model.url, mcp.url);
    const { code, stdout, stderr } = await run([file], "hello\nfind x\nexit\n", ENV);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("You said: hello");
    expect(stdout).toContain("The answer is: found x");

    const [first] = model.requests;
    expect(first!.url).toBe("/v1/chat/completions");
    expect(first!.authorization).toBe("Bearer test-key");
    const offered = first!.body.tools!.map((tool) => tool.function.name).sort();
    expect(offered).toEqual(["activate_skill", "from_file", "from_parent", "hidden", "read_skill_resource", "search"]);
    const system = String(first!.body.messages[0]!.content);
    expect(system).toContain("You are Ada.");
    expect(system).toContain("<name>demo</name>");

    expect(mcp.seen.calls).toEqual(["x"]);
    expect(mcp.seen.authorizations.every((value) => value === "Bearer docs-token")).toBe(true);

    const second = model.requests.find((request) => request.body.messages.some((message) => String(message.content).includes("You said: hello")) && request.body.messages.length > 3);
    expect(second).toBeDefined();
  }, 60_000);

  it("reports a model error and goes on with the next line", async () => {
    const file = await agentFile("error.afm.md", model.url, mcp.url);
    const { code, stdout } = await run([file], "fail\nhello\nexit\n", ENV);
    expect(code).toBe(0);
    expect(stdout).toMatch(/\[ERROR\] .*the fake model refuses this/);
    expect(stdout).toContain("You said: hello");
  }, 60_000);

  it("skips a tool server that cannot be reached, and says so", async () => {
    const dead = await startFakeMcp();
    const deadUrl = dead.url;
    await dead.close();
    const file = await agentFile("skip.afm.md", model.url, deadUrl);
    const { code, stdout, stderr } = await run([file], "hello\nexit\n", ENV);
    expect(code).toBe(0);
    expect(stderr).toMatch(/Skipping the tool server 'docs'/);
    expect(stdout).toContain("You said: hello");
  }, 60_000);

  it("stops at the end of its input", async () => {
    const file = await agentFile("eof.afm.md", model.url, mcp.url);
    expect((await run([file], "hello\n", ENV)).code).toBe(0);
  }, 60_000);

  it.each([
    ["no file is given", async () => [], {}, /Usage: node main.js/],
    ["the file does not exist", async () => [join(folder, "missing.afm.md")], {}, /ENOENT/],
    ["a variable has no value", async () => [await agentFile("novar.afm.md", model.url, mcp.url)], { TEST_KEY: "k", DOCS_TOKEN: "t" }, /Could not resolve variable '\$\{env:AGENT_NAME\}'/],
    ["the file asks for web chat", async () => {
      const path = join(folder, "web.afm.md");
      await writeFile(path, "---\ninterfaces:\n  - type: webchat\n---\n\n# Role\nr\n\n# Instructions\ni\n");
      return [path];
    }, {}, /The 'webchat' interface is not yet supported by this interpreter\./],
    ["the file asks for jwt", async () => {
      const path = join(folder, "jwt.afm.md");
      await writeFile(path, `---\ntools:\n  mcp:\n    - name: s\n      transport:\n        type: http\n        url: "${mcp.url}"\n        authentication:\n          type: jwt\n          issuer: i\n          audience: a\n          signing_key: k\n---\n\n# Role\nr\n\n# Instructions\ni\n`);
      return [path];
    }, { OPENAI_API_KEY: "k" }, /'jwt' authentication is not yet supported by this interpreter/],
  ])("exits with an error and a clear message when %s", async (_label, args, env, message) => {
    const result = await run(await args(), "", env as Record<string, string>);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(message);
  }, 60_000);
});
