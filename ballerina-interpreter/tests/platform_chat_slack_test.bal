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

import ballerina/crypto;
import ballerina/test;
import ballerina/time;

const string TEST_SLACK_SIGNING_SECRET = "test-slack-signing-secret";
const string TEST_SLACK_TIMESTAMP = "1531420618";

isolated function currentSlackTimestamp() returns string {
    [int, decimal] now = time:utcNow();
    return now[0].toString();
}

isolated function makeSlackSignature(byte[] body, string? overrideTimestamp = ()) returns string|error {
    string timestamp = overrideTimestamp ?: TEST_SLACK_TIMESTAMP;
    string sigBasestring = string `v0:${timestamp}:${check string:fromBytes(body)}`;
    byte[] hmac = check crypto:hmacSha256(sigBasestring.toBytes(),
            TEST_SLACK_SIGNING_SECRET.toBytes());
    return "v0=" + hmac.toBase16().toLowerAscii();
}

// ============================================
// verifySlackRequestSignature
// ============================================

@test:Config
function testVerifySlackSignatureValid() returns error? {
    byte[] body = "{\"event\":\"test\"}".toBytes();
    string sig = check makeSlackSignature(body);
    boolean result = verifySlackRequestSignature(body, TEST_SLACK_TIMESTAMP, sig,
            TEST_SLACK_SIGNING_SECRET, check int:fromString(TEST_SLACK_TIMESTAMP));
    test:assertTrue(result);
}

@test:Config
function testVerifySlackSignatureInvalid() returns error? {
    byte[] body = "{\"event\":\"test\"}".toBytes();
    boolean result = verifySlackRequestSignature(body, TEST_SLACK_TIMESTAMP, "v0=bad",
            TEST_SLACK_SIGNING_SECRET, check int:fromString(TEST_SLACK_TIMESTAMP));
    test:assertFalse(result);
}

@test:Config
function testVerifySlackSignatureMissingTimestamp() returns error? {
    byte[] body = "{\"event\":\"test\"}".toBytes();
    string sig = check makeSlackSignature(body);
    boolean result = verifySlackRequestSignature(body, (), sig, TEST_SLACK_SIGNING_SECRET);
    test:assertFalse(result);
}

@test:Config
function testVerifySlackSignatureMissingSignatureHeader() {
    byte[] body = "{\"event\":\"test\"}".toBytes();
    boolean result = verifySlackRequestSignature(body, TEST_SLACK_TIMESTAMP, (),
            TEST_SLACK_SIGNING_SECRET);
    test:assertFalse(result);
}

@test:Config
function testVerifySlackSignatureInvalidUtf8Body() returns error? {
    byte[] body = [0xFF, 0xFE, 0xFD];
    boolean result = verifySlackRequestSignature(body, TEST_SLACK_TIMESTAMP, "v0=anything",
            TEST_SLACK_SIGNING_SECRET, check int:fromString(TEST_SLACK_TIMESTAMP));
    test:assertFalse(result);
}

@test:Config
function testVerifySlackSignatureNonNumericTimestamp() returns error? {
    byte[] body = "{\"event\":\"test\"}".toBytes();
    string sig = check makeSlackSignature(body, "not-a-number");
    boolean result = verifySlackRequestSignature(body, "not-a-number", sig,
            TEST_SLACK_SIGNING_SECRET);
    test:assertFalse(result);
}

@test:Config
function testVerifySlackSignatureExpiredTimestamp() returns error? {
    byte[] body = "{\"event\":\"test\"}".toBytes();
    string oldTs = "1000000000";
    string sig = check makeSlackSignature(body, oldTs);
    boolean result = verifySlackRequestSignature(body, oldTs, sig,
            TEST_SLACK_SIGNING_SECRET, 1000000000 + 60 * 5 + 1);
    test:assertFalse(result);
}

@test:Config
function testVerifySlackSignatureTimestampWithinTolerance() returns error? {
    byte[] body = "{\"event\":\"test\"}".toBytes();
    string ts = "1000000000";
    string sig = check makeSlackSignature(body, ts);
    boolean result = verifySlackRequestSignature(body, ts, sig,
            TEST_SLACK_SIGNING_SECRET, 1000000000 + 60 * 5);
    test:assertTrue(result);
}

@test:Config
function testVerifySlackSignatureWrongSecret() returns error? {
    byte[] body = "{\"event\":\"test\"}".toBytes();
    string sig = check makeSlackSignature(body);
    boolean result = verifySlackRequestSignature(body, TEST_SLACK_TIMESTAMP, sig,
            "wrong-secret", check int:fromString(TEST_SLACK_TIMESTAMP));
    test:assertFalse(result);
}

// ============================================
// shouldIgnoreSlackEvent
// ============================================

@test:Config
function testShouldIgnoreSlackEventNonMapPayload() returns error? {
    boolean|error result = shouldIgnoreSlackEvent("not a dict");
    test:assertEquals(result, false);
}

@test:Config
function testShouldIgnoreSlackEventAppRateLimited() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({"type": "app_rate_limited"});
    test:assertEquals(result, true);
}

