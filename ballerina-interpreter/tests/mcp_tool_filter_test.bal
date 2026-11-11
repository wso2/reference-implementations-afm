// Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com).
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
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.


import ballerina/ai;
import ballerina/test;

isolated class FakeToolKit {
    *ai:McpBaseToolKit;

    private final ai:ToolConfig[] & readonly tools;

    isolated function init(string... names) {
        isolated function caller = noOpTool;
        self.tools = from string name in names
            select {name, description: name, caller};
    }

    public isolated function getTools() returns ai:ToolConfig[] => self.tools;
}

isolated function noOpTool() {
}

type FilterCase record {|
    ToolFilter? filter;
    string[] expected;
|};

function libraryToolKit(ToolFilter? filter, ClientAuthentication? authentication = {token: "abc"}) returns ai:McpBaseToolKit|error =>
    createMcpToolKit({url: MCP_URL, authentication}, filter, check resourcesDirectory(), "tools.mcp[0]");

@test:Config
function testTheDenyListHidesTheDeniedToolsAndKeepsTheOrder() {
    test:assertEquals(toolNames(new DenyListToolKit(new FakeToolKit("a", "b", "c", "d"), ["b", "d"])), ["a", "c"]);
}

@test:Config
function testAnEmptyDenyListHidesNothing() {
    test:assertEquals(toolNames(new DenyListToolKit(new FakeToolKit("a", "b"), [])), ["a", "b"]);
}

@test:Config
function testDenyingUnknownToolsChangesNothing() {
    test:assertEquals(toolNames(new DenyListToolKit(new FakeToolKit("a", "b"), ["c", "A"])), ["a", "b"]);
}

@test:Config
function testDenyingEveryToolLeavesNone() {
    test:assertEquals(toolNames(new DenyListToolKit(new FakeToolKit("a", "b"), ["b", "a"])), []);
}

@test:Config
function testEveryFilterCombinationOnTheLibraryPath() returns error? {
    FilterCase[] cases = [
        {filter: (), expected: ["echo", "hidden"]},
        {filter: {}, expected: ["echo", "hidden"]},
        {filter: {allow: ["echo"]}, expected: ["echo"]},
        {filter: {allow: []}, expected: []},
        {filter: {allow: ["echo", "hidden"], deny: ["hidden"]}, expected: ["echo"]},
        {filter: {allow: ["hidden"], deny: ["hidden"]}, expected: []},
        {filter: {deny: ["hidden"]}, expected: ["echo"]},
        {filter: {deny: ["echo"]}, expected: ["hidden"]},
        {filter: {deny: ["echo", "hidden"]}, expected: []},
        {filter: {deny: []}, expected: ["echo", "hidden"]},
        {filter: {deny: ["missing"]}, expected: ["echo", "hidden"]}
    ];
    foreach FilterCase {filter, expected} in cases {
        resetMcpServer("Bearer ");
        test:assertEquals(toolNames(check libraryToolKit(filter)), expected, filter.toString());
    }
}

@test:Config
function testADenyOnlyFilterHidesTheDeniedToolWithEveryAuthenticationOnTheLibraryPath() returns error? {
    ToolFilter filter = {deny: ["hidden"]};

    resetMcpServer("");
    test:assertEquals(toolNames(check libraryToolKit(filter, ())), ["echo"], "no authentication");

    resetMcpServer("Bearer ");
    test:assertEquals(toolNames(check libraryToolKit(filter, <BearerAuthentication>{token: "abc"})), ["echo"], "bearer");

    resetMcpServer("Basic ");
    test:assertEquals(toolNames(check libraryToolKit(filter, <BasicAuthentication>{username: "u", password: "p"})), ["echo"],
        "basic");

    resetMcpServer("Bearer ");
    test:assertEquals(toolNames(check libraryToolKit(filter, <JwtAuthentication>{issuer: "i", audience: "a",
        signing_key: HMAC_SECRETS.get("HS256"), algorithm: "HS256"})), ["echo"], "jwt");
}
