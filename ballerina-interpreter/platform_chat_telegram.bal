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

import ballerina/http;
import ballerina/log;
import ballerina/url;

// Header Telegram echoes from `setWebhook?secret_token=...` on every webhook
// delivery. Used as a shared-secret check in lieu of HMAC signing.
const TELEGRAM_SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token";

const TELEGRAM_API_BASE = "https://api.telegram.org";

// Telegram caps getUpdates long-poll at 50s; we add headroom for client/server
// clock drift before the HTTP read times out.
const TELEGRAM_HTTP_TIMEOUT_PADDING = 10.0d;

// Telegram's documented upper bound on the getUpdates `timeout` parameter
// (https://core.telegram.org/bots/api#getupdates). Values above this are
// rejected by the API; we reject them at validate time instead.
const TELEGRAM_GET_UPDATES_MAX_TIMEOUT = 50;

type TelegramConfig record {|
    // Required for polling mode (used as the bot's API credential in the
    // getUpdates URL). Optional for notification mode, which only needs
    // secret_token for inbound verification.
    string bot_token?;
    string secret_token?;
|};

type TelegramHttpPlatformChatInterface record {|
    *NonPollingPlatformChatInterfaceBase;
    PLATFORM_TELEGRAM platform = PLATFORM_TELEGRAM;
    NOTIFICATION mode = NOTIFICATION;
    TelegramConfig platform_config?;
    Exposure exposure = {http: {path: DEFAULT_TELEGRAM_PATH}};
|};

type TelegramPollingPlatformChatInterface record {|
    *BasePlatformChatInterface;
    PLATFORM_TELEGRAM platform = PLATFORM_TELEGRAM;
    POLLING mode = POLLING;
    TelegramConfig platform_config?;
    Polling polling = {};
    ClientAuthentication authentication?;
|};

// Normalize blank/whitespace credentials to (). Telegram bot tokens and
// webhook secret tokens never legitimately contain leading/trailing
// whitespace, so a blank or whitespace-only value almost certainly means an
// unset env var or templating mistake. Treating them as missing keeps the
// `if value is ()` checks below in one place.
isolated function normalizeTelegramSecret(string? value) returns string? {
    if value is () {
        return ();
    }
    string trimmed = value.trim();
    if trimmed == "" {
        return ();
    }
    return trimmed;
}

isolated function telegramConfigFor(PlatformChatInterface interface) returns TelegramConfig? {
    TelegramConfig? config = interface is TelegramHttpPlatformChatInterface
            || interface is TelegramPollingPlatformChatInterface
        ? interface?.platform_config
        : ();
    if config is () {
        return ();
    }
    return {
        bot_token: normalizeTelegramSecret(config.bot_token),
        secret_token: normalizeTelegramSecret(config.secret_token)
    };
}

isolated function verifyTelegramSecretToken(string? received, string expected)
        returns boolean {
    if received is () {
        return false;
    }
    return constantTimeEquals(expected, received);
}

isolated function getTelegramSessionId(json payload) returns string {
    if payload !is map<json> {
        return "default";
    }

    json|error message = payload.message;
    if message !is map<json> {
        return "telegram:unknown-chat:default";
    }

    json|error chat = message.chat;
    string chatId = chat is map<json> ? (stringifyId(chat.id) ?: "unknown-chat") :
            "unknown-chat";

    json|error sender = message.'from;
    string? userId = sender is map<json> ? stringifyId(sender.id) : ();
    if userId is string {
        return string `telegram:${chatId}:${userId}`;
    }
    return string `telegram:${chatId}:default`;
}

isolated function stringifyId(json|error value) returns string? {
    if value is int {
        return value.toString();
    }
    return nonEmptyString(value);
}

isolated function shouldIgnoreTelegramUpdate(json payload) returns boolean {
    if payload !is map<json> {
        return false;
    }

    json|error message = payload.message;
    if message !is map<json> {
        // No "message" field: edited_message, channel_post, callback_query,
        // etc. Not actionable by the default text-reply flow.
        return true;
    }

    json|error sender = message.'from;
    if sender is map<json> && sender.is_bot == true {
        return true;
    }
    return false;
}

