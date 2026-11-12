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
import { type LanguageModel, type ModelMessage, runAgentTurn, type UserContent } from "@afm/runtime";
import { collectAfmIssues } from "../agent/agent-validation";
import { type BrowserLoaded, loadForBrowser } from "../agent/browser-agent";
import { userContent } from "../chat/chat-text";
import {
  type ImageAttachment,
  type ServerMessage,
  serverMessageFromLoopEvent,
} from "./protocol";
import { explainRefusal, type GatedSecrets } from "./secret-gate";
import { createToolbox, type ToolSource } from "../tools/toolbox";
import { createToolGuard, type PermissionBroker, type ToolGuard } from "../tools/tool-guard";
import { ToolNameError } from "../tools/tool-names";
import { allowedKeys, permissionKey } from "../tools/trust";

const READING = "Reading the agent file";

const STAGE_LABELS: Record<string, string> = {
  file: READING,
  model: "Connecting to the model",
  tools: "Preparing tools",
};

const STILL_ANSWERING = "This agent is still answering - wait for it to finish, or press Stop.";

type Toolbox = ReturnType<typeof createToolbox>;

export interface AgentSessionDeps {
  createModel: (model: AgentMetadata["model"]) => Promise<LanguageModel>;
  createTools: (metadata: AgentMetadata, guard: ToolGuard) => ToolSource[];
  secrets: (content: string) => GatedSecrets;
  permission: PermissionBroker;
  emit: (message: ServerMessage) => void;
}

interface LoadOptions {
  seedHistory?: ModelMessage[];
  allowBrowserPreview?: boolean;
  confirmedTools?: readonly string[];
}

export class AgentSession {
  private loaded: BrowserLoaded | null = null;
  private allowed = new Set<string>();
  private confirmed: readonly string[] = [];
  private model: LanguageModel | null = null;
  private tools: Toolbox | null = null;
  private history: ModelMessage[] = [];
  private controller: AbortController | null = null;
  private loadCount = 0;

  constructor(private readonly deps: AgentSessionDeps) {}

  private step(key: string, label: string, state: "active" | "done" | "failed", note?: string): void {
    this.deps.emit({ type: "load-step", key, label, state, note });
  }

  async load(content: string, { seedHistory, allowBrowserPreview, confirmedTools }: LoadOptions = {}): Promise<void> {
    this.endTurn();
    const number = ++this.loadCount;
    const current = (): boolean => number === this.loadCount;
    // Until the new agent is ready nothing of the old one may answer, and the latest trust list is kept for it.
    void this.tools?.close().catch(() => {});
    this.loaded = null;
    this.model = null;
    this.tools = null;
    this.allowed = new Set();
    this.confirmed = confirmedTools ?? [];
    let stage = "file";
    try {
      this.step("file", READING, "active");
      const invalid = collectAfmIssues(content).find((issue) => issue.severity === "error");
      if (invalid !== undefined) throw new Error(invalid.message);
      const { env, refused } = this.deps.secrets(content);
      let loaded: BrowserLoaded;
      try {
        loaded = loadForBrowser(content, env);
      } catch (error) {
        throw explainRefusal(error, refused);
      }
      const blocked = loaded.plan.issues.find((issue) => issue.severity === "blocked");
      if (blocked !== undefined) throw new Error(blocked.message);
      if (!allowBrowserPreview && loaded.plan.issues.some((issue) => issue.severity === "warning")) {
        throw new Error("Review the browser limitations before running this agent.");
      }
      this.step("file", READING, "done");

      stage = "model";
      const modelLabel = [loaded.metadata.model?.provider, loaded.metadata.model?.name]
        .filter((part) => part !== undefined && part !== "")
        .join(" · ");
      const connecting = `Connecting to ${modelLabel === "" ? "the model" : modelLabel}`;
      this.step("model", connecting, "active");
      const model = await this.deps.createModel(loaded.metadata.model);
      if (!current()) return;
      this.step("model", connecting, "done");

      stage = "tools";
      const guard = createToolGuard(this.permission);
      const tools = createToolbox(this.deps.createTools(loaded.metadata, guard));
      this.loaded = loaded;
      this.allowed = allowedKeys(loaded.metadata, this.confirmed);
      this.model = model;
      this.tools = tools;
      this.history = seedHistory ?? [];
      this.deps.emit({
        type: "loaded",
        name: loaded.metadata.name ?? "AFM Agent",
        mcpServers: (loaded.metadata.tools?.mcp ?? []).map((server) => server.name),
        plan: loaded.plan,
      });
      if (this.history.at(-1)?.role === "tool") this.deps.emit({ type: "resume-available" });
    } catch (error) {
      if (!current()) return;
      this.refuse(stage, error);
      return;
    }
    await this.reportTools(this.tools, current);
  }

