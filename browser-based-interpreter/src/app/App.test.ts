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

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./App";

describe("ErrorBoundary", () => {
  it("shows the page as normal while nothing has failed", () => {
    const html = renderToStaticMarkup(createElement(ErrorBoundary, null, createElement("p", null, "all good")));
    expect(html).toBe("<p>all good</p>");
  });

  it("turns a thrown render error into the failed state", () => {
    expect(ErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it("offers a reload instead of a blank page once it has failed", () => {
    const boundary = new ErrorBoundary({ children: createElement("p", null, "broken page") });
    boundary.state = ErrorBoundary.getDerivedStateFromError();
    const html = renderToStaticMarkup(boundary.render() as never);
    expect(html).toContain("Something went wrong");
    expect(html).toContain("Reload");
    expect(html).toContain("Your saved agents are untouched");
    expect(html).toContain("Keys are kept only in memory");
    expect(html).not.toContain("broken page");
  });

  it("records the error so it can be diagnosed", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("boom");
    new ErrorBoundary({ children: null }).componentDidCatch(failure);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Error: boom"));
    log.mockRestore();
  });

  it("hides a key that appears in the error before it is logged", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    new ErrorBoundary({ children: null }).componentDidCatch(new Error("failed with sk-abcdefghijklmnop1234"));
    expect(log.mock.calls[0]?.[0]).not.toContain("sk-abcdefghijklmnop1234");
    log.mockRestore();
  });
});
