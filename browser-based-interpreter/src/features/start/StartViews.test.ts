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
import { useImport } from "./StartViews";

const SHARED = "---\nname: Shared\n---\n\n# Role\n\nHelp.\n";

vi.mock("../../core/links/load-paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/links/load-paths")>()),
  normalizeAgentFileUrl: () => ({ ok: true, url: "https://example.com/shared.afm.md" }),
  fetchAgentFile: async () => SHARED,
}));

function importer(onUseSource: (source: string, fromOutside?: boolean) => void): ReturnType<typeof useImport> {
  let handlers: ReturnType<typeof useImport> | undefined;
  function Probe() {
    handlers = useImport(onUseSource);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (handlers === undefined) throw new Error("The hook did not run.");
  return handlers;
}

describe("Opening an agent from the Start dialog", () => {
  it("marks a file as coming from outside, so the trust screen shows first", async () => {
    const onUseSource = vi.fn();
    await importer(onUseSource).openFile(new File([SHARED], "shared.afm.md"));
    expect(onUseSource).toHaveBeenCalledWith(SHARED, true);
  });

  it("marks a link as coming from outside, so the trust screen shows first", async () => {
    const onUseSource = vi.fn();
    await importer(onUseSource).openLink();
    expect(onUseSource).toHaveBeenCalledWith(SHARED, true);
  });
});
