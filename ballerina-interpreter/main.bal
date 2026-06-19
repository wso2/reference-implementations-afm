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

import ballerina/ai;
import ballerina/file;
import ballerina/http;
import ballerina/io;
import ballerina/log;
import ballerina/lang.runtime;
import ballerina/websub;
import ballerinax/googleapis.chat;

configurable int port = 8085;
configurable string? afmFilePath = ();

const FRONTMATTER_DELIMITER = "---";

type InputError distinct error;
type AgentError distinct error;

public function main(string? filePath = ()) returns error? {
    string fileToUse;
    if filePath is () {
        if afmFilePath is () {
            return error("AFM file path must be provided either as a command-line " +
                         "argument or through configuration");
        }
        fileToUse = check afmFilePath.ensureType();
    } else {
        fileToUse = filePath;
    }

    string content = check io:fileReadString(fileToUse);
    string afmFileDir = check file:parentPath(check file:getAbsolutePath(fileToUse));

    AFMRecord afm = check parseAfm(content);
    check runAgentFromAFM(afm, port, afmFileDir);
}

function runAgentFromAFM(AFMRecord afm, int port, string afmFileDir) returns error? {
    AgentMetadata? metadata = afm?.metadata;

    Interface[] agentInterfaces = metadata?.interfaces ?: [<ConsoleChatInterface>{}];

    var [consoleChatInterface, webChatInterface, webhookInterface, platformChatInterfaces] =
                        check validateAndExtractInterfaces(agentInterfaces);

    NonPollingPlatformChatInterface[] httpPlatformChats = [];
    PollingPlatformChatInterface[] pollingPlatformChats = [];
    foreach PlatformChatInterface platformChat in platformChatInterfaces {
        if platformChat is PollingPlatformChatInterface {
            pollingPlatformChats.push(platformChat);
        } else {
            httpPlatformChats.push(platformChat);
        }
    }

    check validateUniqueHttpPaths(webChatInterface, webhookInterface, httpPlatformChats);

    ai:Agent agent = check createAgent(afm, afmFileDir);

    // Start all service-based interfaces first (non-blocking).
    http:Listener? httpListener = ();
    websub:Listener? websubListener = ();
    chat:Listener? gchatListener = ();

    boolean needsHttpListener = webChatInterface is WebChatInterface ||
            httpPlatformChats.length() > 0;

    if needsHttpListener {
        httpListener = check new (port);
    }

    if webChatInterface is WebChatInterface {
        HTTPExposure httpExposure = webChatInterface.exposure.http;

        http:Listener ln = check httpListener.ensureType();

        Signature signature = webChatInterface.signature;
        boolean isStringInputOutput = signature.input.'type == "string" &&
                                        signature.output.'type == "string";
        check attachChatService(ln, agent, webChatInterface, httpExposure, isStringInputOutput);
        log:printInfo(string `Attached web chat interface at path: ${httpExposure.path}`);

        if isStringInputOutput {
            check attachWebChatUIService(ln, httpExposure.path, metadata);
            log:printInfo("Attached web chat UI at path: /chat/ui");
        }
    }

    if httpPlatformChats.length() > 0 {
        http:Listener ln = check httpListener.ensureType();
        foreach NonPollingPlatformChatInterface platformChat in httpPlatformChats {
            if platformChat is GChatPlatformChatInterface {
                if gchatListener is chat:Listener {
                    return error("Only one gchat platformchat interface is supported");
                }
                gchatListener = check attachGChatPlatformChat(ln, agent, platformChat);
            } else {
                check attachPlatformChatService(ln, agent, platformChat);
            }
            log:printInfo(string `Attached platformchat interface (${platformChat.platform}, ` +
                    string `${platformChat.mode}) at path: ${getPlatformChatHttpPath(platformChat)}`);
        }
    }

    if webhookInterface is WebhookInterface {
        HTTPExposure httpExposure = webhookInterface.exposure.http;

        websub:Listener ln = check new websub:Listener(
            httpListener is () ? port : httpListener);
        websubListener = ln;
        check attachWebhookService(ln, agent, webhookInterface, httpExposure);
        log:printInfo(string `Attached webhook interface at path: ${httpExposure.path}`);
    }

    // chat:Listener and websub:Listener both start the wrapped http:Listener
    // internally; only call http:Listener.start() ourselves when neither is
    // present.
    boolean httpStarted = false;
    if gchatListener is chat:Listener {
        check gchatListener.start();
        runtime:registerListener(gchatListener);
        httpStarted = true;
        log:printInfo(string `Google Chat listener started on port ${port}`);
    }
    if websubListener is websub:Listener {
        check websubListener.start();
        runtime:registerListener(websubListener);
        httpStarted = true;
        log:printInfo(string `WebSub server started on port ${port}`);
    }
    if !httpStarted && httpListener is http:Listener {
        check httpListener.start();
        runtime:registerListener(httpListener);
        log:printInfo(string `HTTP server started on port ${port}`);
    }

    future<error?>[] pollingFutures = [];
    foreach PollingPlatformChatInterface platformChat in pollingPlatformChats {
        future<error?> pollingFuture = start runPlatformChatPollingLoop(agent, platformChat);
        pollingFutures.push(pollingFuture);
        log:printInfo(string `Started platformchat polling loop for: ${platformChat.platform}`);
    }

    // Run consolechat last (it's blocking/interactive).
    if consoleChatInterface is ConsoleChatInterface {
        log:printInfo("Starting interactive consolechat interface");
        return runInteractiveChat(agent);
    }

    // If no HTTP/websub listener is keeping the process alive but we have
    // polling-mode platformchats, block on the futures so the workers keep
    // running. They never complete naturally; this just keeps the process
    // alive until interrupted.
    if websubListener is () && httpListener is () && pollingFutures.length() > 0 {
        foreach future<error?> pollingFuture in pollingFutures {
            error? waitResult = wait pollingFuture;
            if waitResult is error {
                log:printError("Polling loop exited with error", waitResult);
            }
        }
    }
}

