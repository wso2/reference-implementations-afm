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

import { inputText, outputInstruction, outputValue, type Signature } from "@afm/engine";
import type { ModelMessage } from "ai";
import type { Agent } from "./agent";
import { runAgentTurn } from "./run";

const STOPPED: Record<string, string> = {
  "max-iterations": "the agent reached its max_iterations limit",
  length: "the reply reached the model's length limit",
  "content-filter": "the model's content filter stopped the reply",
};

export interface Answer {
  reply: string;
  messages: ModelMessage[];
}

export async function askAgent(
  agent: Agent,
  history: ModelMessage[],
  text: string,
  { onText, signal }: { onText?: (text: string) => void; signal?: AbortSignal } = {},
): Promise<Answer> {
  let messages: ModelMessage[] = [...history, { role: "user", content: text }];
  let reply = "";
  const add = (more: string): void => {
    reply += more;
    onText?.(more);
  };
  for await (const event of runAgentTurn({ ...agent, messages, signal })) {
    if (event.type === "text-delta") add(event.text);
    if (event.type === "turn-complete") messages = event.messages;
    if (event.type === "finish" && event.reason !== "stop") add(`\n[Stopped: ${STOPPED[event.reason] ?? `the model finished with '${event.reason}'`}]`);
  }
  return { reply, messages };
}

export interface StructuredAnswer extends Answer {
  value: unknown;
}

export async function askStructured(
  agent: Agent,
  history: ModelMessage[],
  input: unknown,
  signature: Signature,
  options: { onText?: (text: string) => void; signal?: AbortSignal } = {},
): Promise<StructuredAnswer> {
  const original = inputText(input, signature.input);
  const { reply, messages } = await askAgent(agent, history, original + outputInstruction(signature.output), options);
  const kept: ModelMessage[] = [...messages.slice(0, history.length), { role: "user", content: original }, ...messages.slice(history.length + 1)];
  return { reply, messages: kept, value: outputValue(reply, signature.output) };
}
