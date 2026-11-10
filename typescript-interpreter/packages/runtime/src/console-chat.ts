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


import { describeError, isTextSchema, type Signature, TEXT_SIGNATURE } from "@afm/engine";
import type { ModelMessage } from "ai";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Agent } from "./agent";
import { askStructured } from "./turn";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The input of this agent must be JSON.");
  }
}

export async function consoleChat(agent: Agent, input: Readable, output: Writable, signature: Signature = TEXT_SIGNATURE): Promise<boolean> {
  let history: ModelMessage[] = [];
  const textOutput = isTextSchema(signature.output);
  output.write("> ");
  for await (const line of createInterface({ input })) {
    const text = line.trim();
    if (text === "exit" || text === "quit") return true;
    if (text !== "") {
      try {
        const answer = await askStructured(agent, history, isTextSchema(signature.input) ? text : parseJson(text), signature, { onText: textOutput ? (more) => output.write(more) : undefined });
        history = answer.messages;
        if (!textOutput) output.write(JSON.stringify(answer.value, null, 2));
        output.write("\n");
      } catch (error) {
        output.write(`\n[ERROR] ${describeError(error)}\n`);
      }
    }
    output.write("> ");
  }
  return false;
}
