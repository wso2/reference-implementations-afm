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

import { type ModelMessage } from "@afm/runtime";
import { type UiMessage } from "./chat-state";
import { userContent } from "./chat-text";

const INTERRUPTED = "This tool call was interrupted before it returned a result.";

export function toSeededConversation(messages: UiMessage[]): ModelMessage[] {
  const conversation: ModelMessage[] = [];
  let assistantText: string | null = null;
  let calls: { id: string; name: string; args: unknown; result: string }[] = [];

  function flush(): void {
    if (assistantText === null && calls.length === 0) return;
    if (calls.length === 0) {
      conversation.push({ role: "assistant", content: assistantText ?? "" });
    } else {
      conversation.push({
        role: "assistant",
        content: [
          ...(assistantText ? [{ type: "text" as const, text: assistantText }] : []),
          ...calls.map(({ id, name, args }) => ({ type: "tool-call" as const, toolCallId: id, toolName: name, input: args })),
        ],
      });
      conversation.push({
        role: "tool",
        content: calls.map(({ id, name, result }) => ({
          type: "tool-result" as const,
          toolCallId: id,
          toolName: name,
          output: { type: "text" as const, value: result },
        })),
      });
    }
    assistantText = null;
    calls = [];
  }

  for (const message of messages) {
    if (message.kind === "user") {
      flush();
      conversation.push({ role: "user", content: userContent(message.text, message.images) });
    } else if (message.kind === "assistant") {
      flush();
      assistantText = message.text;
    } else if (message.kind === "tool") {
      calls.push({ id: message.callId, name: message.name, args: message.args, result: message.result ?? INTERRUPTED });
    }
  }
  flush();
  return conversation;
}