function validateAndExtractInterfaces(Interface[] interfaces)
        returns [ConsoleChatInterface?, WebChatInterface?, WebhookInterface?,
                 PlatformChatInterface[]]|error {
    int consoleChatCount = 0;
    int webChatCount = 0;
    int webhookCount = 0;

    ConsoleChatInterface? consoleChatInterface = ();
    WebChatInterface? webChatInterface = ();
    WebhookInterface? webhookInterface = ();
    PlatformChatInterface[] platformChatInterfaces = [];

    foreach Interface interface in interfaces {
        if interface is ConsoleChatInterface {
            consoleChatCount += 1;
            consoleChatInterface = interface;
        } else if interface is WebChatInterface {
            webChatCount += 1;
            webChatInterface = interface;
        } else if interface is WebhookInterface {
            webhookCount += 1;
            webhookInterface = interface;
        } else {
            if interface is PollingPlatformChatInterface {
                _ = check getPollingIntervalSeconds(interface.polling);
            }
            platformChatInterfaces.push(interface);
        }
    }

    if consoleChatCount > 1 || webChatCount > 1 || webhookCount > 1 {
        return error("Multiple consolechat, webchat, or webhook interfaces are not supported");
    }

    return [consoleChatInterface, webChatInterface, webhookInterface, platformChatInterfaces];
}

function validateUniqueHttpPaths(WebChatInterface? webChatInterface,
        WebhookInterface? webhookInterface,
        NonPollingPlatformChatInterface[] httpPlatformChats) returns error? {
    map<string> seen = {};

    if webChatInterface is WebChatInterface {
        HTTPExposure exposure = webChatInterface.exposure.http;
        check addPath(seen, "webchat", exposure.path);

        Signature signature = webChatInterface.signature;
        if signature.input.'type == "string" && signature.output.'type == "string" {
            check addPath(seen, "webchat UI", "/chat/ui");
        }
    }
    if webhookInterface is WebhookInterface {
        HTTPExposure exposure = webhookInterface.exposure.http;
        check addPath(seen, "webhook", exposure.path);
    }
    foreach NonPollingPlatformChatInterface platformChat in httpPlatformChats {
        string label = string `platformchat (${platformChat.platform}, ${platformChat.mode})`;
        check addPath(seen, label, getPlatformChatHttpPath(platformChat));
    }
}

function addPath(map<string> seen, string label, string path) returns error? {
    string? existing = seen[path];
    if existing is string {
        return error(string `HTTP path '${path}' is used by both ${existing} and ${label}`);
    }
    seen[path] = label;
}