isolated class TelegramHandler {
    *PlatformHandler;

    private final string? botToken;
    private final string? secretToken;
    private final int longPollTimeout;
    private final http:Client? telegramClient;

    isolated function init(
            TelegramHttpPlatformChatInterface|TelegramPollingPlatformChatInterface interface,
            boolean verifySignatures) returns ConfigError? {
        TelegramConfig? config = telegramConfigFor(interface);

        if interface is TelegramPollingPlatformChatInterface {
            string? token = config?.bot_token;
            if token is () {
                return error ConfigError("Telegram platform chat in polling mode requires " +
                        "a non-empty platform_config.bot_token.");
            }
            int? timeout = interface.polling.timeout;
            if timeout is int {
                if timeout < 0 {
                    return error ConfigError(
                            string `Telegram getUpdates timeout must be non-negative; ` +
                            string `got ${timeout}.`);
                }
                if timeout > TELEGRAM_GET_UPDATES_MAX_TIMEOUT {
                    return error ConfigError(
                            string `Telegram getUpdates timeout must be at most ` +
                            string `${TELEGRAM_GET_UPDATES_MAX_TIMEOUT} seconds; ` +
                            string `got ${timeout}.`);
                }
            }
            self.botToken = token;
            self.secretToken = ();
            self.longPollTimeout = timeout ?: 0;

            // One http:Client per polling interface lifetime, reused across
            // every getUpdates call so Ballerina's connection pool actually
            // sees connection reuse.
            decimal readTimeout = <decimal> self.longPollTimeout + TELEGRAM_HTTP_TIMEOUT_PADDING;
            http:Client|http:ClientError telegramClient = new (TELEGRAM_API_BASE, {
                timeout: readTimeout
            });
            if telegramClient is http:ClientError {
                return error ConfigError("Telegram getUpdates client init failed");
            }
            self.telegramClient = telegramClient;
            return;
        }

        // Notification mode (request mode is rejected at schema validation).
        string? secret = config?.secret_token;
        if verifySignatures && secret is () {
            return error ConfigError("Telegram platform chat requires a non-empty " +
                    "platform_config.secret_token when signature verification is enabled.");
        }
        self.botToken = ();
        self.secretToken = verifySignatures ? secret : ();
        self.longPollTimeout = 0;
        self.telegramClient = ();
    }

    isolated function verifyRawRequest(byte[] body, map<string|string[]> headers)
            returns SignatureVerificationError|ConfigError? {
        string? secretToken = self.secretToken;
        if secretToken is () {
            return;
        }

        string? received = getSingleHeader(headers, TELEGRAM_SECRET_TOKEN_HEADER);
        if !verifyTelegramSecretToken(received, secretToken) {
            log:printWarn(string `Telegram webhook rejected: secret token mismatch ` +
                    string `(header_present=${received !is ()})`);
            return error SignatureVerificationError("Invalid Telegram secret token");
        }
    }

    isolated function verifyParsedPayload(json payload) returns SignatureVerificationError? {
    }

    isolated function handlePreDispatch(json payload) returns PreDispatchResponse? => ();

    isolated function shouldIgnore(json payload) returns boolean|error =>
            shouldIgnoreTelegramUpdate(payload);

    isolated function createIgnoredResponse() returns http:Response {
        http:Response response = new;
        response.statusCode = 200;
        return response;
    }

    isolated function getSessionId(json payload) returns string =>
            getTelegramSessionId(payload);

    isolated function createNotificationAck() returns http:Response|ConfigError {
        http:Response response = new;
        response.statusCode = 200;
        return response;
    }

    isolated function createRequestResponse(json result) returns http:Response|ConfigError {
        return error ConfigError("Platform 'telegram' does not support request mode");
    }

    isolated function pollUpdates(map<json> state) returns [json[], map<json>]|error {
        string? botToken = self.botToken;
        http:Client? telegramClient = self.telegramClient;
        if botToken is () || telegramClient is () {
            return error("Telegram polling requires a non-empty platform_config.bot_token");
        }

        map<string|string[]> queryParams = {timeout: self.longPollTimeout.toString()};
        json|error offset = state.offset;
        if offset is json && offset !is () {
            queryParams["offset"] = offset.toString();
        }

        string path = string `/bot${botToken}/getUpdates` + check buildQueryString(queryParams);
        http:Response|http:ClientError response = telegramClient->get(path);
        if response is http:ClientError {
            // Sanitize error to avoid leaking the bot token via the request
            // URL in the error chain.
            return error("Telegram getUpdates request failed");
        }

        if response.statusCode < 200 || response.statusCode >= 300 {
            return error(string `Telegram getUpdates returned HTTP ${response.statusCode}`);
        }

        return parseTelegramGetUpdatesResponse(check response.getJsonPayload(), state);
    }
}

isolated function parseTelegramGetUpdatesResponse(json body, map<json> state)
        returns [json[], map<json>]|error {
    map<json> bodyMap = check body.ensureType();

    if bodyMap.ok != true {
        json|error description = bodyMap.description;
        return error(string `Telegram getUpdates returned not-ok: ` +
                string `${description is json && description !is () ? description.toString() : "no description"}`);
    }

    json|error rawResult = bodyMap.result;
    json[] updates = rawResult is () || rawResult is error
            ? <json[]>[] : check rawResult.ensureType();

    map<json> nextState = state.clone();
    if updates.length() == 0 {
        return [updates, nextState];
    }

    // Seed from prior cursor — if every update_id fails to parse the cursor
    // stays put rather than rewinding to 1 (which would force Telegram to
    // redeliver the whole backlog).
    json|error priorOffsetJson = state.offset;
    int? maxId = priorOffsetJson is int ? priorOffsetJson - 1 : ();
    foreach json update in updates {
        if update !is map<json> {
            continue;
        }
        int|error updateId = update.update_id.ensureType();
        if updateId is int && (maxId is () || updateId > maxId) {
            maxId = updateId;
        }
    }
    if maxId is int {
        nextState["offset"] = maxId + 1;
    }
    return [updates, nextState];
}

isolated function buildQueryString(map<string|string[]> params) returns string|error {
    if params.length() == 0 {
        return "";
    }
    string[] parts = [];
    foreach var [k, v] in params.entries() {
        string encodedKey = check url:encode(k, "UTF-8");
        if v is string {
            parts.push(string `${encodedKey}=${check url:encode(v, "UTF-8")}`);
        } else {
            foreach string item in v {
                parts.push(string `${encodedKey}=${check url:encode(item, "UTF-8")}`);
            }
        }
    }
    return "?" + string:'join("&", ...parts);
}
