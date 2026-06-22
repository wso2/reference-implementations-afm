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

import ballerina/test;
import ballerinax/googleapis.chat;

// ============================================
// shouldIgnoreGChatMessageEvent
//
// The trigger filters non-MESSAGE event types, so only the
// human-vs-bot sender path is exercised here. REMOVED_FROM_SPACE,
// CARD_CLICKED, missing-type, and other event-type filtering are
// type-system invariants — those events route to different remote
// functions (or none).
// ============================================

@test:Config
function testShouldIgnoreGChatMessageEventHumanSender() {
    chat:MessageEvent event = {
        'type: chat:MESSAGE,
        message: {sender: {'type: chat:HUMAN}}
    };
    test:assertFalse(shouldIgnoreGChatMessageEvent(event));
}

@test:Config
function testShouldIgnoreGChatMessageEventBotSender() {
    chat:MessageEvent event = {
        'type: chat:MESSAGE,
        message: {sender: {'type: chat:BOT}}
    };
    test:assertTrue(shouldIgnoreGChatMessageEvent(event));
}

@test:Config
function testShouldIgnoreGChatMessageEventMissingSender() {
    chat:MessageEvent event = {
        'type: chat:MESSAGE,
        message: {}
    };
    test:assertFalse(shouldIgnoreGChatMessageEvent(event));
}

// ============================================
// getGChatSessionId
// ============================================

@test:Config
function testGetGChatSessionIdSpaceAndUser() {
    json payload = {
        "type": "MESSAGE",
        "space": {"name": "spaces/AAAA"},
        "message": {"text": "hello"},
        "user": {"name": "users/CCCC"}
    };
    test:assertEquals(getGChatSessionId(payload), "gchat:spaces/AAAA:users/CCCC");
}

@test:Config
function testGetGChatSessionIdSpaceOnlyFallback() {
    json payload = {
        "type": "MESSAGE",
        "space": {"name": "spaces/AAAA"}
    };
    test:assertEquals(getGChatSessionId(payload), "gchat:spaces/AAAA:default");
}

@test:Config
function testGetGChatSessionIdNoSpace() {
    json payload = {"type": "MESSAGE"};
    test:assertEquals(getGChatSessionId(payload), "gchat:unknown-space:default");
}

@test:Config
function testGetGChatSessionIdNonMapPayload() {
    test:assertEquals(getGChatSessionId("not a dict"), "default");
}

@test:Config
function testGetGChatSessionIdEmptySpaceName() {
    json payload = {"type": "MESSAGE", "space": {"name": ""}};
    test:assertEquals(getGChatSessionId(payload), "gchat:unknown-space:default");
}

// ============================================
// GChatConfig union discrimination
//
// These exercise the type-system invariant: at parse/cloneWithType time,
// only valid discriminated configs match. Both fields set or unknown
// fields trip the union.
// ============================================

@test:Config
function testGChatConfigProjectNumberOnlyValid() returns error? {
    GChatConfig config = check {"project_number": "12345"}.cloneWithType();
    test:assertTrue(config is GChatProjectNumberOnly);
}

@test:Config
function testGChatConfigEndpointUrlOnlyValid() returns error? {
    GChatConfig config = check {"endpoint_url": "https://example.com"}.cloneWithType();
    test:assertTrue(config is GChatEndpointUrlOnly);
}

@test:Config
function testGChatConfigBothFieldsRejected() {
    GChatConfig|error config = {
        "project_number": "12345",
        "endpoint_url": "https://example.com"
    }.cloneWithType();
    test:assertTrue(config is error);
}

@test:Config
function testGChatConfigEmptyRejected() {
    map<json> empty = {};
    GChatConfig|error config = empty.cloneWithType();
    test:assertTrue(config is error);
}

@test:Config
function testGChatConfigUnknownFieldRejected() {
    GChatConfig|error config = {
        "project_number": "12345",
        "unexpected_field": "x"
    }.cloneWithType();
    test:assertTrue(config is error);
}

// ============================================
// getGChatServiceConfig
// ============================================

@test:Config
function testGetGChatServiceConfigNil() {
    test:assertEquals(getGChatServiceConfig(()), ());
}

@test:Config
function testGetGChatServiceConfigEndpointUrl() {
    GChatEndpointUrlOnly config = {endpoint_url: "https://example.com"};
    chat:ServiceConfiguration? result = getGChatServiceConfig(config);
    if result is chat:HttpEndpointUrlConfig {
        test:assertEquals(result.endpointUrl, "https://example.com");
    } else {
        test:assertFail("expected HttpEndpointUrlConfig");
    }
}

@test:Config
function testGetGChatServiceConfigProjectNumberString() {
    GChatProjectNumberOnly config = {project_number: "12345"};
    chat:ServiceConfiguration? result = getGChatServiceConfig(config);
    if result is chat:ProjectNumberConfig {
        test:assertEquals(result.projectNumber, "12345");
    } else {
        test:assertFail("expected ProjectNumberConfig");
    }
}

@test:Config
function testGetGChatServiceConfigProjectNumberInt() {
    GChatProjectNumberOnly config = {project_number: 12345};
    chat:ServiceConfiguration? result = getGChatServiceConfig(config);
    if result is chat:ProjectNumberConfig {
        test:assertEquals(result.projectNumber, "12345");
    } else {
        test:assertFail("expected ProjectNumberConfig");
    }
}

@test:Config
function testGetGChatServiceConfigEmptyEndpointUrl() {
    GChatEndpointUrlOnly config = {endpoint_url: "   "};
    test:assertEquals(getGChatServiceConfig(config), ());
}

@test:Config
function testGetGChatServiceConfigEmptyProjectNumberString() {
    GChatProjectNumberOnly config = {project_number: "   "};
    test:assertEquals(getGChatServiceConfig(config), ());
}