@test:Config
function testShouldIgnoreSlackEventUrlVerification() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({"type": "url_verification"});
    test:assertEquals(result, false);
}

@test:Config
function testShouldIgnoreSlackEventCallbackMissingEvent() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({"type": "event_callback"});
    test:assertEquals(result, true);
}

@test:Config
function testShouldIgnoreSlackEventCallbackNonMapEvent() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({
        "type": "event_callback",
        "event": "not-a-dict"
    });
    test:assertEquals(result, true);
}

@test:Config
function testShouldIgnoreSlackMessageEventNotIgnored() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({
        "type": "event_callback",
        "event": {"type": "message"}
    });
    test:assertEquals(result, false);
}

@test:Config
function testShouldIgnoreSlackAppMentionEventNotIgnored() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({
        "type": "event_callback",
        "event": {"type": "app_mention"}
    });
    test:assertEquals(result, false);
}

@test:Config
function testShouldIgnoreSlackUnknownEventType() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({
        "type": "event_callback",
        "event": {"type": "reaction_added"}
    });
    test:assertEquals(result, true);
}

@test:Config
function testShouldIgnoreSlackBotMessage() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({
        "type": "event_callback",
        "event": {"type": "message", "bot_id": "B123"}
    });
    test:assertEquals(result, true);
}

@test:Config
function testShouldIgnoreSlackOwnAppMessage() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({
        "type": "event_callback",
        "api_app_id": "A111",
        "event": {"type": "message", "app_id": "A111"}
    });
    test:assertEquals(result, true);
}

@test:Config
function testShouldIgnoreSlackOtherAppMessage() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({
        "type": "event_callback",
        "api_app_id": "A111",
        "event": {"type": "message", "app_id": "A222"}
    });
    test:assertEquals(result, false);
}

@test:Config
function testShouldIgnoreSlackMessageChangedSubtype() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({
        "type": "event_callback",
        "event": {"type": "message", "subtype": "message_changed"}
    });
    test:assertEquals(result, true);
}

@test:Config
function testShouldIgnoreSlackMessageDeletedSubtype() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({
        "type": "event_callback",
        "event": {"type": "message", "subtype": "message_deleted"}
    });
    test:assertEquals(result, true);
}

@test:Config
function testShouldIgnoreSlackBotMessageSubtype() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({
        "type": "event_callback",
        "event": {"type": "message", "subtype": "bot_message"}
    });
    test:assertEquals(result, true);
}

@test:Config
function testShouldIgnoreSlackMessageRepliedSubtype() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({
        "type": "event_callback",
        "event": {"type": "message", "subtype": "message_replied"}
    });
    test:assertEquals(result, true);
}

@test:Config
function testShouldIgnoreSlackUnknownSubtype() returns error? {
    boolean|error result = shouldIgnoreSlackEvent({
        "type": "event_callback",
        "event": {"type": "message", "subtype": "something_else"}
    });
    test:assertEquals(result, false);
}

// ============================================
// getSlackSessionId
// ============================================

@test:Config
function testGetSlackSessionIdNonMapPayload() {
    test:assertEquals(getSlackSessionId("not a dict"), "default");
}

@test:Config
function testGetSlackSessionIdEventCallbackChannelAndThreadTs() {
    json payload = {
        "type": "event_callback",
        "team_id": "T1",
        "event": {"channel": "C1", "thread_ts": "12.34", "ts": "56.78"}
    };
    test:assertEquals(getSlackSessionId(payload), "slack:T1:C1:12.34");
}

@test:Config
function testGetSlackSessionIdEventCallbackChannelAndTsFallback() {
    json payload = {
        "type": "event_callback",
        "team_id": "T1",
        "event": {"channel": "C1", "ts": "56.78"}
    };
    test:assertEquals(getSlackSessionId(payload), "slack:T1:C1:56.78");
}

@test:Config
function testGetSlackSessionIdEventCallbackChannelAndUserFallback() {
    json payload = {
        "type": "event_callback",
        "team_id": "T1",
        "event": {"channel": "C1", "user": "U1"}
    };
    test:assertEquals(getSlackSessionId(payload), "slack:T1:C1:U1");
}

@test:Config
function testGetSlackSessionIdEventCallbackAuthorizationUserFallback() {
    json payload = {
        "type": "event_callback",
        "team_id": "T1",
        "authorizations": [{"user_id": "U2"}],
        "event": {"channel": "C1"}
    };
    test:assertEquals(getSlackSessionId(payload), "slack:T1:C1:U2");
}

@test:Config
function testGetSlackSessionIdEventCallbackEventContextFallback() {
    json payload = {
        "type": "event_callback",
        "team_id": "T1",
        "event_context": "ctx-123",
        "event": {}
    };
    test:assertEquals(getSlackSessionId(payload), "slack:T1:ctx-123");
}

