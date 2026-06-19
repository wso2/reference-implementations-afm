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
import ballerina/http;
import ballerina/lang.runtime;
import ballerina/log;

// Bounded in-loop retry for the polling dispatch path: transient errors
// usually recover within one or two retries, while permanent errors
// (template misalignment, persistent agent bug) should not stall the
// polling loop indefinitely.
const MAX_DISPATCH_ATTEMPTS = 3;
const DISPATCH_BACKOFF_SECONDS = 1.0d;

// Distinct error types let the dispatcher translate handler-level failures
// into appropriate HTTP responses (401 for signature, 500 for config, 400
// for malformed payload).
type SignatureVerificationError distinct error;
type ConfigError distinct error;
type BadRequestError distinct error;

// Result of a pre-dispatch hook, letting a handler short-circuit the
// dispatcher and return a synchronous response before the agent runs
// (e.g. for platform-level challenge/handshake exchanges).
type PreDispatchResponse record {|
    int statusCode;
    string|map<json> body;
    string contentType = "application/json";
|};

# Per-interface behaviour for the platformchat interface. One handler
# instance is constructed per interface via `createPlatformHandler`, and owns
# any interface-scoped state (config, cached clients, etc). The dispatcher in
# this file is platform-agnostic and delegates inbound verification, payload
# parsing, ignore/dispatch decisions, response shaping and (for polling
# platforms) update fetching to the implementation of this object.
#
# Platforms whose lifecycle is owned by an external trigger (e.g. `gchat`)
# do not participate in this abstraction.
type PlatformHandler isolated object {
    # Verifies the raw HTTP request before JSON parsing, so signature checks
    # operate on the exact byte sequence delivered by the platform. Returns
    # `()` immediately when the handler was constructed with verification
    # disabled.
    #
    # + body - The raw request body
    # + headers - All request headers (single value or list per name)
    # + return - A `SignatureVerificationError` for a rejected request, a
    #            `ConfigError` for an operational failure (e.g. JWKS fetch),
    #            or `()` if the request is accepted
    isolated function verifyRawRequest(byte[] body, map<string|string[]> headers)
            returns SignatureVerificationError|ConfigError?;

    # Verifies the parsed JSON payload after `verifyRawRequest`. Most
    # platforms can leave this as a no-op.
    #
    # + payload - The parsed JSON request body
    # + return - A `SignatureVerificationError` if the payload is rejected, or `()`
    isolated function verifyParsedPayload(json payload) returns SignatureVerificationError?;

    # Returns a response that short-circuits the dispatcher before
    # `shouldIgnore` runs (used for platform-level challenge/handshake
    # exchanges).
    #
    # + payload - The parsed JSON request body
    # + return - A pre-dispatch response, or `()` to proceed with normal dispatch
    isolated function handlePreDispatch(json payload) returns PreDispatchResponse?;

    # Returns `true` if the event should be silently acknowledged without
    # invoking the agent (e.g. bot self-messages, non-actionable event types).
    #
    # + payload - The parsed JSON request body
    # + return - `true` to suppress agent dispatch, `false` to proceed, or
    #            an `error` if the payload could not be inspected
    isolated function shouldIgnore(json payload) returns boolean|error;

    # Builds the HTTP response returned when `shouldIgnore` accepts the event.
    #
    # + return - The HTTP response to send to the platform
    isolated function createIgnoredResponse() returns http:Response;

    # Returns a per-conversation session identifier derived from the payload.
    # The dispatcher passes this to the agent so multi-turn state is scoped
    # per chat/space/user.
    #
    # + payload - The parsed JSON request body
    # + return - A stable session identifier string
    isolated function getSessionId(json payload) returns string;

    # Builds the HTTP response sent in notification mode (fire-and-forget
    # acknowledgement before the agent runs in the background).
    #
    # + return - The acknowledgement response, or a `ConfigError`
    isolated function createNotificationAck() returns http:Response|ConfigError;

    # Builds the HTTP response wrapping the agent's output in request mode.
    #
    # + result - The agent's result value
    # + return - The HTTP response containing the wrapped result, or a `ConfigError`
    isolated function createRequestResponse(json result) returns http:Response|ConfigError;

    # Fetches a batch of updates from the platform for polling mode. Only
    # invoked on handlers constructed for polling-mode interfaces.
    #
    # + state - Caller-managed polling state (e.g. cursor / offset)
    # + return - `[updates, nextState]` on success; an `error` on a polling
    #            failure (the caller backs off and retries)
    isolated function pollUpdates(map<json> state) returns [json[], map<json>]|error;
};

