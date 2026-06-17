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
import ballerina/http;
import ballerina/log;
import ballerina/time;

const SLACK_SIGNATURE_VERSION = "v0";
const SLACK_SIGNATURE_MAX_AGE_SECONDS = 60 * 5;

type SlackConfig record {|
    string signing_secret?;
|};

type SlackPlatformChatInterface record {|
    *NonPollingPlatformChatInterfaceBase;
    PLATFORM_SLACK platform = PLATFORM_SLACK;
    NOTIFICATION mode = NOTIFICATION;
    SlackConfig platform_config?;
    Exposure exposure = {http: {path: DEFAULT_SLACK_PATH}};
|};

isolated function verifySlackRequestSignature(byte[] body, string? timestamp,
        string? signatureHeader, string signingSecret, int? currentTime = ())
        returns boolean {
    if timestamp is () || signatureHeader is () {
        return false;
    }

    int|error timestampInt = int:fromString(timestamp);
    if timestampInt is error {
        return false;
    }

    int now = currentTime ?: <int> time:utcNow()[0];
    int diff = now - timestampInt;
    if diff < 0 {
        diff = -diff;
    }
    if diff > SLACK_SIGNATURE_MAX_AGE_SECONDS {
        return false;
    }

    string|error bodyStr = string:fromBytes(body);
    if bodyStr is error {
        return false;
    }

    string sigBasestring = string `${SLACK_SIGNATURE_VERSION}:${timestamp}:${bodyStr}`;
    byte[]|crypto:Error hmac = crypto:hmacSha256(sigBasestring.toBytes(), signingSecret.toBytes());
    if hmac is crypto:Error {
        return false;
    }

    string expectedSig = SLACK_SIGNATURE_VERSION + "=" + hmac.toBase16().toLowerAscii();

    return constantTimeEquals(expectedSig, signatureHeader);
}

isolated function constantTimeEquals(string expected, string actual) returns boolean {
    int expectedLength = expected.length();
    if expectedLength != actual.length() {
        return false;
    }
    int diff = 0;
    foreach int index in 0 ..< expectedLength {
        diff = diff | (expected.getCodePoint(index) ^ actual.getCodePoint(index));
    }
    return diff == 0;
}

