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

import ballerina/ai;
import ballerina/file;
import ballerina/http;
import ballerina/io;
import ballerina/lang.runtime;
import ballerina/test;

// ============================================
// createPlatformHandler — dispatches by interface variant
// ============================================

@test:Config
function testCreatePlatformHandlerSlack() returns error? {
    SlackPlatformChatInterface interface = {
        platform_config: {signing_secret: "shh"}
    };
    PlatformHandler handler = check createPlatformHandler(interface, true);
    test:assertTrue(handler is SlackHandler);
}

@test:Config
function testCreatePlatformHandlerTelegramHttp() returns error? {
    TelegramHttpPlatformChatInterface interface = {
        platform_config: {secret_token: "shh"}
    };
    PlatformHandler handler = check createPlatformHandler(interface, true);
    test:assertTrue(handler is TelegramHandler);
}

@test:Config
function testCreatePlatformHandlerTelegramPolling() returns error? {
    TelegramPollingPlatformChatInterface interface = {
        platform_config: {bot_token: "123:abc"}
    };
    PlatformHandler handler = check createPlatformHandler(interface, false);
    test:assertTrue(handler is TelegramHandler);
}

@test:Config
function testCreatePlatformHandlerRejectsGChat() {
    GChatPlatformChatInterface interface = {
        mode: NOTIFICATION,
        platform_config: {project_number: "12345"}
    };
    PlatformHandler|ConfigError result = createPlatformHandler(interface, true);
    test:assertTrue(result is ConfigError);
}

@test:Config
function testCreatePlatformHandlerPropagatesInitError() {
    // Missing signing_secret with verifySignatures=true → SlackHandler.init errors.
    SlackPlatformChatInterface interface = {platform_config: {}};
    PlatformHandler|ConfigError result = createPlatformHandler(interface, true);
    test:assertTrue(result is ConfigError);
}

// ============================================
// polling interval validation
// ============================================

@test:Config
function testGetPollingIntervalSecondsRejectsZero() {
    decimal|ConfigError result = getPollingIntervalSeconds({interval: 0});
    test:assertTrue(result is ConfigError);
}

@test:Config
function testGetPollingIntervalSecondsRejectsNegative() {
    decimal|ConfigError result = getPollingIntervalSeconds({interval: -1});
    test:assertTrue(result is ConfigError);
}

@test:Config
function testGetPollingIntervalSecondsAcceptsPositive() returns error? {
    decimal result = check getPollingIntervalSeconds({interval: 5});
    test:assertEquals(result, 5.0d);
}

// ============================================
// getPlatformChatHttpPath
// ============================================

@test:Config
function testGetPlatformChatHttpPathSlackDefault() {
    SlackPlatformChatInterface interface = {};
    test:assertEquals(getPlatformChatHttpPath(interface), DEFAULT_SLACK_PATH);
}

@test:Config
function testGetPlatformChatHttpPathSlackOverride() {
    SlackPlatformChatInterface interface = {exposure: {http: {path: "/custom-slack"}}};
    test:assertEquals(getPlatformChatHttpPath(interface), "/custom-slack");
}

@test:Config
function testGetPlatformChatHttpPathTelegramDefault() {
    TelegramHttpPlatformChatInterface interface = {};
    test:assertEquals(getPlatformChatHttpPath(interface), DEFAULT_TELEGRAM_PATH);
}

@test:Config
function testGetPlatformChatHttpPathGChatRoot() {
    GChatPlatformChatInterface interface = {mode: NOTIFICATION};
    test:assertEquals(getPlatformChatHttpPath(interface), DEFAULT_GCHAT_PATH);
}

// ============================================
// GChat HTTP exposure singleton-typed path
// ============================================

@test:Config
function testGChatExposureLiteralPathRejectsOverride() {
    map<json> raw = {http: {path: "/custom"}};
    GChatExposure|error result = raw.cloneWithType();
    test:assertTrue(result is error);
}

