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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

interface Running {
  url: string;
  child: ReturnType<typeof spawn>;
  done: Promise<Result>;
}

async function startMain(args: string[], env: Record<string, string>): Promise<Running> {
  const child = spawn(execPath, [main, ...args], { cwd: folder, env: { PATH: processEnv["PATH"] ?? "", ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data: Buffer) => (stdout += data.toString()));
  const url = await new Promise<string>((resolve, reject) => {
    child.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
      const found = /Serving on (http:\/\/\S+)/.exec(stderr);
      if (found !== null) resolve(found[1]!);
    });
    child.on("close", () => reject(new Error(`the interpreter ended before it served: ${stderr}`)));
  });
  const done = new Promise<Result>((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
  return { url, child, done };
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

  it("names the agent after its file when the file gives no name", async () => {
    const file = await agentFile("nameless-agent.afm.md", model.url, mcp.url, "interfaces:\n  - type: webchat\n");
    await writeFile(file, (await readFile(file, "utf-8")).replace("name: E2E\n", ""));
    const served = await startMain([file, "--port", "0", "--host", "127.0.0.1"], ENV);
    expect(await (await fetch(`${served.url}/`)).json()).toMatchObject({ name: "nameless-agent" });
    served.child.kill("SIGTERM");
    expect((await served.done).code).toBe(0);
  });

  it("serves web chat on the port it is given, keeps one conversation per session, and stops cleanly on SIGTERM", async () => {
    const file = await agentFile("webchat.afm.md", model.url, mcp.url, "interfaces:\n  - type: webchat\n");
    const served = await startMain([file, "--port", "0", "--host", "127.0.0.1"], ENV);
    const say = async (message: string, session: string) =>
      (await fetch(`${served.url}/chat`, { method: "POST", body: message, headers: { "X-Session-Id": session } })).text();
    expect(await say("hello", "a")).toBe("You said: hello");
    expect(await say("again", "a")).toBe("You said: again");
    expect(await (await fetch(`${served.url}/health`)).json()).toEqual({ status: "ok" });
    expect(await (await fetch(`${served.url}/`)).json()).toMatchObject({ name: "E2E", version: "0.0.0" });
    expect((await fetch(`${served.url}/chat/ui`)).status).toBe(200);
    const withHistory = model.requests.filter((request) => request.body.messages.some((message) => String(message.content) === "hello") && request.body.messages.some((message) => String(message.content) === "again"));
    expect(withHistory).toHaveLength(1);
    served.child.kill("SIGTERM");
    expect((await served.done).code).toBe(0);
  }, 60_000);

  it("receives a signed webhook event and runs the agent with the prompt from the file", async () => {
    const { createHmac } = await import("node:crypto");
    const hook = "interfaces:\n  - type: webhook\n    prompt: \"event ${http:payload.kind}\"\n    subscription:\n      protocol: websub\n      secret: \"shh\"\n";
    const file = await agentFile("webhook.afm.md", model.url, mcp.url, hook);
    const served = await startMain([file, "--port", "0", "--host", "127.0.0.1"], ENV);
    const body = JSON.stringify({ kind: "deploy" });
    const unsigned = await fetch(`${served.url}/webhook`, { method: "POST", body });
    expect(unsigned.status).toBe(401);
    const signature = `sha256=${createHmac("sha256", "shh").update(body).digest("hex")}`;
    const accepted = await fetch(`${served.url}/webhook`, { method: "POST", body, headers: { "X-Hub-Signature-256": signature } });
    expect([accepted.status, await accepted.json()]).toEqual([202, { status: "accepted" }]);
    await vi.waitFor(() => expect(model.requests.some((request) => request.body.messages.some((message) => String(message.content) === "event deploy"))).toBe(true));
    served.child.kill("SIGINT");
    expect((await served.done).code).toBe(0);
  }, 60_000);

  it("serves a web chat with structured input, and refuses input that does not fit the schema", async () => {
    const signature = "interfaces:\n  - type: webchat\n    signature:\n      input:\n        type: object\n        properties:\n          city:\n            type: string\n        required: [city]\n        additionalProperties: false\n      output:\n        type: string\n";
    const file = await agentFile("structured.afm.md", model.url, mcp.url, signature);
    const served = await startMain([file, "--port", "0", "--host", "127.0.0.1"], ENV);
    const post = (body: unknown) => fetch(`${served.url}/chat`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    expect(await (await post({ city: "Paris" })).json()).toEqual({ response: 'You said: {"city":"Paris"}' });
    const refused = await post({ town: "Rome" });
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { detail: string }).detail).toMatch(/city|Unrecognized/);
    served.child.kill("SIGTERM");
    expect((await served.done).code).toBe(0);
  }, 60_000);

  it("keeps serving when console chat and web chat are both asked for and the input ends, and stops when told to exit", async () => {
    const file = await agentFile("both.afm.md", model.url, mcp.url, "interfaces:\n  - type: consolechat\n  - type: webchat\n");
    const ended = await startMain([file, "--port", "0", "--host", "127.0.0.1"], ENV);
    ended.child.stdin!.end();
    await new Promise((done) => setTimeout(done, 300));
    expect((await fetch(`${ended.url}/health`)).status).toBe(200);
    ended.child.kill("SIGTERM");
    expect((await ended.done).code).toBe(0);

    const quitting = await startMain([file, "--port", "0", "--host", "127.0.0.1"], ENV);
    quitting.child.stdin!.write("hello\nexit\n");
    const result = await quitting.done;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("You said: hello");
  }, 60_000);

  it.each([
    ["no file is given", async () => [], {}, /Usage: node main.js/],
    ["the file does not exist", async () => [join(folder, "missing.afm.md")], {}, /ENOENT/],
    ["a variable has no value", async () => [await agentFile("novar.afm.md", model.url, mcp.url)], { TEST_KEY: "k", DOCS_TOKEN: "t" }, /Could not resolve variable '\$\{env:AGENT_NAME\}'/],
    ["the file asks for platform chat", async () => {
      const path = join(folder, "platform.afm.md");
      await writeFile(path, "---\ninterfaces:\n  - type: platformchat\n    platform: slack\n    mode: notification\n---\n\n# Role\nr\n\n# Instructions\ni\n");
      return [path];
    }, {}, /The 'platformchat' interface is not yet supported by this interpreter\./],
    ["an option is not known", async () => [await agentFile("opt.afm.md", model.url, mcp.url), "--bogus"], {}, /Usage: node main.js/],
    ["the port is not a number", async () => [await agentFile("port.afm.md", model.url, mcp.url), "--port", "abc"], {}, /The port must be a whole number from 0 to 65535/],
    ["the host is missing", async () => [await agentFile("host.afm.md", model.url, mcp.url), "--host"], {}, /The --host option needs a host name or address/],
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