isolated function getSlackSessionId(json payload) returns string {
    if payload !is map<json> {
        return "default";
    }

    string teamId = nonEmptyString(payload.team_id) ?:
            nonEmptyString(payload.context_team_id) ?: "unknown-team";

    string? payloadType = nonEmptyString(payload.'type);
    if payloadType == "event_callback" {
        json|error event = payload.event;
        if event is map<json> {
            string? channel = nonEmptyString(event.channel);
            string? threadId = nonEmptyString(event.thread_ts) ?:
                    nonEmptyString(event.ts);
            if channel is string && threadId is string {
                return string `slack:${teamId}:${channel}:${threadId}`;
            }

            string? userId = nonEmptyString(event.user) ?:
                    getSlackAuthorizationUser(payload);
            if channel is string && userId is string {
                return string `slack:${teamId}:${channel}:${userId}`;
            }
        }

        string? eventContext = nonEmptyString(payload.event_context);
        if eventContext is string {
            return string `slack:${teamId}:${eventContext}`;
        }

        string? eventId = nonEmptyString(payload.event_id);
        if eventId is string {
            return string `slack:${teamId}:${eventId}`;
        }
    }

    if payloadType == "url_verification" {
        string? challenge = nonEmptyString(payload.challenge);
        if challenge is string {
            return string `slack:${teamId}:url_verification:${challenge}`;
        }
    }

    return string `slack:${teamId}:default`;
}

isolated function getSlackAuthorizationUser(map<json> payload) returns string? {
    json|error authorizations = payload.authorizations;
    if authorizations !is json[] {
        return ();
    }

    foreach json authorization in authorizations {
        if authorization is map<json> {
            string? userId = nonEmptyString(authorization.user_id);
            if userId is string {
                return userId;
            }
        }
    }
    return ();
}

isolated function shouldIgnoreSlackEvent(json payload) returns boolean|error {
    if payload !is map<json> {
        return false;
    }

    string? payloadType = nonEmptyString(payload.'type);
    if payloadType != "event_callback" {
        return payloadType == "app_rate_limited";
    }

    json|error event = payload.event;
    if event !is map<json> {
        log:printWarn("Ignoring event_callback with missing or malformed 'event' field");
        return true;
    }

    // Only process event types the agent can act on. Everything else (e.g.
    // function_executed_success) is ignored.
    string eventType = check event.'type;
    if eventType != "message" && eventType != "app_mention" {
        return true;
    }

    if event["bot_id"] !is () {
        return true;
    }

    // Messages sent via an app (e.g. through the Slack MCP server using a
    // user token) carry an `app_id` but no `bot_id`. Without this check the
    // bot's own replies re-trigger the agent in a loop. Only ignore messages
    // from our own app (matched via the envelope's `api_app_id`) so that
    // messages from other apps can still be handled.
    json eventAppId = event["app_id"];
    if eventAppId !is () && eventAppId == payload["api_app_id"] {
        return true;
    }

    json subtype = event["subtype"];
    if subtype !is string {
        return false;
    }
    return subtype == "bot_message" || subtype == "message_changed" ||
            subtype == "message_deleted" || subtype == "message_replied";
}

isolated class SlackHandler {
    *PlatformHandler;

    private final string? signingSecret;

    isolated function init(SlackPlatformChatInterface interface, boolean verifySignatures)
            returns ConfigError? {
        string? secret = interface?.platform_config?.signing_secret;
        if verifySignatures && secret is () {
            return error ConfigError("Slack platform chat requires " +
                    "platform_config.signing_secret when signature " +
                    "verification is enabled.");
        }
        self.signingSecret = verifySignatures ? secret : ();
    }

    isolated function verifyRawRequest(byte[] body, map<string|string[]> headers)
            returns SignatureVerificationError|ConfigError? {
        string? signingSecret = self.signingSecret;
        if signingSecret is () {
            return;
        }

        string? timestamp = getSingleHeader(headers, "x-slack-request-timestamp");
        string? signatureHeader = getSingleHeader(headers, "x-slack-signature");

        if !verifySlackRequestSignature(body, timestamp, signatureHeader, signingSecret) {
            return error SignatureVerificationError("Invalid Slack signature");
        }
    }

    isolated function verifyParsedPayload(json payload) returns SignatureVerificationError? {
        // Slack signature is verified pre-parse; nothing extra needed here.
    }

    isolated function handlePreDispatch(json payload) returns PreDispatchResponse? {
        if payload !is map<json> {
            return ();
        }
        if payload["type"] != "url_verification" {
            return ();
        }
        json challenge = payload["challenge"];
        if challenge !is string {
            return {
                statusCode: 400,
                body: {detail: "Slack URL verification payload must contain a challenge"}
            };
        }
        return {statusCode: 200, body: challenge, contentType: "text/plain"};
    }

    isolated function shouldIgnore(json payload) returns boolean|error =>
            shouldIgnoreSlackEvent(payload);

    isolated function createIgnoredResponse() returns http:Response {
        http:Response response = new;
        response.statusCode = 200;
        return response;
    }

    isolated function getSessionId(json payload) returns string => getSlackSessionId(payload);

    isolated function createNotificationAck() returns http:Response|ConfigError {
        http:Response response = new;
        response.statusCode = 200;
        return response;
    }

    isolated function createRequestResponse(json result) returns http:Response|ConfigError {
        return error ConfigError("Platform 'slack' does not support request mode");
    }

    isolated function pollUpdates(map<json> state) returns [json[], map<json>]|error {
        return error("Platform 'slack' does not support polling mode");
    }
}

isolated function getSingleHeader(map<string|string[]> headers, string name)
        returns string? {
    string|string[]? value = headers[name];
    if value is () {
        // Case-insensitive lookup fallback.
        foreach var [k, v] in headers.entries() {
            if k.toLowerAscii() == name.toLowerAscii() {
                value = v;
                break;
            }
        }
    }
    if value is () {
        return ();
    }
    if value is string {
        return value;
    }
    if value.length() == 0 {
        return ();
    }
    return value[0];
}
