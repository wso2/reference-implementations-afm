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

// ============================================
// verifyTelegramSecretToken
// ============================================

@test:Config
function testVerifyTelegramSecretTokenMatching() {
    test:assertTrue(verifyTelegramSecretToken("abc", "abc"));
}

@test:Config
function testVerifyTelegramSecretTokenMismatch() {
    test:assertFalse(verifyTelegramSecretToken("abc", "xyz"));
}

@test:Config
function testVerifyTelegramSecretTokenMissingHeader() {
    test:assertFalse(verifyTelegramSecretToken((), "abc"));
}

@test:Config
function testVerifyTelegramSecretTokenEmptyReceived() {
    test:assertFalse(verifyTelegramSecretToken("", "abc"));
}

// ============================================
// buildQueryString
// ============================================

@test:Config
function testBuildQueryStringEncodesKeysAndValues() returns error? {
    test:assertEquals(check buildQueryString({"weird=key": "value=1&next"}),
            "?weird%3Dkey=value%3D1%26next");
}

// ============================================
// normalizeTelegramSecret
// ============================================

@test:Config
function testNormalizeTelegramSecretNil() {
    test:assertEquals(normalizeTelegramSecret(()), ());
}

@test:Config
function testNormalizeTelegramSecretEmpty() {
    test:assertEquals(normalizeTelegramSecret(""), ());
}

@test:Config
function testNormalizeTelegramSecretWhitespaceOnly() {
    test:assertEquals(normalizeTelegramSecret("   "), ());
}

@test:Config
function testNormalizeTelegramSecretTrimmed() {
    test:assertEquals(normalizeTelegramSecret("  bot-token  "), "bot-token");
}

@test:Config
function testNormalizeTelegramSecretValid() {
    test:assertEquals(normalizeTelegramSecret("shhh"), "shhh");
}

// ============================================
// shouldIgnoreTelegramUpdate
// ============================================

@test:Config
function testShouldIgnoreTelegramUpdateNonMapPayload() {
    test:assertFalse(shouldIgnoreTelegramUpdate("not a dict"));
}

@test:Config
function testShouldIgnoreTelegramUpdateMessageFromUser() {
    json payload = {
        "update_id": 1,
        "message": {
            "message_id": 1,
            "from": {"id": 42, "is_bot": false},
            "chat": {"id": 42, "type": "private"},
            "text": "hi"
        }
    };
    test:assertFalse(shouldIgnoreTelegramUpdate(payload));
}

@test:Config
function testShouldIgnoreTelegramUpdateMessageFromBot() {
    json payload = {
        "update_id": 1,
        "message": {
            "message_id": 1,
            "from": {"id": 42, "is_bot": true},
            "chat": {"id": 42, "type": "private"},
            "text": "hi"
        }
    };
    test:assertTrue(shouldIgnoreTelegramUpdate(payload));
}

@test:Config
function testShouldIgnoreTelegramUpdateEditedMessage() {
    json payload = {
        "update_id": 1,
        "edited_message": {
            "message_id": 1,
            "from": {"id": 42, "is_bot": false},
            "chat": {"id": 42, "type": "private"},
            "text": "hi (edited)"
        }
    };
    test:assertTrue(shouldIgnoreTelegramUpdate(payload));
}

@test:Config
function testShouldIgnoreTelegramUpdateCallbackQuery() {
    json payload = {"update_id": 1, "callback_query": {"id": "1"}};
    test:assertTrue(shouldIgnoreTelegramUpdate(payload));
}

// ============================================
// getTelegramSessionId
// ============================================

@test:Config
function testGetTelegramSessionIdNonMapPayload() {
    test:assertEquals(getTelegramSessionId("not a dict"), "default");
}

@test:Config
function testGetTelegramSessionIdPrivateChatWithUser() {
    json payload = {
        "message": {
            "from": {"id": 42},
            "chat": {"id": 42, "type": "private"}
        }
    };
    test:assertEquals(getTelegramSessionId(payload), "telegram:42:42");
}

