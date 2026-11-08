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


import { type AgentMetadata, describeError } from "@afm/engine";
import type { ModelMessage } from "ai";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Agent } from "./agent";
import { runAgentTurn } from "./run";

const isText = (schema: unknown): boolean => JSON.stringify(schema) === '{"type":"string"}';

export function checkConsoleChat({ interfaces }: AgentMetadata): void {
  for (const item of interfaces ?? []) {
    if (item.type !== "consolechat") throw new Error(`The '${item.type}' interface is not yet supported by this interpreter.`);
    if ("signature" in item && !(isText(item.signature.input) && isText(item.signature.output))) {
      throw new Error("Structured input or output is not yet supported by this interpreter.");
    }
  }
}

async function answer(agent: Agent, history: ModelMessage[], text: string, output: Writable): Promise<ModelMessage[]> {
  let messages = [...history, { role: "user" as const, content: text }];
  for await (const event of runAgentTurn({ ...agent, messages })) {
    if (event.type === "text-delta") output.write(event.text);
    if (event.type === "turn-complete") messages = event.messages;
  }
  return messages;
}

export async function consoleChat(agent: Agent, input: Readable, output: Writable): Promise<void> {
  let history: ModelMessage[] = [];
  output.write("> ");
  for await (const line of createInterface({ input })) {
    const text = line.trim();
    if (text === "exit" || text === "quit") break;
    if (text !== "") {
      try {
        history = await answer(agent, history, text, output);
        output.write("\n");
      } catch (error) {
        output.write(`\n[ERROR] ${describeError(error)}\n`);
      }
    }
    output.write("> ");
  }
}
