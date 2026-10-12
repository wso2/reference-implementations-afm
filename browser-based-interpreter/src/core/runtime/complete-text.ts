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

import { type LanguageModel, runAgentTurn } from "@afm/runtime";
import { RequestTimeoutError } from "../chat/failure";

export async function completeText(model: LanguageModel, prompt: string, signal?: AbortSignal): Promise<string> {
  let text = "";
  const turn = runAgentTurn({
    system: "Follow the user's instruction exactly.",
    messages: [{ role: "user", content: prompt }],
    model,
    tools: {},
    maxIterations: 1,
    signal,
  });
  for await (const event of turn) {
    if (event.type === "text-delta") text += event.text;
    if (event.type === "finish" && event.reason === "aborted") throw new RequestTimeoutError("The model did not answer in time.");
  }
  return text;
}
