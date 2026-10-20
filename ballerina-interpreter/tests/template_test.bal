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

import ballerina/file;
import ballerina/http;
import ballerina/io;
import ballerina/lang.regexp;
import ballerina/os;
import ballerina/test;

@test:Config
function testTheTemplateLoadsAndItsAuthenticationCanBeBuilt() returns error? {
    string text = check io:fileReadString("../templates/agent_template.afm.md");
    string[] names = [];
    foreach regexp:Span span in re `\$\{env:\w+\}`.findAll(text) {
        string name = span.substring().substring(6, span.substring().length() - 1);
        names.push(name);
        check os:setEnv(name, "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    }
    string directory = check file:normalizePath(check file:getAbsolutePath("../templates"), file:CLEAN);

    AFMRecord afm = check parseAfm(text);
    AgentMetadata metadata = check afm.metadata.ensureType();

    Tools tools = check metadata.tools.ensureType();
    MCPServer[] servers = check tools.mcp.ensureType();
    string[] authenticationTypes = [];
    foreach MCPServer server in servers {
        Transport transport = server.transport;
        if transport is HttpTransport {
            ClientAuthentication? authentication = transport.authentication;
            authenticationTypes.push(authentication is () ? "none" : authentication.'type);
            if authentication is BearerAuthentication|BasicAuthentication|JwtAuthentication|() {
                http:ClientAuthConfig? auth = check mcpClientAuth(authentication, directory, "tools.mcp");
                test:assertEquals(auth is (), authentication is ());
            }
        }
    }
    test:assertEquals(authenticationTypes, ["bearer", "basic", "jwt", "none"]);

    Interface[] interfaces = check metadata.interfaces.ensureType();
    WebhookInterface webhook = check interfaces[2].ensureType();
    test:assertTrue((check createHeaderProvider(webhook.subscription.authentication, directory, "interfaces.webhook")) is HeaderProvider);

    foreach string name in names {
        check os:unsetEnv(name);
    }
}
