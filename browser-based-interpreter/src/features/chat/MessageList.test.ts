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
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { endScrollBehavior, followingAfterScroll, MessageList, regenerableIndex } from "./MessageList";
import type { UiMessage } from "../../core/chat/chat-state";

const THREAD: UiMessage[] = [
  { kind: "user", id: 1, text: "hello" },
  { kind: "assistant", id: 2, text: "Hi there" },
];

function list(
  status: Parameters<typeof MessageList>[0]["status"],
  messages: UiMessage[],
  notReady: string | null = null,
): string {
  return renderToStaticMarkup(
    createElement(MessageList, {
      messages,
      streaming: false,
      status,
      agentName: "Demo",
      loadSteps: [],
      notReady,
      onRetry: () => {},
      onRegenerate: () => {},
      onEdit: () => {},
    }),
  );
}

describe("a thread whose agent did not start", () => {
  it("keeps the conversation and says why, with a way to try again", () => {
    const out = list("not-ready", THREAD, "'OPENAI_API_KEY' is not in the host config");
    expect(out).toContain("Hi there");
    expect(out).toContain("xc-notready");
    expect(out).toContain("Key not accepted");
    expect(out).toContain("Try again");
  });

  it("shows nothing about a failure while the agent is fine", () => {
    expect(list("ready", THREAD)).not.toContain("xc-notready");
  });

  it("shows nothing about a failure while the agent is still starting", () => {
    expect(list("connecting", THREAD)).not.toContain("xc-notready");
  });

  it("gives an empty thread the full-size explanation instead of the in-thread one", () => {
    const out = list("not-ready", [], "Unsupported model provider");
    expect(out).toContain("Agent isn&#x27;t ready");
    expect(out).not.toContain("xc-notready");
  });
});

describe("tool results without a final answer", () => {
  const tool: UiMessage = {
    kind: "tool",
    id: 2,
    callId: "read-1",
    name: "read_file",
    args: {},
    status: "ok",
    result: "Project evidence",
  };

  it("keeps completed research visible when a turn hits its budget", () => {
    const out = list("ready", [
      { kind: "user", id: 1, text: "Prepare me" },
      tool,
      { kind: "notice", id: 3, text: "Stopped at the token budget" },
      { kind: "user", id: 4, text: "Continue" },
    ]);
    expect(out).toContain("read_file");
    expect(out).toContain("Stopped at the token budget");
  });

  it("shows a tool once when it belongs to a final answer", () => {
    const out = list("ready", [tool, { kind: "assistant", id: 3, text: "Here is your plan" }]);
    expect(out.match(/xc-used-name/g)).toHaveLength(1);
  });
});

function failed(
  failure: string | null,
  options: {
    status?: Parameters<typeof MessageList>[0]["status"];
    messages?: UiMessage[];
    retry?: boolean;
    replaceKey?: boolean;
  } = {},
): string {
  const { status = "ready", messages = THREAD, retry = true, replaceKey = true } = options;
  return renderToStaticMarkup(
    createElement(MessageList, {
      messages,
      streaming: false,
      status,
      agentName: "Demo",
      loadSteps: [],
      notReady: null,
      onRetry: () => {},
      failure,
      onRetryReply: retry ? () => {} : undefined,
      onReplaceKey: replaceKey ? () => {} : undefined,
      onRegenerate: () => {},
    }),
  );
}

describe("a reply that failed", () => {
  it("says so in a few words under the last message, with Retry", () => {
    const html = failed("Failed to fetch");
    expect(html).toContain("Hi there");
    expect(html).toContain('class="reply-failure"');
    expect(html).toContain("Can&#x27;t be reached");
    expect(html).toContain(">Retry<");
    expect(html).not.toContain("Replace key");
  });

  it("offers a new key when the key was refused", () => {
    const html = failed("401 Unauthorized: Incorrect API key provided");
    expect(html).toContain("Key not accepted");
    expect(html).toContain(">Replace key<");
    expect(html).toContain(">Retry<");
  });

  it("keeps a long technical message off the screen", () => {
    const html = failed("Something odd happened inside the provider's response handling code at line 42");
    expect(html).toContain("Something went wrong");
    expect(html).not.toContain("provider&#x27;s response");
  });

  it("has no Retry when there is no question to ask again", () => {
    const html = failed("Failed to fetch", { messages: [{ kind: "assistant", id: 1, text: "Hi" }] });
    expect(html).toContain("reply-failure");
    expect(html).not.toContain(">Retry<");
  });

  it("has no Retry when nothing was given to retry with", () => {
    expect(failed("Failed to fetch", { retry: false })).not.toContain(">Retry<");
  });

  it("shows nothing when there was no failure, or the agent is busy or not ready", () => {
    expect(failed(null)).not.toContain("reply-failure");
    expect(failed("Failed to fetch", { status: "streaming" })).not.toContain("reply-failure");
    expect(failed("Failed to fetch", { status: "connecting" })).not.toContain("reply-failure");
    expect(failed("Failed to fetch", { status: "not-ready" })).not.toContain("reply-failure");
  });

  it("is announced to a screen reader", () => {
    expect(failed("Failed to fetch")).toContain('role="alert"');
  });
});

