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

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createOAuthSignIns, relayOAuthCallback } from "./oauth-signin";
import type { ClientMessage } from "../runtime/protocol";

const ORIGIN = "https://app.example.com";

function fakePopup() {
  return {
    closed: false,
    close: vi.fn(function (this: { closed: boolean }) {
      this.closed = true;
    }),
    location: { href: "" },
    opener: {} as object | null,
  };
}

class FakeChannel {
  static all: FakeChannel[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  posted: unknown[] = [];
  constructor(readonly name: string) {
    FakeChannel.all.push(this);
  }
  postMessage(data: unknown) {
    this.posted.push(data);
  }
  close() {
    this.closed = true;
  }
  static deliver(data: unknown) {
    for (const channel of FakeChannel.all.filter((item) => !item.closed)) channel.onmessage?.({ data });
  }
}

function fakeWindow(extra: Record<string, unknown> = {}) {
  const timeouts: (() => void)[] = [];
  return {
    timeouts,
    location: { origin: ORIGIN, search: "" },
    name: "",
    open: vi.fn(),
    setTimeout: (callback: () => void) => timeouts.push(callback),
    clearTimeout: () => {},
    close: vi.fn(),
    ...extra,
  };
}

describe("relayOAuthCallback", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    FakeChannel.all = [];
    vi.stubGlobal("BroadcastChannel", FakeChannel);
  });

  function callbackPage(search: string) {
    const win = fakeWindow({ location: { origin: ORIGIN, search } });
    const body = { textContent: "" };
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", { body });
    return { win, body };
  }

  it("hands the code to whoever started the sign-in, and closes", () => {
    const { win } = callbackPage("?code=abc&state=xyz");
    expect(relayOAuthCallback()).toBe(true);
    expect(FakeChannel.all[0]?.name).toBe("afm-oauth-callback");
    expect(FakeChannel.all[0]?.posted).toEqual([{ code: "abc", state: "xyz" }]);
    expect(win.close).toHaveBeenCalled();
  });

  it("passes the issuer along when the answer names one", () => {
    callbackPage("?code=abc&state=xyz&iss=https%3A%2F%2Fauth.example.com");
    expect(relayOAuthCallback()).toBe(true);
    expect(FakeChannel.all[0]?.posted).toEqual([{ code: "abc", state: "xyz", iss: "https://auth.example.com" }]);
  });

  it("leaves the issuer out when the answer has none", () => {
    callbackPage("?code=abc&state=xyz");
    relayOAuthCallback();
    expect(FakeChannel.all[0]?.posted[0]).not.toHaveProperty("iss");
  });

  it("hands a refusal over too, instead of opening the whole app in the popup", () => {
    const { win } = callbackPage("?error=access_denied&state=xyz");
    expect(relayOAuthCallback()).toBe(true);
    expect(FakeChannel.all[0]?.posted).toEqual([{ error: "access_denied", state: "xyz" }]);
    expect(win.close).toHaveBeenCalled();
  });

  it("passes the issuer along with a refusal too", () => {
    callbackPage("?error=access_denied&state=xyz&iss=https%3A%2F%2Fauth.example.com");
    relayOAuthCallback();
    expect(FakeChannel.all[0]?.posted).toEqual([
      { error: "access_denied", state: "xyz", iss: "https://auth.example.com" },
    ]);
  });

  it("says the window can be closed when the browser will not close it", () => {
    const { body } = callbackPage("?code=abc&state=xyz");
    relayOAuthCallback();
    expect(body.textContent).toBe("You can close this window.");
  });

  it("works with no opener and no window name, which is what a provider that isolates its pages leaves", () => {
    callbackPage("?code=abc&state=xyz");
    expect(window.name).toBe("");
    expect(relayOAuthCallback()).toBe(true);
  });

  it("leaves an ordinary page load alone", () => {
    callbackPage("");
    expect(relayOAuthCallback()).toBe(false);
    expect(FakeChannel.all).toHaveLength(0);
  });

  it("leaves a page alone when the answer carries no state", () => {
    callbackPage("?code=abc");
    expect(relayOAuthCallback()).toBe(false);
  });
});

