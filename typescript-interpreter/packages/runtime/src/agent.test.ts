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


import { loadAfm } from "@afm/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "./agent";
import { type FakeMcp, startFakeMcp } from "./test-fixtures/fake-mcp-http";

const servers: FakeMcp[] = [];
const start = async () => {
  const server = await startFakeMcp();
  servers.push(server);
  return server;
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const file = (mcp: string, max = "") => `---
${max}model:
  provider: openai
  authentication:
    type: api-key
    api_key: k
tools:
  mcp:
${mcp}
---

# Role
r

# Instructions
i
`;
const server = (name: string, url: string, filter = "") => `    - name: ${name}\n      transport:\n        type: http\n        url: "${url}"\n${filter}`;
const agentOf = (text: string) => createAgent(loadAfm(text, { env: {} }), "/tmp");

describe("createAgent", () => {
  it("collects the tools of every server and the max_iterations of the file", async () => {
    const one = await start();
    const agent = await agentOf(file(server("docs", one.url), "max_iterations: 3\n"));
    expect(Object.keys(agent.tools)).toEqual(["search"]);
    expect(agent.maxIterations).toBe(3);
    expect(agent.system).toBe("# Role\n\nr\n\n# Instructions\n\ni");
    await agent.close();
  });

  it("refuses two servers that offer the same tool name, naming both", async () => {
    const [a, b] = [await start(), await start()];
    await expect(agentOf(file(`${server("one", a.url)}\n${server("two", b.url)}`))).rejects.toThrow(/The tool 'search' is offered by both 'tool server one' and 'tool server two'. Hide one with a tool_filter./);
  });

  it("lets a tool_filter settle the clash", async () => {
    const [a, b] = [await start(), await start()];
    const hide = "      tool_filter:\n        deny: [search]\n";
    const agent = await agentOf(file(`${server("one", a.url)}\n${server("two", b.url, hide)}`));
    expect(Object.keys(agent.tools)).toEqual(["search"]);
    await agent.close();
  });

  it("skips a server that cannot be reached with a warning, and fails when none can be reached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const live = await start();
    const dead = await start();
    const deadUrl = dead.url;
    await dead.close();
    servers.splice(servers.indexOf(dead), 1);

    const agent = await agentOf(file(`${server("gone", deadUrl)}\n${server("docs", live.url)}`));
    expect(Object.keys(agent.tools)).toEqual(["search"]);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/Skipping the tool server 'gone'/);
    await agent.close();

    await expect(agentOf(file(server("gone", deadUrl)))).rejects.toThrow(/Failed to connect to any tool server: gone:/);
  });

  it("fails at once for an authentication type it cannot use, before connecting to anything", async () => {
    const jwt = `${server("docs", "http://127.0.0.1:1/mcp")}        authentication:\n          type: jwt\n          issuer: i\n          audience: a\n          signing_key: k\n`;
    await expect(agentOf(file(jwt))).rejects.toThrow(/'jwt' authentication is not yet supported by this interpreter/);
  });

  it("fails at once for a model provider it cannot use", async () => {
    await expect(createAgent(loadAfm("---\nmodel:\n  provider: gemini\n---\n\n# Role\nr\n\n# Instructions\ni\n", { env: {} }), "/tmp")).rejects.toThrow(/'gemini' is not yet supported by this interpreter/);
  });
});