isolated function createPlatformHandler(PlatformChatInterface interface,
        boolean verifySignatures) returns PlatformHandler|ConfigError {
    if interface is SlackPlatformChatInterface {
        return new SlackHandler(interface, verifySignatures);
    }
    if interface is TelegramHttpPlatformChatInterface|TelegramPollingPlatformChatInterface {
        return new TelegramHandler(interface, verifySignatures);
    }
    return error ConfigError("gchat does not use the PlatformHandler abstraction");
}

isolated function getPlatformChatHttpPath(NonPollingPlatformChatInterface interface) returns string =>
    interface.exposure.http.path;

function attachPlatformChatService(http:Listener httpListener, ai:Agent agent,
        NonPollingPlatformChatInterface interface, boolean verifySignatures = true) returns error? {
    if interface is GChatPlatformChatInterface {
        return error("gchat platformchat is attached via attachGChatPlatformChat, " +
                "not attachPlatformChatService");
    }

    PlatformHandler handler = check createPlatformHandler(interface, verifySignatures);
    string path = getPlatformChatHttpPath(interface);
    PlatformChatHttpService svc = check new (agent, handler, interface);
    return httpListener.attach(svc, path);
}

isolated service class PlatformChatHttpService {
    *http:Service;

    private final ai:Agent agent;
    private final PlatformHandler handler;
    private final readonly & JSONSchema outputSchema;
    private final readonly & CompiledTemplate? compiledPrompt;
    private final boolean isRequestMode;

    isolated function init(ai:Agent agent, PlatformHandler handler,
            NonPollingPlatformChatInterface interface) returns error? {
        self.agent = agent;
        self.handler = handler;
        self.outputSchema = interface.signature.output.cloneReadOnly();
        string? promptTemplate = interface?.prompt;
        self.compiledPrompt = promptTemplate is string
            ? check compileTemplate(promptTemplate)
            : ();
        self.isRequestMode = interface.mode == REQUEST;
    }

    isolated resource function post .(http:Request req)
            returns http:Response|http:BadRequest|http:Unauthorized|http:InternalServerError {
        return dispatchPlatformChatRequest(req, self.agent, self.handler,
                self.outputSchema, self.compiledPrompt, self.isRequestMode);
    }
}

