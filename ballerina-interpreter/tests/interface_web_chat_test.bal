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
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import ballerina/test;

@test:Config
function testWebChatInterfaceDefaultValues() {
    WebChatInterface webChat = {};

    // Verify default values
    test:assertEquals(webChat.'type, WEB_CHAT);
    test:assertEquals(webChat.signature.input.'type, "string");
    test:assertEquals(webChat.signature.output.'type, "string");
    test:assertEquals(webChat.exposure.http?.path, "/chat");
}

@test:Config
function testWebChatInterfaceCustomPath() {
    WebChatInterface webChat = {
        exposure: {http: {path: "/custom"}}
    };

    test:assertEquals(webChat.exposure.http?.path, "/custom");
}

@test:Config
function testWebChatInterfaceCustomSignature() {
    WebChatInterface webChat = {
        signature: {
            input: {"type": "object", "properties": {"message": {"type": "string"}}},
            output: {"type": "object", "properties": {"response": {"type": "string"}}}
        }
    };

    test:assertEquals(webChat.signature.input.'type, "object");
    test:assertEquals(webChat.signature.output.'type, "object");
}
