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
import ballerina/log;
import ballerinax/googleapis.chat;

type GChatProjectNumberOnly record {|
    string|int project_number;
|};

type GChatEndpointUrlOnly record {|
    string endpoint_url;
|};

type GChatConfig GChatProjectNumberOnly|GChatEndpointUrlOnly;

type GChatHttpExposure record {|
    DEFAULT_GCHAT_PATH path = DEFAULT_GCHAT_PATH;
|};

type GChatExposure record {|
    GChatHttpExposure http;
|};

type GChatPlatformChatInterface record {|
    *NonPollingPlatformChatInterfaceBase;
    PLATFORM_GCHAT platform = PLATFORM_GCHAT;
    GChatConfig platform_config?;
    GChatExposure exposure = {http: {}};
|};

isolated function getGChatServiceConfig(GChatConfig? config) returns chat:ServiceConfiguration? {
    if config is GChatEndpointUrlOnly {
        return {endpointUrl: config.endpoint_url};
    }
    if config is GChatProjectNumberOnly {
        return {projectNumber: config.project_number.toString()};
    }
    return ();
}

isolated function getGChatSessionId(json payload) returns string {
    if payload !is map<json> {
        return "default";
    }

    json|error space = payload.space;
    string? spaceName = space is map<json> ? nonEmptyString(space.name) : ();
    if spaceName is () {
        return "gchat:unknown-space:default";
    }

    json|error user = payload.user;
    if user is map<json> {
        string? userName = nonEmptyString(user.name);
        if userName is string {
            return string `gchat:${spaceName}:${userName}`;
        }
    }
    return string `gchat:${spaceName}:default`;
}

isolated function shouldIgnoreGChatMessageEvent(chat:MessageEvent event) returns boolean {
    chat:User? sender = event.message?.sender;
    return sender is chat:User && sender?.'type == chat:BOT;
}

isolated function validateGChatPlatformChat(GChatPlatformChatInterface interface,
        boolean verifySignatures) returns error? {
    if !verifySignatures {
        return;
    }
    if getGChatServiceConfig(interface?.platform_config) is () {
        return error ConfigError("GChat platform chat requires " +
                "platform_config.project_number or " +
                "platform_config.endpoint_url when " +
                "signature verification is enabled.");
    }
}

function attachGChatPlatformChat(http:Listener httpListener, ai:Agent agent,
        GChatPlatformChatInterface interface, boolean verifySignatures = true)
        returns chat:Listener|error {
    check validateGChatPlatformChat(interface, verifySignatures);

    chat:ServiceConfiguration? svcConfig = getGChatServiceConfig(interface?.platform_config);

    if svcConfig is () {
        return error ConfigError("GChat platform chat requires " +
                "platform_config.project_number or platform_config.endpoint_url; " +
                "the ballerinax/googleapis.chat trigger has no opt-out for " +
                "bearer token verification.");
    }

    string? promptTemplate = interface?.prompt;
    final readonly & CompiledTemplate? compiledPrompt = promptTemplate is string
        ? check compileTemplate(promptTemplate)
        : ();
    final boolean isRequestMode = interface.mode == REQUEST;

    // Placeholder bearer token: `chat:ListenerConfig.auth` is mandatory and
    // drives the outbound Chat API client, which we never invoke. The token
    // is never sent anywhere. TODO: drop once ballerina-library#8817 lands.
    chat:Listener chatListener = check new (httpListener, {
        auth: {token: "unused"}
    });

    chat:ChatService svc = svcConfig is chat:HttpEndpointUrlConfig
        ? getGChatServiceWithHttpEndpointUrlConfig(svcConfig, isRequestMode, agent, compiledPrompt)
        : getGChatServiceWithProjectNumberConfig(svcConfig, isRequestMode, agent, compiledPrompt);
    check chatListener.attach(svc, ());
    return chatListener;
}

