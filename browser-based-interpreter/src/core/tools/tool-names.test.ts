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
import { displayToolName, namespacedToolName, serverToolId } from "./tool-names";

describe("tool names", () => {
  it.each([
    ["Google Calendar", "Google-Calendar"],
    ["  spaced  out  ", "spaced-out"],
    ["a/b\\c", "a-b-c"],
    ["!!!", "server"],
    ["", "server"],
  ])("makes %j into the id %j", (name, id) => {
    expect(serverToolId(name)).toBe(id);
  });

  it("joins the server's id and the tool's own name with a double underscore, and gives the own name back", () => {
    expect(namespacedToolName("Calendar", "list-events")).toBe("Calendar__list-events");
    expect(displayToolName("Calendar__list-events")).toBe("list-events");
    expect(displayToolName("read_file")).toBe("read_file");
  });

  it("changes a character that providers refuse", () => {
    expect(namespacedToolName("s", "files.read")).toBe("s__files_read");
  });

  it("gives two servers' tools different names even when the tools share a name", () => {
    expect(namespacedToolName("one", "go")).not.toBe(namespacedToolName("two", "go"));
  });
});
