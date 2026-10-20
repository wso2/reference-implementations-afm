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

import ballerina/os;
import ballerina/test;

function authAfm(string frontMatter) returns string =>
    string `---${"\n"}${frontMatter}---${"\n"}# Role${"\n"}r${"\n"}# Instructions${"\n"}i${"\n"}`;

@test:Config
function testVariablesAreResolvedInsideNestedAuthenticationValues() returns error? {
    check os:setEnv("AUTH_TEST_SCOPE", "read");
    check os:setEnv("AUTH_TEST_TENANT", "t1");
    string frontMatter = "tools:\n  mcp:\n    - name: server\n      transport:\n        type: http\n        url: https://mcp.example.com\n" +
        "        authentication:\n          type: oauth2\n          grant_type: client_credentials\n" +
        "          token_url: https://idp.example.com/token\n          client_id: id\n          client_secret: secret\n" +
        "          scopes: [\"${env:AUTH_TEST_SCOPE}\"]\n          extra_params:\n            tenant: \"${env:AUTH_TEST_TENANT}\"\n";

    AFMRecord afm = check parseAfm(authAfm(frontMatter));

    AgentMetadata metadata = check afm.metadata.ensureType();
    Tools tools = check metadata.tools.ensureType();
    MCPServer[] servers = check tools.mcp.ensureType();
    HttpTransport transport = check servers[0].transport.ensureType();
    OAuth2Authentication auth = check transport.authentication.ensureType();
    test:assertEquals(auth?.scopes, ["read"]);
    test:assertEquals(auth?.extra_params, {"tenant": "t1"});
    check os:unsetEnv("AUTH_TEST_SCOPE");
    check os:unsetEnv("AUTH_TEST_TENANT");
}

@test:Config
function testAResolvedAuthenticationValueIsValidatedWithoutEchoingIt() returns error? {
    check os:setEnv("AUTH_TEST_TOKEN", "has a space");
    string frontMatter = "model:\n  provider: openai\n  name: gpt-4o\n  authentication:\n    type: bearer\n    token: \"${env:AUTH_TEST_TOKEN}\"\n";

    AFMRecord|error result = parseAfm(authAfm(frontMatter));

    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(),
        "model.authentication: type 'bearer': field 'token' must not contain whitespace");
    check os:unsetEnv("AUTH_TEST_TOKEN");
}