@test:Config
function testGetSlackSessionIdEventCallbackEventIdFallback() {
    json payload = {
        "type": "event_callback",
        "team_id": "T1",
        "event_id": "Ev9",
        "event": {}
    };
    test:assertEquals(getSlackSessionId(payload), "slack:T1:Ev9");
}

@test:Config
function testGetSlackSessionIdEventCallbackDefaultFallback() {
    json payload = {
        "type": "event_callback",
        "team_id": "T1",
        "event": {}
    };
    test:assertEquals(getSlackSessionId(payload), "slack:T1:default");
}

@test:Config
function testGetSlackSessionIdUrlVerification() {
    json payload = {
        "type": "url_verification",
        "team_id": "T1",
        "challenge": "abc123"
    };
    test:assertEquals(getSlackSessionId(payload), "slack:T1:url_verification:abc123");
}

@test:Config
function testGetSlackSessionIdUnknownTeamFallback() {
    json payload = {"type": "event_callback", "event": {"type": "message"}};
    test:assertTrue(getSlackSessionId(payload).startsWith("slack:unknown-team:"));
}

@test:Config
function testGetSlackSessionIdContextTeamIdFallback() {
    json payload = {
        "type": "event_callback",
        "context_team_id": "T2",
        "event": {"channel": "C1", "user": "U1"}
    };
    test:assertEquals(getSlackSessionId(payload), "slack:T2:C1:U1");
}

@test:Config
function testGetSlackSessionIdGenericTypeReturnsTeamDefault() {
    json payload = {"type": "other", "team_id": "T1"};
    test:assertEquals(getSlackSessionId(payload), "slack:T1:default");
}

// ============================================
// SlackHandler init + verifyRawRequest
// ============================================

@test:Config
function testSlackHandlerInitRequiresSigningSecretWhenVerifying() {
    SlackPlatformChatInterface interface = {platform_config: {}};
    SlackHandler|ConfigError result = new SlackHandler(interface, true);
    test:assertTrue(result is ConfigError);
}

@test:Config
function testSlackHandlerInitMissingSecretOkWhenNotVerifying() returns error? {
    SlackPlatformChatInterface interface = {platform_config: {}};
    SlackHandler handler = check new SlackHandler(interface, false);
    SignatureVerificationError|ConfigError? result =
            handler.verifyRawRequest("{}".toBytes(), {});
    test:assertTrue(result is ());
}

@test:Config
function testSlackHandlerInitWithSecretPasses() returns error? {
    SlackPlatformChatInterface interface = {
        platform_config: {signing_secret: "shh"}
    };
    _ = check new SlackHandler(interface, true);
}

@test:Config
function testSlackHandlerVerifyRawRequestValidSignature() returns error? {
    SlackPlatformChatInterface interface = {
        platform_config: {signing_secret: TEST_SLACK_SIGNING_SECRET}
    };
    SlackHandler handler = check new SlackHandler(interface, true);

    byte[] body = "{\"event\":\"test\"}".toBytes();
    string ts = currentSlackTimestamp();
    map<string|string[]> headers = {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": check makeSlackSignature(body, ts)
    };
    SignatureVerificationError|ConfigError? result = handler.verifyRawRequest(body, headers);
    test:assertTrue(result is ());
}

@test:Config
function testSlackHandlerVerifyRawRequestInvalidSignature() returns error? {
    SlackPlatformChatInterface interface = {
        platform_config: {signing_secret: TEST_SLACK_SIGNING_SECRET}
    };
    SlackHandler handler = check new SlackHandler(interface, true);

    byte[] body = "{\"event\":\"test\"}".toBytes();
    map<string|string[]> headers = {
        "x-slack-request-timestamp": TEST_SLACK_TIMESTAMP,
        "x-slack-signature": "v0=bad"
    };
    SignatureVerificationError|ConfigError? result = handler.verifyRawRequest(body, headers);
    test:assertTrue(result is SignatureVerificationError);
}

@test:Config
function testSlackHandlerVerifyRawRequestSkippedWhenNotVerifying() returns error? {
    SlackPlatformChatInterface interface = {
        platform_config: {signing_secret: TEST_SLACK_SIGNING_SECRET}
    };
    SlackHandler handler = check new SlackHandler(interface, false);

    // Wrong signature, but verifySignatures was false — should pass through.
    map<string|string[]> headers = {
        "x-slack-request-timestamp": TEST_SLACK_TIMESTAMP,
        "x-slack-signature": "v0=bad"
    };
    SignatureVerificationError|ConfigError? result =
            handler.verifyRawRequest("{}".toBytes(), headers);
    test:assertTrue(result is ());
}

// ============================================
// constantTimeEquals
// ============================================

@test:Config
function testConstantTimeEqualsMatching() {
    test:assertTrue(constantTimeEquals("v0=abc123", "v0=abc123"));
}

@test:Config
function testConstantTimeEqualsDifferentLength() {
    test:assertFalse(constantTimeEquals("short", "longer-string"));
}

@test:Config
function testConstantTimeEqualsSameLengthDifferent() {
    test:assertFalse(constantTimeEquals("v0=abc123", "v0=xyz123"));
}
