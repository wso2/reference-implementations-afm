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
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

import ballerina/ai;
import ballerina/http;
import ballerina/log;

const MCP_PROTOCOL_VERSION = "2025-03-26";
const MCP_SESSION_HEADER = "Mcp-Session-Id";
const MCP_MAX_TOOL_PAGES = 100;
const decimal MCP_TIMEOUT_SECONDS = 30;

type McpTool record {
    string name;
    string description = "";
    map<json> inputSchema;
};

type McpToolCall record {|
    string name;
    map<json> arguments = {};
|};

type McpSessionExpired distinct error;

isolated class McpHttpClient {
    private final http:Client httpClient;
    private final HeaderProvider auth;
    private final string label;
    private string? sessionId = ();
    private int lastRequestId = 0;

    isolated function init(string url, HeaderProvider auth, string label, decimal timeout = MCP_TIMEOUT_SECONDS)
            returns error? {
        self.auth = auth;
        self.label = label;
        http:Client|error created = new (url, timeout = timeout, followRedirects = {enabled: false});
        if created is error {
            return error(string `${label}: the transport url cannot be used by the HTTP client`);
        }
        self.httpClient = created;
    }

    isolated function connect() returns error? {
        lock {
            check self.handshake();
        }
    }

    isolated function listTools() returns json[]|error {
        lock {
            json[] tools = [];
            string? cursor = ();
            foreach int _ in 0 ..< MCP_MAX_TOOL_PAGES {
                map<json> params = {};
                if cursor is string {
                    params["cursor"] = cursor;
                }
                map<json> result = check self.request("tools/list", params);
                json page = result["tools"];
                if page !is json[] {
                    return error(string `${self.label}: tools/list failed: the response has no list of tools`);
                }
                tools.push(...page);
                json next = result["nextCursor"];
                if next !is string || next == "" {
                    return tools.clone();
                }
                cursor = next;
            }
            return error(string `${self.label}: tools/list failed: more than ${MCP_MAX_TOOL_PAGES} pages of tools`);
        }
    }

    isolated function callTool(string name, map<json> arguments) returns map<json>|error {
        lock {
            map<json> result = check self.request("tools/call", {name, arguments: arguments.clone()});
            return result.clone();
        }
    }

    private isolated function handshake() returns error? {
        error? result = self.startSession();
        if result is McpSessionExpired {
            lock {
                self.sessionId = ();
            }
            return self.startSession();
        }
        return result;
    }

    private isolated function startSession() returns error? {
        map<json> result = check self.exchange("initialize", {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {name: "AFM Ballerina interpreter", version: "1.0.0"}
        });
        json version = result["protocolVersion"];
        if version != MCP_PROTOCOL_VERSION {
            return error(string `${self.label}: initialize failed: the server does not support MCP protocol version ` +
                string `${MCP_PROTOCOL_VERSION} (it answered ${version is string && re `[0-9]{4}-[0-9]{2}-[0-9]{2}`.isFullMatch(version) ? version : "something else"})`);
        }
        _ = check self.post({jsonrpc: "2.0", method: "notifications/initialized"}, "notifications/initialized");
    }

    private isolated function request(string method, map<json> params) returns map<json>|error {
        map<json>|error result = self.exchange(method, params);
        if result is McpSessionExpired {
            lock {
                self.sessionId = ();
            }
            check self.handshake();
            return self.exchange(method, params);
        }
        return result;
    }

    private isolated function exchange(string method, map<json> params) returns map<json>|error {
        int id;
        lock {
            self.lastRequestId += 1;
            id = self.lastRequestId;
        }
        http:Response response = check self.post({jsonrpc: "2.0", id, method, params}, method);
        if method == "initialize" {
            check self.keepSession(response);
        }

        string contentType = response.getContentType().toLowerAscii();
        if contentType.includes("text/event-stream") {
            return self.readStream(response, id, method);
        }
        if !contentType.includes("application/json") {
            return error(string `${self.label}: ${method} failed: unsupported response content type`);
        }
        json|error body = response.getJsonPayload();
        if body is error {
            return error(string `${self.label}: ${method} failed: the response is not valid JSON`);
        }
        map<json>|error? found = self.responseIn(body, id, method);
        return found is () ? error(string `${self.label}: ${method} failed: the response does not answer the request`) : found;
    }

    private isolated function post(json message, string operation) returns http:Response|error {
        map<string> credentials = check self.auth.getHeaders();
        http:Response response = check self.send(message, credentials, operation);
        if response.statusCode == http:STATUS_UNAUTHORIZED && self.auth.renew(credentials) {
            response = check self.send(message, check self.auth.getHeaders(), operation);
        }

        int status = response.statusCode;
        if status >= 200 && status < 300 {
            return response;
        }
        if status == http:STATUS_NOT_FOUND && self.hasSession() {
            return error McpSessionExpired(string `${self.label}: ${operation} failed: the session has expired`);
        }
        string reason = status >= 300 && status < 400 ? "; redirects are not followed" : "";
        return error(string `${self.label}: ${operation} failed (HTTP ${status}${reason})`);
    }

    private isolated function send(json message, map<string> credentials, string operation)
            returns http:Response|error {
        map<string> headers = {...credentials};
        headers["Accept"] = "application/json, text/event-stream";
        lock {
            string? session = self.sessionId;
            if session is string {
                headers[MCP_SESSION_HEADER] = session;
            }
        }
        http:Response|error response = self.httpClient->post("", message, headers = headers);
        return response is error ? error(string `${self.label}: ${operation} failed: the request could not be sent`) : response;
    }

    private isolated function hasSession() returns boolean {
        lock {
            return self.sessionId is string;
        }
    }

    private isolated function keepSession(http:Response response) returns error? {
        string|error session = response.getHeader(MCP_SESSION_HEADER);
        if session is string {
            if !re `[!-~]+`.isFullMatch(session) {
                return error(string `${self.label}: initialize failed: the session ID is not visible ASCII`);
            }
            lock {
                self.sessionId = session;
            }
        }
    }

    private isolated function readStream(http:Response response, int id, string method) returns map<json>|error {
        stream<http:SseEvent, error?>|error events = response.getSseEventStream();
        if events is error {
            return error(string `${self.label}: ${method} failed: the event stream cannot be read`);
        }
        map<json>|error result = self.findResult(events, id, method);
        error? closed = events.close();
        if closed is error {
            log:printDebug("Failed to close the event stream of an MCP response");
        }
        return result;
    }

    private isolated function findResult(stream<http:SseEvent, error?> events, int id, string method)
            returns map<json>|error {
        while true {
            record {|http:SseEvent value;|}|error? event = events.next();
            if event is error {
                return error(string `${self.label}: ${method} failed: the event stream failed`);
            }
            if event is () {
                return error(string `${self.label}: ${method} failed: the event stream ended before the response`);
            }
            string? data = event.value?.data;
            if data is () || data.trim() == "" {
                continue;
            }
            json|error message = data.fromJsonString();
            if message is error {
                return error(string `${self.label}: ${method} failed: the event stream sent invalid JSON`);
            }
            map<json>|error? found = self.responseIn(message, id, method);
            if found is () {
                continue;
            }
            return found;
        }
    }

    private isolated function responseIn(json message, int id, string method) returns map<json>|error? {
        json[] batch = message is json[] ? message : [message];
        foreach json item in batch {
            if item is map<json> && item.hasKey("method") {
                check self.answerServer(item);
            } else {
                return self.resultOf(item, id, method);
            }
        }
        return ();
    }

    private isolated function answerServer(map<json> message) returns error? {
        json id = message["id"];
        if id is () {
            return;
        }
        map<json> answer = {jsonrpc: "2.0", id};
        if message["method"] == "ping" {
            answer["result"] = {};
        } else {
            answer["error"] = {code: -32601, message: "Method not found"};
        }
        _ = check self.post(answer, "the answer to a request of the server");
    }

    private isolated function resultOf(json message, int id, string method) returns map<json>|error {
        if message !is map<json> || message["jsonrpc"] != "2.0" || message["id"] != id {
            return error(string `${self.label}: ${method} failed: the response does not answer the request`);
        }
        json rpcError = message["error"];
        if rpcError is map<json> {
            json code = rpcError["code"];
            return error(string `${self.label}: ${method} failed: JSON-RPC error ${code is int ? describeCode(code) : "without a code"}`);
        }
        json result = message["result"];
        if result !is map<json> {
            return error(string `${self.label}: ${method} failed: the response has no result`);
        }
        return result;
    }
}

