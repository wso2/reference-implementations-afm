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

import { describe, expect, it } from "vitest";
import { RequestTimeoutError } from "../chat/failure";
import { completeText } from "./complete-text";
import { modelOf, type FakeEvent } from "../../test-support/test-model";

const modelSaying = (events: FakeEvent[], seen: { system?: string; prompt?: string }[] = []) =>
  modelOf({
    async *stream(request) {
      seen.push({ system: request.system, prompt: String(request.messages[0]?.content) });
      yield* events;
    },
  });

describe("completeText", () => {
  it("joins what the model said, sending the prompt as the only message under a short instruction", async () => {
    const seen: { system?: string; prompt?: string }[] = [];
    const model = modelSaying([{ type: "text-delta", text: "Hel" }, { type: "text-delta", text: "lo" }, { type: "finish", reason: "stop" }], seen);
    expect(await completeText(model, "Say hello")).toBe("Hello");
    expect(seen).toEqual([{ system: "Follow the user's instruction exactly.", prompt: "Say hello" }]);
  });

  it("fails with the model's own error", async () => {
    const model = modelOf({
      async *stream() {
        throw new Error("the provider refused");
      },
    });
    await expect(completeText(model, "x")).rejects.toThrow("the provider refused");
  });

  it("fails as a slow answer when it was stopped", async () => {
    const stopped = AbortSignal.abort();
    await expect(completeText(modelSaying([]), "x", stopped)).rejects.toBeInstanceOf(RequestTimeoutError);
  });
});