describe("a thread that is waiting for permission", () => {
  const RUNNING: UiMessage[] = [
    { kind: "user", id: 1, text: "who am I?" },
    { kind: "tool", id: 2, callId: "c1", name: "github__get_me", args: {}, status: "running" },
  ];
  const request = { id: "c1", name: "github__get_me", args: {}, serverId: "https://api.githubcopilot.com/mcp" };

  function waiting(pending: typeof request | null, messages: UiMessage[] = RUNNING): string {
    return renderToStaticMarkup(
      createElement(MessageList, {
        messages,
        streaming: true,
        status: "streaming",
        agentName: "Demo",
        loadSteps: [],
        notReady: null,
        onRetry: () => {},
        onRegenerate: () => {},
        pendingPermission: pending,
        onDecide: () => {},
      }),
    );
  }

  it("shows the card right under the tool chip, which turns to the asking look", () => {
    const out = waiting(request);
    expect(out).toContain("xc-used ask");
    expect(out).toContain('class="ap"');
    expect(out.indexOf("xc-used ask")).toBeLessThan(out.indexOf('class="ap"'));
    expect(out).not.toContain("Using a tool");
  });

  it("shows no card when nothing is waiting", () => {
    const out = waiting(null);
    expect(out).not.toContain('class="ap"');
    expect(out).toContain("Using a tool");
  });

  it("still shows the card, after the thread, when the tool call is not in the thread yet", () => {
    const out = waiting(request, [RUNNING[0]!]);
    expect(out).toContain('class="ap"');
    expect(out).not.toContain("Thinking");
  });
});

describe("when the thread keeps following the newest message", () => {
  it("follows when the reader is at the bottom", () => {
    expect(followingAfterScroll(false, 10, false)).toBe(true);
    expect(followingAfterScroll(true, 79, true)).toBe(true);
  });

  it("stops only when the reader scrolls up, away from the bottom", () => {
    expect(followingAfterScroll(true, 400, true)).toBe(false);
  });

  it("keeps following when the page grows faster than the scroll, since the reader did not move", () => {
    expect(followingAfterScroll(true, 400, false)).toBe(true);
  });

  it("does not start following again while the reader is away and scrolling down in the middle", () => {
    expect(followingAfterScroll(false, 400, false)).toBe(false);
  });
});

describe("following a reply while it is written", () => {
  it("jumps straight to the end while words arrive, and glides only when it is finished", () => {
    expect(endScrollBehavior(true)).toBe("auto");
    expect(endScrollBehavior(false)).toBe("smooth");
  });
});

describe("where Try again is offered", () => {
  const QUESTION = (id: number): UiMessage => ({ kind: "user", id, text: `question ${id}` });
  const ANSWER = (id: number): UiMessage => ({ kind: "assistant", id, text: `answer ${id}` });
  const TOOL = (id: number): UiMessage => ({ kind: "tool", id, callId: `c${id}`, name: "docs__search", args: {}, status: "ok" } as UiMessage);

  it("is under the answer to the latest question", () => {
    expect(regenerableIndex([QUESTION(1), ANSWER(2)])).toBe(1);
    expect(regenerableIndex([QUESTION(1), ANSWER(2), QUESTION(3), TOOL(4), ANSWER(5)])).toBe(4);
  });

  it("is under no answer when the latest question has none yet", () => {
    expect(regenerableIndex([QUESTION(1), ANSWER(2), QUESTION(3)])).toBe(-1);
    expect(regenerableIndex([QUESTION(1), ANSWER(2), QUESTION(3), TOOL(4)])).toBe(-1);
  });

  it("is nowhere in an empty thread", () => {
    expect(regenerableIndex([])).toBe(-1);
  });

  const thread = (messages: UiMessage[]) =>
    renderToStaticMarkup(
      createElement(MessageList, {
        messages,
        streaming: false,
        status: "ready",
        agentName: "Demo",
        loadSteps: [],
        notReady: null,
        onRetry: () => {},
        onRegenerate: () => {},
      }),
    );

  it("shows Try again once for the latest answer", () => {
    const html = thread([QUESTION(1), ANSWER(2), QUESTION(3), ANSWER(4)]);
    expect(html.match(/aria-label="Try again"/g)).toHaveLength(1);
  });

  it("does not show Try again under an older answer when the latest question ended with only a tool result", () => {
    const html = thread([QUESTION(1), ANSWER(2), QUESTION(3), TOOL(4)]);
    expect(html).not.toContain('aria-label="Try again"');
  });
});