@test:Config
function testGetTelegramSessionIdGroupChatWithUser() {
    json payload = {
        "message": {
            "from": {"id": 99},
            "chat": {"id": -1001234, "type": "supergroup"}
        }
    };
    test:assertEquals(getTelegramSessionId(payload), "telegram:-1001234:99");
}

@test:Config
function testGetTelegramSessionIdMissingUserFallsBackToDefault() {
    json payload = {
        "message": {
            "chat": {"id": -1001234, "type": "channel"}
        }
    };
    test:assertEquals(getTelegramSessionId(payload), "telegram:-1001234:default");
}

@test:Config
function testGetTelegramSessionIdMissingChatUsesUnknown() {
    json payload = {"message": {"from": {"id": 42}}};
    test:assertEquals(getTelegramSessionId(payload), "telegram:unknown-chat:42");
}

@test:Config
function testGetTelegramSessionIdMissingMessageReturnsUnknown() {
    json payload = {};
    test:assertEquals(getTelegramSessionId(payload), "telegram:unknown-chat:default");
}

@test:Config
function testGetTelegramSessionIdStringIdsPassThrough() {
    json payload = {
        "message": {
            "from": {"id": "user-42"},
            "chat": {"id": "chat-42"}
        }
    };
    test:assertEquals(getTelegramSessionId(payload), "telegram:chat-42:user-42");
}

// ============================================
// stringifyId
// ============================================

@test:Config
function testStringifyIdInt() {
    test:assertEquals(stringifyId(42), "42");
}

@test:Config
function testStringifyIdNegativeInt() {
    test:assertEquals(stringifyId(-1001234), "-1001234");
}

@test:Config
function testStringifyIdString() {
    test:assertEquals(stringifyId("chat-42"), "chat-42");
}

@test:Config
function testStringifyIdEmptyString() {
    test:assertEquals(stringifyId(""), ());
}

@test:Config
function testStringifyIdNil() {
    test:assertEquals(stringifyId(()), ());
}

@test:Config
function testStringifyIdNonStringNonInt() {
    test:assertEquals(stringifyId(true), ());
}

// ============================================
// TelegramHandler init (HTTP / notification mode)
// ============================================

@test:Config
function testTelegramHandlerNotificationSecretRequiredWhenVerifying() {
    TelegramHttpPlatformChatInterface interface = {platform_config: {}};
    TelegramHandler|ConfigError result = new TelegramHandler(interface, true);
    test:assertTrue(result is ConfigError);
}

@test:Config
function testTelegramHandlerNotificationSecretNotRequiredWhenNotVerifying() returns error? {
    TelegramHttpPlatformChatInterface interface = {platform_config: {}};
    _ = check new TelegramHandler(interface, false);
}

@test:Config
function testTelegramHandlerNotificationWithSecretPasses() returns error? {
    TelegramHttpPlatformChatInterface interface = {
        platform_config: {secret_token: "shh"}
    };
    _ = check new TelegramHandler(interface, true);
}

@test:Config
function testTelegramHandlerNotificationRejectsEmptySecret() {
    TelegramHttpPlatformChatInterface interface = {
        platform_config: {secret_token: ""}
    };
    TelegramHandler|ConfigError result = new TelegramHandler(interface, true);
    test:assertTrue(result is ConfigError);
}

@test:Config
function testTelegramHandlerNotificationRejectsWhitespaceSecret() {
    TelegramHttpPlatformChatInterface interface = {
        platform_config: {secret_token: "\t \n"}
    };
    TelegramHandler|ConfigError result = new TelegramHandler(interface, true);
    test:assertTrue(result is ConfigError);
}

// ============================================
// TelegramHandler init (polling mode)
// ============================================

@test:Config
function testTelegramHandlerPollingRequiresBotToken() {
    TelegramPollingPlatformChatInterface interface = {platform_config: {}};
    TelegramHandler|ConfigError result = new TelegramHandler(interface, false);
    test:assertTrue(result is ConfigError);
}

