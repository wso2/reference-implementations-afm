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

import { type Signature, TEXT_SIGNATURE } from "@afm/engine";
import type { ModelMessage } from "ai";
import type { Agent } from "./agent";
import { askStructured } from "./turn";

export const DEFAULT_SESSION = "default";
const MAX_SESSIONS = 1000;

export class Sessions {
  private histories = new Map<string, ModelMessage[]>();
  private tails = new Map<string, Promise<unknown>>();

  constructor(private readonly agent: Agent) {}

  ask(id: string, input: unknown, { signature = TEXT_SIGNATURE, signal }: { signature?: Signature; signal?: AbortSignal } = {}): Promise<unknown> {
    const previous = this.tails.get(id) ?? Promise.resolve();
    const turn = previous
      .catch(() => undefined)
      .then(async () => {
        const answer = await askStructured(this.agent, this.histories.get(id) ?? [], input, signature, { signal });
        this.remember(id, answer.messages);
        return answer.value;
      });
    this.tails.set(id, turn);
    return turn;
  }

  private remember(id: string, messages: ModelMessage[]): void {
    this.histories.delete(id);
    this.histories.set(id, messages);
    if (this.histories.size > MAX_SESSIONS) {
      const oldest = this.histories.keys().next().value as string;
      this.histories.delete(oldest);
      this.tails.delete(oldest);
    }
  }
}