describe("createOAuthSignIns", () => {
  const provider = {
    authorizeUrl: "https://auth.example.com/authorize",
    tokenUrl: "https://auth.example.com/token",
    clientId: "c",
    resource: "https://mcp.example.com/mcp",
  };
  const AUTHORIZE = "https://auth.example.com/authorize?state=s";

  function setup(navigate = true) {
    const popup = fakePopup();
    const win = fakeWindow();
    win.open.mockReturnValue(popup);
    vi.stubGlobal("window", win);
    const posted: ClientMessage[] = [];
    const deps = { post: (message: ClientMessage) => void posted.push(message) };
    const signIns = createOAuthSignIns(deps);
    const result = signIns.start(provider);
    const startId = (posted[0] as { id: string }).id;
    if (navigate) signIns.onAuthorizeUrl(startId, AUTHORIZE);
    return { popup, win, posted, deps, signIns, result, startId };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    vi.unstubAllGlobals();
    FakeChannel.all = [];
    vi.stubGlobal("BroadcastChannel", FakeChannel);
  });

  it("cuts the pop-up's link back to the AFM tab before sending it to the provider", () => {
    const { popup } = setup();
    expect(popup.opener).toBeNull();
  });

  it("sends the popup to the address the worker built, and relays the code back", async () => {
    const { popup, posted, signIns, result, startId } = setup();
    expect(popup.location.href).toBe(AUTHORIZE);

    FakeChannel.deliver({ code: "abc", state: "s" });
    await settle();
    expect(posted.at(-1)).toEqual({ type: "oauth-signin-code", id: startId, code: "abc", state: "s" });

    signIns.onDone(startId, true);
    expect(await result).toEqual({ status: "signed-in" });
  });

  it("asks the worker to start the sign-in for the provider", async () => {
    const popup = fakePopup();
    const win = fakeWindow();
    win.open.mockReturnValue(popup);
    vi.stubGlobal("window", win);
    const posted: ClientMessage[] = [];
    void createOAuthSignIns({ post: (message) => void posted.push(message) }).start(provider);
    expect(posted[0]).toMatchObject({ type: "oauth-signin-start", provider });
  });

  it("says the pop-up was blocked, and asks the worker for nothing", async () => {
    const win = fakeWindow();
    win.open.mockReturnValue(null);
    vi.stubGlobal("window", win);
    const posted: ClientMessage[] = [];
    const outcome = await createOAuthSignIns({ post: (message) => void posted.push(message) }).start(provider);
    expect(outcome).toEqual({ status: "failed", reason: "Allow pop-ups to sign in." });
    expect(posted).toHaveLength(0);
  });

  it("still hears the answer when the provider has cut the popup loose and it reads as closed", async () => {
    const { popup, posted, signIns, result, startId } = setup();
    popup.closed = true;
    FakeChannel.deliver({ code: "abc", state: "s" });
    await settle();
    expect(posted.at(-1)).toEqual({ type: "oauth-signin-code", id: startId, code: "abc", state: "s" });
    signIns.onDone(startId, true);
    expect(await result).toEqual({ status: "signed-in" });
  });

  it("relays the issuer to the worker when the callback reports one", async () => {
    const { posted, startId } = setup();
    FakeChannel.deliver({ code: "abc", state: "s", iss: "https://auth.example.com" });
    await settle();
    expect(posted.at(-1)).toEqual({
      type: "oauth-signin-code",
      id: startId,
      code: "abc",
      state: "s",
      iss: "https://auth.example.com",
    });
  });

  it("leaves out an issuer that is not a string", async () => {
    const { posted } = setup();
    FakeChannel.deliver({ code: "abc", state: "s", iss: 5 });
    await settle();
    expect(posted.at(-1)).not.toHaveProperty("iss");
  });

  it("hands the provider's refusal to the worker to check, and shows nothing of it yet", async () => {
    const { posted, startId } = setup();
    FakeChannel.deliver({ error: "access_denied", state: "s", iss: "https://auth.example.com" });
    await settle();
    expect(posted.at(-1)).toEqual({
      type: "oauth-signin-error",
      id: startId,
      error: "access_denied",
      state: "s",
      iss: "https://auth.example.com",
    });
    expect(posted.some((message) => message.type === "oauth-signin-code")).toBe(false);
  });

  it("gives the reason the worker reports once the refusal has been checked, and closes the popup", async () => {
    const { popup, signIns, result, startId } = setup();
    FakeChannel.deliver({ error: "access_denied", state: "s" });
    await settle();
    signIns.onDone(startId, false, "The provider declined the sign-in (access_denied).");
    expect(await result).toEqual({
      status: "failed",
      reason: "Sign-in failed: The provider declined the sign-in (access_denied).",
    });
    expect(popup.close).toHaveBeenCalled();
  });

  it("tells the user why the worker could not finish the sign-in", async () => {
    const { signIns, result, startId } = setup();
    signIns.onDone(startId, false, "OAuth2 sign-in state mismatch");
    expect(await result).toEqual({ status: "failed", reason: "Sign-in failed: OAuth2 sign-in state mismatch" });
  });

  it("gives up quietly when no answer ever comes", async () => {
    const { win, result } = setup();
    win.timeouts[0]?.();
    expect(await result).toEqual({ status: "failed" });
  });

  it("gives up when the window is closed before it was sent to the provider", async () => {
    const { popup, win, posted, result } = setup(false);
    popup.closed = true;
    win.timeouts[1]?.();
    win.timeouts[2]?.();
    expect(await result).toEqual({ status: "failed", reason: "The sign-in window was closed before it finished." });
    expect(posted).toHaveLength(1);
  });

  it("does not give up on a window that reads as closed once it is at the provider, which may cut the link", async () => {
    const { popup, win, posted, signIns, startId, result } = setup();
    popup.closed = true;
    win.timeouts[1]?.();
    expect(win.timeouts).toHaveLength(2);
    FakeChannel.deliver({ code: "abc", state: "s" });
    await settle();
    expect(posted.at(-1)).toEqual({ type: "oauth-signin-code", id: startId, code: "abc", state: "s" });
    signIns.onDone(startId, true);
    expect(await result).toEqual({ status: "signed-in" });
  });

  it("does not fail a sign-in whose answer arrived just before the window closed itself", async () => {
    const { popup, win, signIns, startId, result } = setup();
    FakeChannel.deliver({ code: "abc", state: "s" });
    await settle();
    popup.closed = true;
    win.timeouts[1]?.();
    expect(win.timeouts).toHaveLength(2);
    signIns.onDone(startId, true);
    expect(await result).toEqual({ status: "signed-in" });
  });

  it("refuses a second sign-in while the first window is still open", async () => {
    const { win, signIns } = setup();
    const second = await signIns.start(provider);
    expect(second).toEqual({ status: "failed", reason: "Finish the sign-in window that is already open." });
    expect(win.open).toHaveBeenCalledTimes(1);
  });

  it("ignores an answer that belongs to a different sign-in", async () => {
    const { posted, signIns, result, startId } = setup();
    FakeChannel.deliver({ code: "x", state: "someone-else" });
    FakeChannel.deliver({ code: "x" });
    FakeChannel.deliver("not an object");
    await settle();
    expect(posted.filter((message) => message.type === "oauth-signin-code")).toHaveLength(0);
    signIns.onDone(startId, false);
    expect(await result).toEqual({ status: "failed" });
  });

  it("stops listening once the answer has arrived", async () => {
    setup();
    FakeChannel.deliver({ code: "abc", state: "s" });
    await settle();
    expect(FakeChannel.all.every((channel) => channel.closed)).toBe(true);
  });
});

describe("an authorization address that is not https", () => {
  const provider = {
    authorizeUrl: "https://auth.example.com/authorize",
    tokenUrl: "https://auth.example.com/token",
    clientId: "c",
    resource: "https://mcp.example.com/mcp",
  };

  beforeEach(() => {
    vi.unstubAllGlobals();
    FakeChannel.all = [];
    vi.stubGlobal("BroadcastChannel", FakeChannel);
  });

  for (const address of [
    "javascript:alert(1)",
    "http://auth.example.com/authorize?state=s",
    "data:text/html,x",
    "not a url",
  ]) {
    it(`is never opened in the pop-up (${address})`, async () => {
      const popup = fakePopup();
      const win = fakeWindow();
      win.open.mockReturnValue(popup);
      vi.stubGlobal("window", win);
      const posted: ClientMessage[] = [];
      const signIns = createOAuthSignIns({ post: (message: ClientMessage) => void posted.push(message) });
      const result = signIns.start(provider);
      const id = (posted[0] as { id: string }).id;
      signIns.onAuthorizeUrl(id, address);
      expect(popup.location.href).toBe("");
      expect(popup.close).toHaveBeenCalled();
      expect(await result).toMatchObject({ status: "failed" });
    });
  }
});
