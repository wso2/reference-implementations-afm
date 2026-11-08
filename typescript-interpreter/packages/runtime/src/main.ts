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
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createAgent } from "./agent";
import { checkConsoleChat, consoleChat } from "./console-chat";

async function main(path: string | undefined): Promise<void> {
  if (path === undefined) throw new Error("Usage: node main.js <agent file>.afm.md");
  const file = resolve(path);
  const loaded = loadAfm(await readFile(file, "utf-8"));
  for (const warning of loaded.warnings) console.warn(`Warning: ${warning}`);
  checkConsoleChat(loaded.metadata);
  const agent = await createAgent(loaded, dirname(file));
  try {
    await consoleChat(agent, process.stdin, process.stdout);
  } finally {
    await agent.close();
  }
}

main(process.argv[2]).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