  private refuse(stage: string, error: unknown): void {
    const reason = describeError(error);
    this.loaded = null;
    this.allowed = new Set();
    this.model = null;
    void this.tools?.close().catch(() => {});
    this.tools = null;
    this.step(stage, STAGE_LABELS[stage] ?? "Starting the agent", "failed", reason);
    this.deps.emit({ type: "agent-not-ready", reason });
  }

  private async reportTools(tools: Toolbox, current: () => boolean): Promise<void> {
    try {
      const { info, failed } = await tools.tools();
      if (!current()) return;
      this.deps.emit({ type: "tools-listed", tools: info });
      if (failed.length > 0) {
        const names = failed.map((name) => `'${name}'`).join(", ");
        this.deps.emit({ type: "notice", text: `These tool servers did not answer: ${names}. The agent runs without their tools for now.` });
      }
    } catch (error) {
      if (error instanceof ToolNameError && current()) this.refuse("tools", error);
    }
  }

  async send(text: string, images?: ImageAttachment[], keep?: number): Promise<void> {
    await this.sendContent(userContent(text, images), keep);
  }

  async continue(): Promise<void> {
    if (this.history.at(-1)?.role !== "tool") {
      this.deps.emit({ type: "rejected", message: "There is no completed tool result to continue from." });
      return;
    }
    await this.sendContent(null);
  }

  private async sendContent(content: UserContent | null, keep?: number): Promise<void> {
    const loaded = this.loaded;
    const model = this.model;
    const tools = this.tools;
    if (loaded === null || model === null || tools === null) {
      this.deps.emit({ type: "rejected", message: "No agent loaded yet." });
      return;
    }

    if (this.controller !== null) {
      this.deps.emit({ type: "rejected", message: STILL_ANSWERING });
      return;
    }

    if (keep !== undefined) this.history = this.history.slice(0, this.userTurnStart(keep));

    const controller = new AbortController();
    this.controller = controller;
    const current = (): boolean => this.controller === controller;
    let committed = false;
    const messages: ModelMessage[] = content === null ? [...this.history] : [...this.history, { role: "user", content }];

    try {
      // Stop must work while a tool server is still answering: an aborted turn ends at once, with no tools.
      const stopped = new Promise<Awaited<ReturnType<Toolbox["tools"]>>>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve({ tools: {}, info: [], failed: [] }), { once: true }),
      );
      const { tools: toolSet } = await Promise.race([tools.tools(), stopped]);
      for await (const event of runAgentTurn({
        system: loaded.systemPrompt,
        messages,
        model,
        tools: toolSet,
        maxIterations: loaded.metadata.max_iterations,
        signal: controller.signal,
      })) {
        if (!current()) return;
        if (event.type === "turn-checkpoint" || event.type === "turn-complete") {
          this.history = event.messages;
          committed = true;
        }
        const message = serverMessageFromLoopEvent(event);
        if (message !== null) {
          this.deps.emit(
            message.type === "turn-finished" &&
              event.type === "finish" &&
              event.reason !== "stop" &&
              this.history.at(-1)?.role === "tool"
              ? { ...message, canContinue: true }
              : message,
          );
        }
      }
    } catch (error) {
      if (current())
        this.deps.emit({ type: "error", message: describeError(error), kept: content === null || committed });
    } finally {
      if (current()) this.controller = null;
    }
  }

  private readonly permission: PermissionBroker = {
    request: async (call, signal) =>
      this.allowed.has(permissionKey(call.serverId, call.name)) ? "allow" : this.deps.permission.request(call, signal),
  };

  trust(confirmedTools?: readonly string[]): void {
    this.confirmed = confirmedTools ?? [];
    if (this.loaded !== null) this.allowed = allowedKeys(this.loaded.metadata, this.confirmed);
  }

  cancel(): void {
    this.controller?.abort();
  }

  private endTurn(): void {
    this.controller?.abort();
    this.controller = null;
  }

  resetChat(): void {
    this.endTurn();
    this.history = [];
  }

  private userTurnStart(count: number): number {
    const starts: number[] = [];
    this.history.forEach((message, index) => {
      if (message.role === "user") starts.push(index);
    });
    return starts[count] ?? this.history.length;
  }

  async regenerate(): Promise<void> {
    if (this.controller !== null) {
      this.deps.emit({ type: "rejected", message: STILL_ANSWERING });
      return;
    }
    const index = this.history.findLastIndex((message) => message.role === "user");
    const previous = index === -1 ? undefined : this.history[index];
    if (previous === undefined || previous.role !== "user") {
      this.deps.emit({ type: "turn-finished", reason: "stop" });
      return;
    }
    this.history = this.history.slice(0, index);
    await this.sendContent(previous.content);
  }
}
