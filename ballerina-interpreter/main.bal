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
import ballerina/http;
import ballerina/io;
import ballerina/log;
import ballerina/lang.runtime;
import ballerina/websub;

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
        fileToUse = <string> afmFilePath;
    } else {
        fileToUse = filePath;
    }


    string content = check io:fileReadString(fileToUse);

    AFMRecord afm = check parseAfm(content);
    check runAgentFromAFM(afm, port);    
}

function runAgentFromAFM(AFMRecord afm, int port) returns error? {
    AgentMetadata metadata = afm.metadata;

    Interface[] agentInterfaces = metadata.interfaces ?: [<ConsoleChatInterface>{}];

    var [consoleChatInterface, webChatInterface, webhookInterface] = 
                        check validateAndExtractInterfaces(agentInterfaces);

    ai:Agent agent = check createAgent(afm);

    // Start all service-based interfaces first (non-blocking)
    http:Listener? httpListener = ();
    websub:Listener? websubListener = ();

    if webChatInterface is WebChatInterface {
        HTTPExposure httpExposure = webChatInterface.exposure.http ?: {path: "/chat"};

        http:Listener ln = check new (port);
        httpListener = ln;

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

    if webhookInterface is WebhookInterface {
        HTTPExposure httpExposure = webhookInterface.exposure.http ?: {path: "/webhook"};

        websub:Listener ln = check new websub:Listener(
            httpListener is () ? port : httpListener);
        websubListener = ln;
        check attachWebhookService(ln, agent, webhookInterface, httpExposure);
        log:printInfo(string `Attached webhook interface at path: ${httpExposure.path}`);
    }

    if websubListener is websub:Listener {
        check websubListener.start();
        runtime:registerListener(websubListener);
        log:printInfo(string `WebSub server started on port ${port}`);
    } else if httpListener is http:Listener {
        check httpListener.start();
        runtime:registerListener(httpListener);
        log:printInfo(string `HTTP server started on port ${port}`);
    }

    // Run consolechat last (it's blocking/interactive)
    if consoleChatInterface is ConsoleChatInterface {
        log:printInfo("Starting interactive consolechat interface");
        return runInteractiveChat(agent);
    }
}

function validateAndExtractInterfaces(Interface[] interfaces) 
        returns [ConsoleChatInterface?, WebChatInterface?, WebhookInterface?]|error {
    int consoleChatCount = 0;
    int webChatCount = 0;
    int webhookCount = 0;

    ConsoleChatInterface? consoleChatInterface = ();
    WebChatInterface? webChatInterface = ();
    WebhookInterface? webhookInterface = ();

    foreach Interface interface in interfaces {
        if interface is ConsoleChatInterface {
            consoleChatCount += 1;
            consoleChatInterface = interface;
        } else if interface is WebChatInterface {
            webChatCount += 1;
            webChatInterface = interface;
        } else {
            webhookCount += 1;
            webhookInterface = interface;
        }
    }

    if consoleChatCount > 1 || webChatCount > 1 || webhookCount > 1 {
        return error("Multiple interfaces of the same type are not supported");
    }

    return [consoleChatInterface, webChatInterface, webhookInterface];
}