isolated function getGChatServiceWithHttpEndpointUrlConfig(chat:HttpEndpointUrlConfig annot,
        boolean isRequestMode, ai:Agent agent,
        readonly & CompiledTemplate? compiledPrompt) returns chat:ChatService {
    final ai:Agent capturedAgent = agent;
    final readonly & CompiledTemplate? capturedPrompt = compiledPrompt;
    final boolean capturedIsRequestMode = isRequestMode;

    return @chat:ServiceConfig {
        ...annot
    }
    service object {
        isolated remote function onMessage(chat:MessageEvent & readonly event,
                chat:MessageCaller caller) returns error? {
            if shouldIgnoreGChatMessageEvent(event) {
                return caller->respond({});
            }
            if capturedIsRequestMode {
                return handleGChatRequestMode(capturedAgent, event, caller, capturedPrompt);
            }
            // Notification mode: ack and dispatch in the background.
            // Google Chat does not redeliver, so retrying is pointless.
            error? respondResult = caller->respond({});
            _ = start runGChatAgentDispatch(capturedAgent, event, capturedPrompt);
            return respondResult;
        }

        isolated remote function onAddedToSpace(chat:ChatEvent event,
                chat:MessageCaller caller) returns error? {
            return caller->respond({
                text: "Hi! I'm ready to help."
            });
        }
    };
}

isolated function getGChatServiceWithProjectNumberConfig(chat:ProjectNumberConfig annot,
        boolean isRequestMode, ai:Agent agent,
        readonly & CompiledTemplate? compiledPrompt) returns chat:ChatService {
    final ai:Agent capturedAgent = agent;
    final readonly & CompiledTemplate? capturedPrompt = compiledPrompt;
    final boolean capturedIsRequestMode = isRequestMode;

    return @chat:ServiceConfig {
        ...annot
    }
    service object {
        isolated remote function onMessage(chat:MessageEvent & readonly event,
                chat:MessageCaller caller) returns error? {
            if shouldIgnoreGChatMessageEvent(event) {
                return caller->respond({});
            }
            if capturedIsRequestMode {
                return handleGChatRequestMode(capturedAgent, event, caller, capturedPrompt);
            }
            // Notification mode: ack and dispatch in the background.
            // Google Chat does not redeliver, so retrying is pointless.
            error? respondResult = caller->respond({});
            _ = start runGChatAgentDispatch(capturedAgent, event, capturedPrompt);
            return respondResult;
        }

        isolated remote function onAddedToSpace(chat:ChatEvent event,
                chat:MessageCaller caller) returns error? {
            return caller->respond({
                text: "Hi! I'm ready to help."
            });
        }
    };
}

isolated function handleGChatRequestMode(ai:Agent agent, chat:MessageEvent event,
        chat:MessageCaller caller,
        readonly & CompiledTemplate? compiledPrompt) returns error? {
    json payload = event.toJson();
    string sessionId = getGChatSessionId(payload);
    string|error userPrompt = buildUserPrompt(compiledPrompt, payload, ());
    if userPrompt is error {
        log:printWarn(string `Template evaluation error: ${userPrompt.message()}`);
        return caller->respond({text: "Failed to evaluate prompt template"});
    }

    json|InputError|AgentError result = runAgent(agent, userPrompt, sessionId = sessionId);
    if result is InputError {
        return caller->respond({text: result.message()});
    }
    if result is AgentError {
        log:printError("Agent execution error", result);
        return caller->respond({text: "Agent execution failed"});
    }
    if result is map<json> {
        chat:Message|error msg = result.cloneWithType();
        if msg is chat:Message {
            return caller->respond(msg);
        }
    }
    return caller->respond({text: result.toJsonString()});
}

isolated function runGChatAgentDispatch(ai:Agent agent, chat:MessageEvent event,
        readonly & CompiledTemplate? compiledPrompt) {
    json payload = event.toJson();
    string sessionId = getGChatSessionId(payload);
    string|error userPrompt = buildUserPrompt(compiledPrompt, payload, ());
    if userPrompt is error {
        log:printWarn(string `Skipping update: prompt template evaluation failed: ${userPrompt.message()}`);
        return;
    }
    json|InputError|AgentError result = runAgent(agent, userPrompt, sessionId = sessionId);
    if result is error {
        log:printError("Agent execution error", result);
        return;
    }
    log:printDebug(string `Agent response: ${result.toJsonString()}`);
}