@test:Config
function testTelegramHandlerPollingWithBotTokenPasses() returns error? {
    TelegramPollingPlatformChatInterface interface = {
        platform_config: {bot_token: "123:abc"}
    };
    _ = check new TelegramHandler(interface, false);
}

@test:Config
function testTelegramHandlerPollingDoesNotRequireSecretToken() returns error? {
    TelegramPollingPlatformChatInterface interface = {
        platform_config: {bot_token: "123:abc"}
    };
    // verifySignatures = true should still pass — secret_token applies only
    // to the inbound-webhook (notification) path.
    _ = check new TelegramHandler(interface, true);
}

@test:Config
function testTelegramHandlerPollingRejectsEmptyBotToken() {
    TelegramPollingPlatformChatInterface interface = {
        platform_config: {bot_token: ""}
    };
    TelegramHandler|ConfigError result = new TelegramHandler(interface, false);
    test:assertTrue(result is ConfigError);
}

@test:Config
function testTelegramHandlerPollingRejectsWhitespaceBotToken() {
    TelegramPollingPlatformChatInterface interface = {
        platform_config: {bot_token: "   "}
    };
    TelegramHandler|ConfigError result = new TelegramHandler(interface, false);
    test:assertTrue(result is ConfigError);
}

@test:Config
function testTelegramHandlerPollingRejectsTimeoutAboveCap() {
    TelegramPollingPlatformChatInterface interface = {
        platform_config: {bot_token: "123:abc"},
        polling: {timeout: 60}
    };
    TelegramHandler|ConfigError result = new TelegramHandler(interface, false);
    test:assertTrue(result is ConfigError);
}

@test:Config
function testTelegramHandlerPollingRejectsNegativeTimeout() {
    TelegramPollingPlatformChatInterface interface = {
        platform_config: {bot_token: "123:abc"},
        polling: {timeout: -1}
    };
    TelegramHandler|ConfigError result = new TelegramHandler(interface, false);
    test:assertTrue(result is ConfigError);
}

@test:Config
function testTelegramHandlerPollingAcceptsTimeoutAtCap() returns error? {
    TelegramPollingPlatformChatInterface interface = {
        platform_config: {bot_token: "123:abc"},
        polling: {timeout: TELEGRAM_GET_UPDATES_MAX_TIMEOUT}
    };
    _ = check new TelegramHandler(interface, false);
}

// ============================================
// TelegramHandler verifyRawRequest
// ============================================

@test:Config
function testTelegramHandlerVerifyValidSecret() returns error? {
    TelegramHttpPlatformChatInterface interface = {
        platform_config: {secret_token: "shh"}
    };
    TelegramHandler handler = check new TelegramHandler(interface, true);

    map<string|string[]> headers = {[TELEGRAM_SECRET_TOKEN_HEADER]: "shh"};
    SignatureVerificationError|ConfigError? result =
            handler.verifyRawRequest("{}".toBytes(), headers);
    test:assertTrue(result is ());
}

@test:Config
function testTelegramHandlerVerifyInvalidSecret() returns error? {
    TelegramHttpPlatformChatInterface interface = {
        platform_config: {secret_token: "shh"}
    };
    TelegramHandler handler = check new TelegramHandler(interface, true);

    map<string|string[]> headers = {[TELEGRAM_SECRET_TOKEN_HEADER]: "wrong"};
    SignatureVerificationError|ConfigError? result =
            handler.verifyRawRequest("{}".toBytes(), headers);
    test:assertTrue(result is SignatureVerificationError);
}

@test:Config
function testTelegramHandlerVerifyMissingHeader() returns error? {
    TelegramHttpPlatformChatInterface interface = {
        platform_config: {secret_token: "shh"}
    };
    TelegramHandler handler = check new TelegramHandler(interface, true);

    SignatureVerificationError|ConfigError? result =
            handler.verifyRawRequest("{}".toBytes(), {});
    test:assertTrue(result is SignatureVerificationError);
}