isolated function describeCode(int code) returns string {
    string name = "";
    match code {
        -32700 => {
            name = "Parse error";
        }
        -32600 => {
            name = "Invalid Request";
        }
        -32601 => {
            name = "Method not found";
        }
        -32602 => {
            name = "Invalid params";
        }
        -32603 => {
            name = "Internal error";
        }
        _ => {
            name = code >= -32099 && code <= -32000 ? "Server error" : "";
        }
    }
    return name == "" ? code.toString() : string `${code} (${name})`;
}

isolated class McpHttpToolKit {
    *ai:McpBaseToolKit;

    private final McpHttpClient mcpClient;
    private final readonly & string[] names;
    private final ai:ToolConfig[] & readonly tools;

    isolated function init(string url, HeaderProvider auth, ToolFilter? filter, string label) returns error? {
        McpHttpClient connection = check new (url, auth, label);
        check connection.connect();
        McpTool[] exposed = filterTools(check toMcpTools(check connection.listTools(), label), filter);

        self.mcpClient = connection;
        self.names = from McpTool tool in exposed
            select tool.name;
        isolated function caller = self.callTool;
        self.tools = from McpTool tool in exposed
            select {name: tool.name, description: tool.description, parameters: tool.inputSchema.cloneReadOnly(), caller};
    }

    isolated function callTool(McpToolCall params) returns map<json>|error {
        if self.names.indexOf(params.name) is () {
            return error(string `Tool '${params.name}' is not available`);
        }
        return self.mcpClient.callTool(params.name, params.arguments);
    }

    public isolated function getTools() returns ai:ToolConfig[] => self.tools;
}

isolated function toMcpTools(json[] listed, string label) returns McpTool[]|error {
    McpTool[] tools = [];
    foreach json item in listed {
        McpTool|error tool = item.cloneWithType();
        if tool is error || tool.name == "" {
            return error(string `${label}: tools/list failed: a tool has an invalid definition`);
        }
        tools.push(tool);
    }
    return tools;
}

isolated function filterTools(McpTool[] tools, ToolFilter? filter) returns McpTool[] {
    string[]? allow = filter?.allow;
    string[]? deny = filter?.deny;
    return from McpTool tool in tools
        where (allow is () || allow.indexOf(tool.name) is int) && (deny is () || deny.indexOf(tool.name) is ())
        select tool;
}