@test:Config
function testGChatExposureLiteralPathAcceptsRoot() returns error? {
    map<json> raw = {http: {path: "/"}};
    GChatExposure result = check raw.cloneWithType();
    test:assertEquals(result.http.path, DEFAULT_GCHAT_PATH);
}

// ============================================
// PlatformChatInterface cloneWithType — discrimination by platform + mode
// ============================================

@test:Config
function testPlatformChatInterfaceUnknownPlatformRejected() {
    map<json> raw = {
        'type: "platformchat",
        platform: "unknown",
        mode: "notification"
    };
    PlatformChatInterface|error result = raw.cloneWithType();
    test:assertTrue(result is error);
}

@test:Config
function testPlatformChatInterfaceTelegramRequestRejected() {
    // Telegram doesn't support REQUEST mode — no variant matches.
    map<json> raw = {
        'type: "platformchat",
        platform: "telegram",
        mode: "request"
    };
    PlatformChatInterface|error result = raw.cloneWithType();
    test:assertTrue(result is error);
}

@test:Config
function testPlatformChatInterfaceSlackPollingRejected() {
    // Slack doesn't support POLLING mode.
    map<json> raw = {
        'type: "platformchat",
        platform: "slack",
        mode: "polling"
    };
    PlatformChatInterface|error result = raw.cloneWithType();
    test:assertTrue(result is error);
}

@test:Config
function testPlatformChatInterfaceSlackNotificationAccepted() returns error? {
    map<json> raw = {
        'type: "platformchat",
        platform: "slack",
        mode: "notification"
    };
    PlatformChatInterface result = check raw.cloneWithType();
    test:assertTrue(result is SlackPlatformChatInterface);
}

@test:Config
function testPlatformChatInterfaceGChatRequestAccepted() returns error? {
    map<json> raw = {
        'type: "platformchat",
        platform: "gchat",
        mode: "request"
    };
    PlatformChatInterface result = check raw.cloneWithType();
    test:assertTrue(result is GChatPlatformChatInterface);
}

@test:Config
function testPlatformChatInterfaceTelegramPollingAccepted() returns error? {
    map<json> raw = {
        'type: "platformchat",
        platform: "telegram",
        mode: "polling"
    };
    PlatformChatInterface result = check raw.cloneWithType();
    test:assertTrue(result is TelegramPollingPlatformChatInterface);
}

@test:Config
function testPlatformChatInterfaceTelegramNotificationAccepted() returns error? {
    map<json> raw = {
        'type: "platformchat",
        platform: "telegram",
        mode: "notification"
    };
    PlatformChatInterface result = check raw.cloneWithType();
    test:assertTrue(result is TelegramHttpPlatformChatInterface);
}

// ============================================
// HTTP endpoint integration tests
//
// Bypass main(): parse the AFM, build the ai:Agent, attach the platform
// chat service to a dedicated test listener on a unique port, drive
// requests via http:Client. Each test owns its listener.
// ============================================

const SAMPLE_SLACK_AFM = "tests/sample_slack_notification_agent.afm.md";
const SAMPLE_TELEGRAM_AFM = "tests/sample_telegram_notification_agent.afm.md";
const TELEGRAM_TEST_SECRET = "test-telegram-secret";

isolated function startPlatformChatTestServer(int port, string afmPath) returns http:Listener|error {
    string content = check io:fileReadString(afmPath);
    string afmFileDir = check file:parentPath(check file:getAbsolutePath(afmPath));
    AFMRecord afm = check parseAfm(content);
    ai:Agent agent = check createAgent(afm, afmFileDir);

    Interface[] agentInterfaces = afm?.metadata?.interfaces ?: [];
    NonPollingPlatformChatInterface? targetInterface = ();
    foreach Interface interfaceItem in agentInterfaces {
        if interfaceItem is NonPollingPlatformChatInterface {
            targetInterface = interfaceItem;
            break;
        }
    }
    if targetInterface is () {
        return error(string `No non-polling platformchat interface found in ${afmPath}`);
    }

    http:Listener testListener = check new (port);
    check attachPlatformChatService(testListener, agent, targetInterface);
    check testListener.'start();
    return testListener;
}