@test:Config
function testTelegramHandlerVerifySkippedWhenNotVerifying() returns error? {
    TelegramHttpPlatformChatInterface interface = {
        platform_config: {secret_token: "shh"}
    };
    TelegramHandler handler = check new TelegramHandler(interface, false);

    map<string|string[]> headers = {[TELEGRAM_SECRET_TOKEN_HEADER]: "wrong"};
    SignatureVerificationError|ConfigError? result =
            handler.verifyRawRequest("{}".toBytes(), headers);
    test:assertTrue(result is ());
}

// ============================================
// parseTelegramGetUpdatesResponse
// ============================================

@test:Config
function testParseTelegramResponseOkUpdatesAdvanceCursor() returns error? {
    json body = {ok: true, result: [{update_id: 5}, {update_id: 10}]};
    [json[], map<json>] [updates, nextState] =
            check parseTelegramGetUpdatesResponse(body, {});
    test:assertEquals(updates.length(), 2);
    test:assertEquals(nextState["offset"], 11);
}

@test:Config
function testParseTelegramResponseOkAdvancesPastMaxId() returns error? {
    // Updates may not be ordered; cursor advances to max(update_id) + 1.
    json body = {ok: true, result: [{update_id: 10}, {update_id: 5}, {update_id: 7}]};
    [json[], map<json>] [_, nextState] =
            check parseTelegramGetUpdatesResponse(body, {});
    test:assertEquals(nextState["offset"], 11);
}

@test:Config
function testParseTelegramResponseNotOkReturnsError() {
    [json[], map<json>]|error result =
            parseTelegramGetUpdatesResponse({ok: false, description: "bot blocked"}, {});
    test:assertTrue(result is error);
    if result is error {
        test:assertTrue(result.message().includes("bot blocked"));
    }
}

@test:Config
function testParseTelegramResponseNotOkMissingDescription() {
    [json[], map<json>]|error result =
            parseTelegramGetUpdatesResponse({ok: false}, {});
    test:assertTrue(result is error);
    if result is error {
        test:assertTrue(result.message().includes("no description"));
    }
}

@test:Config
function testParseTelegramResponseEmptyResultKeepsCursor() returns error? {
    [json[], map<json>] [updates, nextState] =
            check parseTelegramGetUpdatesResponse({ok: true, result: []}, {offset: 5});
    test:assertEquals(updates.length(), 0);
    test:assertEquals(nextState["offset"], 5);
}

@test:Config
function testParseTelegramResponseMissingResultDefaultsToEmpty() returns error? {
    [json[], map<json>] [updates, _] =
            check parseTelegramGetUpdatesResponse({ok: true}, {});
    test:assertEquals(updates.length(), 0);
}

@test:Config
function testParseTelegramResponseMalformedResultReturnsError() {
    [json[], map<json>]|error result =
            parseTelegramGetUpdatesResponse({ok: true, result: "not-an-array"}, {});
    test:assertTrue(result is error);
}

@test:Config
function testParseTelegramResponseSkipsNonMapUpdates() returns error? {
    json body = {ok: true, result: [{update_id: 7}, "not-a-map", {update_id: 3}]};
    [json[], map<json>] [_, nextState] =
            check parseTelegramGetUpdatesResponse(body, {});
    test:assertEquals(nextState["offset"], 8);
}

@test:Config
function testParseTelegramResponseSkipsNonIntUpdateIds() returns error? {
    // Spec-violating but defensible — non-int update_id values are ignored,
    // not propagated as the cursor.
    json body = {ok: true, result: [{update_id: "string-id"}, {update_id: 42}]};
    [json[], map<json>] [_, nextState] =
            check parseTelegramGetUpdatesResponse(body, {});
    test:assertEquals(nextState["offset"], 43);
}

@test:Config
function testParseTelegramResponseNonMapBodyReturnsError() {
    [json[], map<json>]|error result =
            parseTelegramGetUpdatesResponse("not a map", {});
    test:assertTrue(result is error);
}