isolated function dispatchPlatformChatRequest(http:Request req, ai:Agent agent,
        PlatformHandler handler, readonly & JSONSchema outputSchema,
        readonly & CompiledTemplate? compiledPrompt, boolean isRequestMode)
        returns http:Response|http:BadRequest|http:Unauthorized|http:InternalServerError {
    byte[]|error rawBody = req.getBinaryPayload();
    if rawBody is error {
        log:printError("Failed to read request body", rawBody);
        return badRequestResponse("Invalid request body");
    }

    map<string|string[]> headers = collectHeaders(req);

    SignatureVerificationError|ConfigError? verifyResult =
            handler.verifyRawRequest(rawBody, headers);
    if verifyResult is SignatureVerificationError {
        return unauthorizedResponse(verifyResult.message());
    }
    if verifyResult is ConfigError {
        return internalServerErrorResponse(verifyResult.message());
    }

    json|error payload = parseJsonBody(rawBody);
    if payload is error {
        return badRequestResponse("Invalid JSON payload");
    }

    SignatureVerificationError? parsedVerifyResult = handler.verifyParsedPayload(payload);
    if parsedVerifyResult is SignatureVerificationError {
        return unauthorizedResponse(parsedVerifyResult.message());
    }

    PreDispatchResponse? early = handler.handlePreDispatch(payload);
    if early is PreDispatchResponse {
        return buildPreDispatchResponse(early);
    }

    boolean|error ignore = handler.shouldIgnore(payload);
    if ignore is error {
        log:printError("Failed to inspect payload for ignore-check", ignore);
        return internalServerErrorResponse("Failed to inspect payload");
    }
    if ignore {
        return handler.createIgnoredResponse();
    }

    if !isRequestMode {
        // Notification mode: ack immediately and let dispatch run the agent
        // in the background. Telegram/Slack/etc. won't redeliver, so there is
        // no point retrying.
        readonly & json roPayload = payload.cloneReadOnly();
        readonly & map<string|string[]> roHeaders = headers.cloneReadOnly();
        _ = start dispatchPlatformUpdate(handler, agent, roPayload, roHeaders,
                compiledPrompt);
        http:Response|ConfigError ack = handler.createNotificationAck();
        if ack is ConfigError {
            return internalServerErrorResponse(ack.message());
        }
        return ack;
    }

    // Request mode: synchronous flow with HTTP error propagation.
    string sessionId = handler.getSessionId(payload);
    string|error userPrompt = buildUserPrompt(compiledPrompt, payload, headers);
    if userPrompt is error {
        log:printWarn(string `Template evaluation error: ${userPrompt.message()}`);
        return badRequestResponse("Failed to evaluate prompt template");
    }

    map<json>? effectiveOutputSchema =
            (outputSchema?.properties !is () || outputSchema.'type != "string")
                ? outputSchema : ();

    json|InputError|AgentError result = runAgent(agent, userPrompt,
            outputSchema = effectiveOutputSchema, sessionId = sessionId);
    if result is InputError {
        return badRequestResponse(result.message());
    }
    if result is AgentError {
        log:printError("Agent execution error", result);
        return internalServerErrorResponse("Agent execution failed");
    }

    http:Response|ConfigError response = handler.createRequestResponse(result);
    if response is ConfigError {
        return internalServerErrorResponse(response.message());
    }
    return response;
}

// Per-update dispatch shared by notification mode and polling mode. The
// caller filters out updates that `shouldIgnore` would reject (because the
// webhook router needs to respond with `createIgnoredResponse` for those).
// Returns true if the agent ran to completion, false if a template or agent
// error was swallowed. The polling loop uses this to drive bounded retries.
isolated function dispatchPlatformUpdate(PlatformHandler handler, ai:Agent agent,
        readonly & json payload, readonly & map<string|string[]>? headers,
        readonly & CompiledTemplate? compiledPrompt) returns boolean {
    string sessionId = handler.getSessionId(payload);

    string|error userPrompt = buildUserPrompt(compiledPrompt, payload, headers);
    if userPrompt is error {
        log:printWarn(string `Skipping update: prompt template evaluation failed: ${userPrompt.message()}`);
        return false;
    }

    json|InputError|AgentError result = runAgent(agent, userPrompt, sessionId = sessionId);
    if result is error {
        log:printError("Agent execution error", result);
        return false;
    }
    log:printDebug(string `Agent response: ${result.toJsonString()}`);
    return true;
}

isolated function buildUserPrompt(readonly & CompiledTemplate? compiledPrompt,
        json payload, map<string|string[]>? headers) returns string|error {
    if compiledPrompt is CompiledTemplate {
        return evaluateTemplate(compiledPrompt, payload, headers);
    }
    return payload.toJsonString();
}

isolated function runPlatformChatPollingLoop(ai:Agent agent,
        PollingPlatformChatInterface interface) returns error? {
    PlatformHandler handler = check createPlatformHandler(interface, false);

    string? promptTemplate = interface?.prompt;
    final readonly & CompiledTemplate? compiledPrompt = promptTemplate is string
        ? check compileTemplate(promptTemplate)
        : ();

    final decimal intervalSeconds = check getPollingIntervalSeconds(interface.polling);

    map<json> state = {};

    log:printInfo(string `Starting polling loop for platform '${interface.platform}' ` +
            string `(interval=${intervalSeconds}s)`);

    while true {
        [json[], map<json>]|error pollResult = handler.pollUpdates(state);
        if pollResult is error {
            log:printError("Polling iteration failed; sleeping before retry", pollResult);
            runtime:sleep(intervalSeconds);
            continue;
        }

        [json[], map<json>] [updates, nextState] = pollResult;

        foreach json update in updates {
            boolean|error ignore = handler.shouldIgnore(update);
            if ignore is error {
                log:printWarn("Skipping update: ignore-check failed", ignore);
                continue;
            }
            if ignore {
                continue;
            }
            _ = dispatchWithRetry(handler, agent, update.cloneReadOnly(), compiledPrompt);
        }

        // Advance the cursor only after the dispatch loop has had its chance
        // at every update in the batch.
        state = nextState;

        runtime:sleep(intervalSeconds);
    }
}

isolated function getPollingIntervalSeconds(Polling polling) returns decimal|ConfigError {
    int interval = polling.interval;
    if interval <= 0 {
        return error ConfigError(string `platformchat polling.interval must be greater than 0; ` +
                string `got ${interval}.`);
    }
    return <decimal> interval;
}

isolated function dispatchWithRetry(PlatformHandler handler, ai:Agent agent,
        readonly & json payload, readonly & CompiledTemplate? compiledPrompt)
        returns boolean {
    foreach int attempt in 0 ..< MAX_DISPATCH_ATTEMPTS {
        boolean success = dispatchPlatformUpdate(handler, agent, payload, (), compiledPrompt);
        if success {
            return true;
        }

        if attempt < MAX_DISPATCH_ATTEMPTS - 1 {
            decimal backoff = DISPATCH_BACKOFF_SECONDS * <decimal>(1 << attempt);
            runtime:sleep(backoff);
        }
    }

    string summary = summarizeDroppedPayload(payload);
    log:printError(string `Dropping update after ${MAX_DISPATCH_ATTEMPTS} ` +
            string `failed dispatch attempts: update=${summary}`);
    return false;
}

isolated function summarizeDroppedPayload(json payload) returns string {
    if payload !is map<json> {
        return string `<${(typeof payload).toString()}>`;
    }
    json|error updateId = payload.update_id;
    return string `update_id=${updateId is json && updateId !is () ? updateId.toString() : "<unknown>"}`;
}

isolated function collectHeaders(http:Request req) returns map<string|string[]> {
    map<string|string[]> headers = {};
    foreach string name in req.getHeaderNames() {
        string[]|http:HeaderNotFoundError values = req.getHeaders(name);
        if values is string[] {
            if values.length() == 1 {
                headers[name] = values[0];
            } else {
                headers[name] = values;
            }
        }
    }
    return headers;
}

isolated function parseJsonBody(byte[] body) returns json|error {
    string|error bodyStr = string:fromBytes(body);
    if bodyStr is error {
        return bodyStr;
    }
    if bodyStr == "" {
        return {};
    }
    return bodyStr.fromJsonString();
}

isolated function buildPreDispatchResponse(PreDispatchResponse spec) returns http:Response {
    http:Response response = new;
    response.statusCode = spec.statusCode;
    string|map<json> body = spec.body;
    if body is string {
        response.setTextPayload(body, spec.contentType);
    } else {
        response.setJsonPayload(body);
    }
    return response;
}

isolated function badRequestResponse(string detail) returns http:BadRequest =>
    {body: {detail}};

isolated function unauthorizedResponse(string detail) returns http:Unauthorized =>
    {body: {detail}};

isolated function internalServerErrorResponse(string detail) returns http:InternalServerError =>
    {body: {detail}};

// Cross-platform constant-time string comparison; lives here because both
// Slack (HMAC signature) and Telegram (secret token) use it.
isolated function constantTimeEquals(string expected, string actual) returns boolean {
    int expectedLength = expected.length();
    int actualLength = actual.length();
    int maxLength = expectedLength > actualLength ? expectedLength : actualLength;
    // Fold the length mismatch into the accumulator instead of branching early.
    int diff = expectedLength ^ actualLength;
    foreach int index in 0 ..< maxLength {
        int expectedCodePoint = index < expectedLength ? expected.getCodePoint(index) : 0;
        int actualCodePoint = index < actualLength ? actual.getCodePoint(index) : 0;
        diff = diff | (expectedCodePoint ^ actualCodePoint);
    }
    return diff == 0;
}

isolated function nonEmptyString(json|error value) returns string? {
    if value is string && value != "" {
        return value;
    }
    return ();
}