isolated function slackTestHeaders(byte[] body) returns map<string|string[]>|error {
    string ts = currentSlackTimestamp();
    return {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": check makeSlackSignature(body, ts)
    };
}

@test:Config
function testSlackNotificationEndpointAcksAndRunsAgent() returns error? {
    int testPort = 28085;
    capturedPrompts = [];
    http:Listener testListener = check startPlatformChatTestServer(testPort, SAMPLE_SLACK_AFM);

    http:Client slackClient = check new (string `http://localhost:${testPort}`);
    json payload = {
        "type": "event_callback",
        "team_id": "T1",
        "event": {"type": "message", "channel": "C1", "user": "U1", "text": "hello slack"}
    };
    byte[] body = payload.toJsonString().toBytes();
    http:Response response = check slackClient->post("/slack", payload, check slackTestHeaders(body));
    test:assertEquals(response.statusCode, 200);

    // Notification mode dispatches the agent in the background; wait for it
    // to call the mock LLM.
    runtime:sleep(2);
    test:assertTrue(capturedPrompts.length() > 0,
            "Expected agent to invoke the mock LLM at least once");
    test:assertTrue(capturedPrompts[0].includes("hello slack"));

    check testListener.gracefulStop();
}

@test:Config
function testSlackEndpointRejectsInvalidSignature() returns error? {
    int testPort = 28094;
    http:Listener testListener = check startPlatformChatTestServer(testPort, SAMPLE_SLACK_AFM);

    http:Client slackClient = check new (string `http://localhost:${testPort}`);
    json payload = {"type": "event_callback", "event": {"type": "message"}};
    http:Response response = check slackClient->post("/slack", payload, {
        "x-slack-request-timestamp": currentSlackTimestamp(),
        "x-slack-signature": "v0=bad"
    });
    test:assertEquals(response.statusCode, 401);

    check testListener.gracefulStop();
}

@test:Config
function testSlackEndpointRejectsInvalidBody() returns error? {
    int testPort = 28087;
    http:Listener testListener = check startPlatformChatTestServer(testPort, SAMPLE_SLACK_AFM);

    http:Client slackClient = check new (string `http://localhost:${testPort}`);
    byte[] body = "not-json".toBytes();
    map<string|string[]> headers = check slackTestHeaders(body);
    headers["Content-Type"] = "application/json";
    http:Response response = check slackClient->post("/slack", body, headers);
    test:assertEquals(response.statusCode, 400);

    check testListener.gracefulStop();
}

@test:Config
function testSlackEndpointUrlVerificationReturnsChallenge() returns error? {
    int testPort = 28088;
    http:Listener testListener = check startPlatformChatTestServer(testPort, SAMPLE_SLACK_AFM);

    http:Client slackClient = check new (string `http://localhost:${testPort}`);
    json payload = {"type": "url_verification", "challenge": "abc123"};
    byte[] body = payload.toJsonString().toBytes();
    http:Response response = check slackClient->post("/slack", payload, check slackTestHeaders(body));
    test:assertEquals(response.statusCode, 200);
    string responseBody = check response.getTextPayload();
    test:assertEquals(responseBody, "abc123");

    check testListener.gracefulStop();
}

// ============================================
// Telegram notification endpoint integration
// ============================================

