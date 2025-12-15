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

import ballerina/http;
import ballerina/io;

function attachWebChatUIService(http:Listener httpListener, string chatPath, AgentMetadata metadata) returns error? {
    string absoluteChatPath = chatPath.startsWith("/") ? chatPath : "/" + chatPath;
    http:Service webUIService = check new WebUIService(absoluteChatPath, metadata);
    return httpListener.attach(webUIService, "/chat/ui");
}

service class WebUIService {
    *http:Service;

    private final string htmlContent;

    function init(string chatPath, AgentMetadata metadata) returns error? {
        string template = check io:fileReadString("resources/chat-ui.html");

        string agentName = metadata.name ?: "AFM Agent Chat";
        string agentDescription = metadata.description ?: "AI Assistant";
        string escapedPath = escapeForJavaScript(chatPath);

        string result = template;
        result = re `\{\{AGENT_NAME\}\}`.replaceAll(result, escapeHtml(agentName));
        result = re `\{\{AGENT_DESCRIPTION\}\}`.replaceAll(result, escapeHtml(agentDescription));
        result = re `\{\{CHAT_PATH\}\}`.replaceAll(result, escapedPath);

        self.htmlContent = result;
    }

    resource function get .() returns http:Response {
        http:Response response = new;
        response.setHeader("Content-Type", "text/html; charset=utf-8");

        // unsafe-inline required for inline scripts/styles in our single-file HTML
        response.setHeader("Content-Security-Policy",
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'");

        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

        response.setPayload(self.htmlContent);
        return response;
    }
}

function escapeHtml(string input) returns string {
    string escaped = input;
    escaped = re `&`.replaceAll(escaped, "&amp;");
    escaped = re `<`.replaceAll(escaped, "&lt;");
    escaped = re `>`.replaceAll(escaped, "&gt;");
    escaped = re `"`.replaceAll(escaped, "&quot;");
    escaped = re `'`.replaceAll(escaped, "&#x27;");
    return escaped;
}

function escapeForJavaScript(string input) returns string {
    string escaped = input;
    escaped = re `\\`.replaceAll(escaped, "\\\\");
    escaped = re `'`.replaceAll(escaped, "\\'");
    escaped = re `"`.replaceAll(escaped, "\\\"");
    escaped = re `\n`.replaceAll(escaped, "\\n");
    escaped = re `\r`.replaceAll(escaped, "\\r");
    escaped = re `<`.replaceAll(escaped, "\\x3c");
    escaped = re `>`.replaceAll(escaped, "\\x3e");
    return escaped;
}
