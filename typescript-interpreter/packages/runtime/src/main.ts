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

import { agentDetails, loadAfm } from "@afm/engine";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createAgent } from "./agent";
import { consoleChat } from "./console-chat";
import { chooseInterfaces } from "./interfaces";
import { serve } from "./serve";

const USAGE = "Usage: node main.js <agent file>.afm.md [--port <port>] [--host <host>]";
const DEFAULT_PORT = 8085;

function parseArguments(args: string[]): { file: string; port: number; host: string } {
  let file: string | undefined;
  let port = DEFAULT_PORT;
  let host = "0.0.0.0";
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === "--port" || arg === "-p") {
      port = Number(args[(at += 1)]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("The port must be a whole number from 0 to 65535.");
    } else if (arg === "--host" || arg === "-H") {
      host = args[(at += 1)] ?? "";
      if (host === "") throw new Error("The --host option needs a host name or address.");
    } else if (arg.startsWith("-") || file !== undefined) {
      throw new Error(USAGE);
    } else {
      file = arg;
    }
  }
  if (file === undefined) throw new Error(USAGE);
  return { file, port, host };
}

async function main(args: string[]): Promise<void> {
  const { file: path, port, host } = parseArguments(args);
  const file = resolve(path);
  const loaded = loadAfm(await readFile(file, "utf-8"));
  for (const warning of loaded.warnings) console.warn(`Warning: ${warning}`);
  const chosen = chooseInterfaces(loaded.metadata);
  const agent = await createAgent(loaded, dirname(file));
  const stopped = new Promise<void>((done) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => done());
  });
  let serving: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    if (chosen.webchat !== undefined || chosen.webhook !== undefined) {
      serving = await serve(agent, agentDetails(loaded, file), chosen, { host, port });
      console.error(`Serving on http://${host}:${serving.port}`);
    }
    if (chosen.console !== undefined) {
      const quit = await Promise.race([consoleChat(agent, process.stdin, process.stdout, chosen.console.signature), stopped.then(() => true)]);
      if (quit || serving === undefined) return;
    }
    await stopped;
  } finally {
    await serving?.close();
    await agent.close();
  }
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