@test:Config
function testTelegramNotificationEndpointAcksAndRunsAgent() returns error? {
    int testPort = 28090;
    capturedPrompts = [];
    http:Listener testListener =
            check startPlatformChatTestServer(testPort, SAMPLE_TELEGRAM_AFM);

    http:Client telegramClient = check new (string `http://localhost:${testPort}`);
    json payload = {
        "update_id": 1,
        "message": {
            "message_id": 1,
            "from": {"id": 42, "is_bot": false},
            "chat": {"id": 42, "type": "private"},
            "text": "hello telegram"
        }
    };
    http:Response response = check telegramClient->post("/telegram", payload, {
        [TELEGRAM_SECRET_TOKEN_HEADER]: TELEGRAM_TEST_SECRET
    });
    test:assertEquals(response.statusCode, 200);

    runtime:sleep(2);
    test:assertTrue(capturedPrompts.length() > 0,
            "Expected agent to invoke the mock LLM at least once");
    test:assertTrue(capturedPrompts[capturedPrompts.length() - 1].includes("hello telegram"));

    check testListener.gracefulStop();
}

@test:Config
function testTelegramEndpointRejectsBadSecretToken() returns error? {
    int testPort = 28091;
    http:Listener testListener =
            check startPlatformChatTestServer(testPort, SAMPLE_TELEGRAM_AFM);

    http:Client telegramClient = check new (string `http://localhost:${testPort}`);
    json payload = {"update_id": 1, "message": {"text": "hi"}};
    http:Response response = check telegramClient->post("/telegram", payload, {
        [TELEGRAM_SECRET_TOKEN_HEADER]: "wrong-secret"
    });
    test:assertEquals(response.statusCode, 401);

    check testListener.gracefulStop();
}

@test:Config
function testTelegramEndpointRejectsMissingSecretToken() returns error? {
    int testPort = 28092;
    http:Listener testListener =
            check startPlatformChatTestServer(testPort, SAMPLE_TELEGRAM_AFM);

    http:Client telegramClient = check new (string `http://localhost:${testPort}`);
    json payload = {"update_id": 1, "message": {"text": "hi"}};
    http:Response response = check telegramClient->post("/telegram", payload, {});
    test:assertEquals(response.statusCode, 401);

    check testListener.gracefulStop();
}

@test:Config
function testTelegramEndpointIgnoresEditedMessage() returns error? {
    int testPort = 28093;
    capturedPrompts = [];
    http:Listener testListener =
            check startPlatformChatTestServer(testPort, SAMPLE_TELEGRAM_AFM);

    http:Client telegramClient = check new (string `http://localhost:${testPort}`);
    // Updates without a "message" field (edited_message, callback_query, etc.)
    // are not actionable by the default text-reply flow.
    json payload = {
        "update_id": 1,
        "edited_message": {"message_id": 1, "text": "edited"}
    };
    int initialPromptCount = capturedPrompts.length();
    http:Response response = check telegramClient->post("/telegram", payload, {
        [TELEGRAM_SECRET_TOKEN_HEADER]: TELEGRAM_TEST_SECRET
    });
    test:assertEquals(response.statusCode, 200);

    runtime:sleep(1);
    test:assertEquals(capturedPrompts.length(), initialPromptCount,
            "Ignored update should not have triggered the agent");

    check testListener.gracefulStop();
}

// ============================================
// Slack ignore-mid-flow test continues here.
// ============================================

@test:Config
function testSlackEndpointIgnoresMessageChangedSubtype() returns error? {
    int testPort = 28089;
    capturedPrompts = [];
    http:Listener testListener = check startPlatformChatTestServer(testPort, SAMPLE_SLACK_AFM);

    http:Client slackClient = check new (string `http://localhost:${testPort}`);
    json payload = {
        "type": "event_callback",
        "event": {"type": "message", "subtype": "message_changed"}
    };
    byte[] body = payload.toJsonString().toBytes();
    int initialPromptCount = capturedPrompts.length();
    http:Response response = check slackClient->post("/slack", payload, check slackTestHeaders(body));
    test:assertEquals(response.statusCode, 200);

    // Ignored event should NOT have invoked the agent.
    runtime:sleep(1);
    test:assertEquals(capturedPrompts.length(), initialPromptCount,
            "Ignored event should not have triggered the agent");

    check testListener.gracefulStop();
}
