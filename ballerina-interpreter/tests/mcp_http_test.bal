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
import ballerina/lang.runtime;
import ballerina/test;
import ballerina/time;

const MCP_HTTP_URL = "http://localhost:9296/mcp";
const MCP_HTTP_LABEL = "tools.mcp[0]";
const API_KEY = "S3CR3T-API-KEY";

type McpCall record {|
    string rpc;
    map<string> headers;
    map<json> message;
|};

McpCall[] mcpCalls = [];
map<json>[] executedTools = [];
function (http:Request) returns boolean mcpAuthorize = acceptAnyone;
boolean mcpEventStream = false;
boolean mcpStateful = false;
boolean mcpServerRequests = false;
string mcpFault = "";
json[][] mcpPages = [];
string mcpProtocolVersion = "2025-03-26";
map<int> mcpStatus = {};
string mcpSessionId = "";
int mcpSessionCount = 0;
int mcpRedirectHits = 0;

listener http:Listener mcpHttpListener = new (9296);

service /mcp on mcpHttpListener {
    resource function post .(http:Request request) returns http:Response|error {
        map<json> message = check (check request.getJsonPayload()).ensureType();
        json method = message["method"];
        string rpc = method is string ? method : "answer";
        map<string> headers = {};
        foreach string name in request.getHeaderNames() {
            headers[name.toLowerAscii()] = check request.getHeader(name);
        }
        mcpCalls.push({rpc, headers, message});

        http:Response response = new;
        if !mcpAuthorize(request) {
            response.statusCode = 401;
            return response;
        }
        if mcpStateful && rpc != "initialize" && headers["mcp-session-id"] != mcpSessionId {
            response.statusCode = 404;
            return response;
        }
        int? status = mcpStatus[rpc];
        if status is int {
            response.statusCode = status;
            response.setHeader("Location", "http://localhost:9296/elsewhere");
            return response;
        }

        match rpc {
            "initialize" => {
                return initializeResponse(message);
            }
            "tools/list" => {
                return toolsListResponse(message);
            }
            "tools/call" => {
                return toolsCallResponse(message);
            }
        }
        response.statusCode = 202;
        return response;
    }

    resource function post elsewhere() returns http:Ok {
        mcpRedirectHits += 1;
        return {};
    }
}

class StalledEvents {
    private boolean keptAlive = false;

    public isolated function next() returns record {|http:SseEvent value;|}|error? {
        lock {
            if !self.keptAlive {
                self.keptAlive = true;
                return {value: {comment: "keepalive"}};
            }
        }
        runtime:sleep(10);
        return;
    }
}

service /stall on mcpHttpListener {
    resource function post .() returns stream<http:SseEvent, error?> => new (new StalledEvents());
}

function acceptAnyone(http:Request request) returns boolean => true;

function hasHeader(string name, string value) returns function (http:Request) returns boolean =>
    request => headerOf(request, name) == value;

function headerOf(http:Request request, string name) returns string {
    string|error value = request.getHeader(name);
    return value is string ? value : "";
}

function echoTool() returns json =>
    {name: "echo", description: "Echoes the text", inputSchema: {"type": "object", properties: {text: {"type": "string"}},
        required: ["text"]}};

function plainTool(string name) returns json => {name, inputSchema: {"type": "object"}};

final readonly & string[] DEFAULT_TOOLS = ["echo", "hidden", "boom", "fail"];

function resetMcpHttp() {
    mcpCalls = [];
    executedTools = [];
    mcpAuthorize = acceptAnyone;
    mcpEventStream = false;
    mcpStateful = false;
    mcpServerRequests = false;
    mcpFault = "";
    mcpPages = [[echoTool(), plainTool("hidden"), plainTool("boom"), plainTool("fail")]];
    mcpProtocolVersion = "2025-03-26";
    mcpStatus = {};
    mcpSessionId = "";
    mcpSessionCount = 0;
    mcpRedirectHits = 0;
}

function respond(map<json> members, json id) returns http:Response {
    map<json> body = {jsonrpc: "2.0", id};
    foreach [string, json] [name, value] in members.entries() {
        body[name] = value;
    }
    if mcpEventStream {
        return eventStream(body);
    }
    http:Response response = new;
    response.setJsonPayload(body);
    return response;
}

function eventStream(json... messages) returns http:Response {
    string body = ": keepalive\n\n";
    foreach json message in messages {
        body += "event: message\ndata: " + message.toJsonString() + "\n\n";
    }
    http:Response response = new;
    response.setTextPayload(body, "text/event-stream");
    return response;
}

function initializeResponse(map<json> message) returns http:Response {
    http:Response response = respond({result: {protocolVersion: mcpProtocolVersion, capabilities: {tools: {}},
        serverInfo: {name: "mock", version: "1.0.0"}}}, message["id"]);
    if mcpStateful {
        mcpSessionCount += 1;
        mcpSessionId = mcpFault == "bad-session" ? "bad id" : string `session-${mcpSessionCount}`;
        response.setHeader("Mcp-Session-Id", mcpSessionId);
    }
    return response;
}

function toolsListResponse(map<json> message) returns http:Response {
    json|error cursor = message["params"] is map<json> ? (<map<json>>message["params"])["cursor"] : ();
    int page = cursor is string ? checkpanic int:fromString(cursor) : 0;
    boolean endless = mcpFault == "endless-cursor";
    map<json> result = {tools: mcpPages[endless ? 0 : page]};
    if page + 1 < mcpPages.length() || endless {
        result["nextCursor"] = (page + 1).toString();
    }
    return respond({result}, message["id"]);
}

function toolsCallResponse(map<json> message) returns http:Response {
    map<json> params = <map<json>>message["params"];
    string name = <string>params["name"];
    executedTools.push(params);
    json id = message["id"];

    match mcpFault {
        "wrong-id" => {
            return respond({result: {content: []}}, 999);
        }
        "bad-json" => {
            http:Response response = new;
            response.setTextPayload("not json", "application/json");
            return response;
        }
        "text" => {
            http:Response response = new;
            response.setTextPayload("hello", "text/plain");
            return response;
        }
        "no-result" => {
            return respond({}, id);
        }
        "stream-ends" => {
            return eventStream({jsonrpc: "2.0", method: "notifications/message", params: {}});
        }
        "stream-invalid" => {
            http:Response response = new;
            response.setTextPayload("data: not json\n\n", "text/event-stream");
            return response;
        }
    }

    map<json> result;
    match name {
        "boom" => {
            return respond({'error: {code: -32602, message: "Unknown tool: boom"}}, id);
        }
        "fail" => {
            result = {content: [{"type": "text", text: "it failed"}], isError: true};
        }
        _ => {
            result = {content: [{"type": "text", text: "echo"}]};
        }
    }
    if mcpServerRequests {
        return eventStream(
            {jsonrpc: "2.0", method: "notifications/message", params: {}},
            {jsonrpc: "2.0", id: "srv-ping", method: "ping"},
            {jsonrpc: "2.0", id: "srv-other", method: "sampling/createMessage", params: {}},
            {jsonrpc: "2.0", id, result});
    }
    return respond({result}, id);
}

function headersOf(ClientAuthentication auth) returns HeaderProvider|error {
    HeaderProvider? provider = check createHeaderProvider(auth, check keysDirectory(), MCP_HTTP_LABEL, MCP_HTTP_URL);
    return provider ?: error("no authentication");
}

function oauth2Headers(OAuth2Authentication auth, JwtSigner? signer = ()) returns HeaderProvider|error =>
    new OAuth2Headers(check new OAuth2TokenProvider(auth, signer, monotonicClock, MCP_HTTP_URL));

function connect(HeaderProvider headers, ToolFilter? filter = ()) returns McpHttpToolKit|error =>
    new (MCP_HTTP_URL, headers, filter, MCP_HTTP_LABEL);

function toolNames(ai:BaseToolKit toolKit) returns string[] => from ai:ToolConfig tool in toolKit.getTools() select tool.name;

function rpcSequence() returns string[] => from McpCall call in mcpCalls select call.rpc;

function connectFails(HeaderProvider headers, string messagePart, string... secrets) returns error? {
    McpHttpToolKit|error result = connect(headers);
    if result is McpHttpToolKit {
        test:assertFail("expected the connection to fail");
    }
    test:assertTrue(result.message().includes(messagePart), result.message());
    foreach string secret in secrets {
        test:assertFalse(result.message().includes(secret), "the message must not contain a credential");
    }
}

function bearerOf(string... accepted) returns function (http:Request) returns boolean =>
    request => accepted.indexOf(headerOf(request, "authorization")) is int;

@test:Config
function testAnApiKeyAuthenticatesEveryRequestOfTheSession() returns error? {
    resetMcpHttp();
    mcpAuthorize = hasHeader("authorization", API_KEY);
    McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));

    test:assertEquals(toolNames(toolKit), DEFAULT_TOOLS);
    map<json> result = check toolKit.callTool({name: "echo", arguments: {text: "hi"}});
    test:assertEquals(result, {content: [{"type": "text", text: "echo"}]});

    test:assertEquals(rpcSequence(), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    foreach McpCall call in mcpCalls {
        test:assertEquals(call.headers["authorization"], API_KEY, call.rpc);
        test:assertEquals(call.headers["accept"], "application/json, text/event-stream");
    }
    test:assertEquals(executedTools, [{name: "echo", arguments: {text: "hi"}}]);
}

@test:Config
function testAnApiKeyInACustomHeader() returns error? {
    resetMcpHttp();
    mcpAuthorize = hasHeader("x-api-key", API_KEY);
    _ = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY, header_name: "X-API-Key"}));

    test:assertEquals(rpcSequence(), ["initialize", "notifications/initialized", "tools/list"]);
    foreach McpCall call in mcpCalls {
        test:assertEquals(call.headers["x-api-key"], API_KEY, call.rpc);
        test:assertFalse(call.headers.hasKey("authorization"), call.rpc);
    }
}

@test:Config
function testARejectedApiKeyIsNotRetried() returns error? {
    resetMcpHttp();
    mcpAuthorize = hasHeader("authorization", "another-key");
    check connectFails(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}), "initialize failed (HTTP 401)", API_KEY);
    test:assertEquals(rpcSequence(), ["initialize"]);
}

@test:Config
function testOAuth2ClientCredentialsSendsTheTokenWithEveryRequest() returns error? {
    resetMcpHttp();
    useTokenReplies(tokenReply("access-1"));
    mcpAuthorize = bearerOf("Bearer access-1");
    McpHttpToolKit toolKit = check connect(check oauth2Headers(clientCredentials()));
    _ = check toolKit.callTool({name: "echo", arguments: {text: "hi"}});

    test:assertEquals(rpcSequence(), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    test:assertEquals(tokenRequests.length(), 1);
    test:assertEquals(check lastForm(), {grant_type: "client_credentials", 'resource: MCP_HTTP_URL});
    foreach McpCall call in mcpCalls {
        test:assertEquals(call.headers["authorization"], "Bearer access-1", call.rpc);
    }
}

@test:Config
function testTheResourceDefaultsToTheCanonicalUriOfTheServerUnlessConfigured() returns error? {
    useTokenReplies(tokenReply());
    OAuth2TokenProvider defaulted = check new (clientCredentials(), (), monotonicClock, "HTTP://MCP.Example.com:8443/Mcp?a=B#top");
    _ = check defaulted.getToken();
    test:assertEquals((check lastForm())["resource"], "http://mcp.example.com:8443/Mcp?a=B");

    OAuth2Authentication configured = clientCredentials();
    configured.'resource = "https://resource.example.com";
    OAuth2TokenProvider explicit = check new (configured, (), monotonicClock, MCP_HTTP_URL);
    _ = check explicit.getToken();
    test:assertEquals((check lastForm())["resource"], "https://resource.example.com");

    OAuth2TokenProvider webhook = check new (clientCredentials(), (), monotonicClock);
    _ = check webhook.getToken();
    test:assertFalse((check lastForm()).hasKey("resource"));
}

@test:Config
function testTheCanonicalUri() {
    map<string> expected = {
        "https://mcp.example.com/mcp": "https://mcp.example.com/mcp",
        "HTTPS://Mcp.Example.COM/Path/To?Q=Mixed": "https://mcp.example.com/Path/To?Q=Mixed",
        "http://LOCALHOST:9296": "http://localhost:9296",
        "https://mcp.example.com/mcp#fragment": "https://mcp.example.com/mcp",
        "https://User:Pass@MCP.example.com:8443/a/B/": "https://User:Pass@mcp.example.com:8443/a/B/",
        "https://mcp.example.com?x=1": "https://mcp.example.com?x=1"
    };
    foreach [string, string] [url, canonical] in expected.entries() {
        test:assertEquals(canonicalResourceUri(url), canonical, url);
    }
}

@test:Config
function testTheTokenIsReusedAndRenewedBeforeItExpires() returns error? {
    resetMcpHttp();
    useTokenReplies(tokenReply("access-1", {expires_in: 600}), tokenReply("access-2", {expires_in: 600}));
    McpHttpToolKit toolKit = check connect(check oauth2Headers(clientCredentials()));
    _ = check toolKit.callTool({name: "echo", arguments: {text: "1"}});
    test:assertEquals(tokenRequests.length(), 1);

    advanceClock(541);
    _ = check toolKit.callTool({name: "echo", arguments: {text: "2"}});
    test:assertEquals(tokenRequests.length(), 2);
    test:assertEquals(mcpCalls[mcpCalls.length() - 1].headers["authorization"], "Bearer access-2");
}

@test:Config
function testA401RenewsTheTokenAndRepeatsTheRequestOnce() returns error? {
    resetMcpHttp();
    useTokenReplies(tokenReply("access-1"), tokenReply("access-2"));
    mcpAuthorize = bearerOf("Bearer access-2");
    McpHttpToolKit toolKit = check connect(check oauth2Headers(clientCredentials()));
    _ = check toolKit.callTool({name: "echo", arguments: {text: "hi"}});

    test:assertEquals(rpcSequence(), ["initialize", "initialize", "notifications/initialized", "tools/list", "tools/call"]);
    test:assertEquals(mcpCalls[0].headers["authorization"], "Bearer access-1");
    test:assertEquals(mcpCalls[1].headers["authorization"], "Bearer access-2");
    test:assertEquals(tokenRequests.length(), 2);
}

@test:Config
function testASecond401StopsTheRetry() returns error? {
    resetMcpHttp();
    useTokenReplies(tokenReply("access-1"), tokenReply("access-2"), tokenReply("access-3"));
    mcpAuthorize = bearerOf("Bearer nobody");
    check connectFails(check oauth2Headers(clientCredentials()), "initialize failed (HTTP 401)", "access-1", "access-2");
    test:assertEquals(rpcSequence(), ["initialize", "initialize"]);
    test:assertEquals(tokenRequests.length(), 2);
}

@test:Config
function testOnly401sRenewTheToken() returns error? {
    resetMcpHttp();
    useTokenReplies(tokenReply("access-1"), tokenReply("access-2"));
    McpHttpToolKit toolKit = check connect(check oauth2Headers(clientCredentials()));

    foreach int status in [403, 500] {
        mcpStatus = {"tools/call": status};
        map<json>|error result = toolKit.callTool({name: "echo", arguments: {text: "hi"}});
        test:assertTrue(result is error);
        test:assertEquals((<error>result).message(), string `${MCP_HTTP_LABEL}: tools/call failed (HTTP ${status})`);
    }
    test:assertEquals(tokenRequests.length(), 1);
    test:assertEquals(executedTools.length(), 0);
}

@test:Config
function testAStale401DoesNotEraseANewerToken() returns error? {
    useTokenReplies(tokenReply("access-1"), tokenReply("access-2"), tokenReply("access-3"));
    OAuth2TokenProvider provider = check new (clientCredentials(), (), monotonicClock);
    test:assertEquals(check provider.getToken(), "access-1");

    provider.invalidate("access-1");
    test:assertEquals(check provider.getToken(), "access-2");
    provider.invalidate("access-1");
    test:assertEquals(check provider.getToken(), "access-2");
    test:assertEquals(tokenRequests.length(), 2);
}

@test:Config
function testTheJwtBearerGrantSendsAFreshSignedAssertionForEveryTokenRequest() returns error? {
    resetMcpHttp();
    useTokenReplies(tokenReply("access-1"), tokenReply("access-2"));
    mcpAuthorize = bearerOf("Bearer access-2");
    JwtSigning signing = rsaSigning("RS256");
    signing.audience = "https://idp.example.com/token";
    signing.subject = "my-service";
    McpHttpToolKit toolKit = check connect(check oauth2Headers(jwtBearer(signing), check assertionSigner(signing)));
    _ = check toolKit.callTool({name: "echo", arguments: {text: "hi"}});

    test:assertEquals(tokenRequests.length(), 2);
    string[] jti = [];
    foreach int index in 0 ..< 2 {
        string assertion = check assertionOf(index);
        test:assertTrue(check verifyJwt(assertion, "RS256", check publicKey("rsa-2048-cert.pem")));
        map<json> claims = check jsonPart(assertion, 1);
        test:assertEquals(claims["iss"], "my-issuer");
        test:assertEquals(claims["sub"], "my-service");
        test:assertEquals(claims["aud"], "https://idp.example.com/token");
        test:assertEquals(claims["exp"], (check claims["iat"].ensureType(int)) + 300);
        string id = check claims["jti"].ensureType();
        jti.push(id);
    }
    test:assertNotEquals(jti[0], jti[1]);

    map<string> form = check lastForm();
    test:assertEquals(form["grant_type"], JWT_BEARER);
    test:assertEquals(form["resource"], MCP_HTTP_URL);
}

@test:Config
function testTheClientAuthenticationMethodsOfTheTokenRequest() returns error? {
    resetMcpHttp();
    OAuth2Authentication post = clientCredentials();
    post.token_endpoint_auth_method = "client_secret_post";
    JwtSigning signing = hmacSigning("HS256");
    OAuth2Authentication none = jwtBearer(signing);
    none.token_endpoint_auth_method = "none";
    _ = none.remove("client_id");
    _ = none.remove("client_secret");

    useTokenReplies(tokenReply());
    _ = check connect(check oauth2Headers(clientCredentials()));
    test:assertTrue(tokenRequests[0].authorization.startsWith("Basic "));

    useTokenReplies(tokenReply());
    _ = check connect(check oauth2Headers(post));
    test:assertEquals(tokenRequests[0].authorization, "");
    test:assertEquals((check lastForm())["client_id"], "client");
    test:assertEquals((check lastForm())["client_secret"], "secret");

    useTokenReplies(tokenReply());
    _ = check connect(check oauth2Headers(none, check assertionSigner(signing)));
    test:assertEquals(tokenRequests[0].authorization, "");
    test:assertEquals((check lastForm()).keys().sort(), ["assertion", "grant_type", "resource"]);
}

@test:Config
function testATokenThatCannotBeUsedIsReportedWithoutCallingTheServer() returns error? {
    resetMcpHttp();
    useTokenReplies({body: {access_token: "access-1", token_type: "mac"}});
    check connectFails(check oauth2Headers(clientCredentials()), "token_type is not Bearer", "access-1");

    useTokenReplies({status: 500, body: {'error: "server_error", error_description: "S3CR3T-VALUE"}});
    check connectFails(check oauth2Headers(clientCredentials()), "token request failed (HTTP 500)", "S3CR3T-VALUE");

    useTokenReplies({status: 302, headers: {"Location": "http://localhost:9294/oauth/elsewhere"}});
    check connectFails(check oauth2Headers(clientCredentials()), "redirect");
    test:assertEquals(mcpCalls.length(), 0);
}

@test:Config
function testResponsesAsJsonAndAsEventStreams() returns error? {
    foreach boolean streamed in [false, true] {
        resetMcpHttp();
        mcpEventStream = streamed;
        McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));
        test:assertEquals(toolNames(toolKit), DEFAULT_TOOLS);
        test:assertEquals(check toolKit.callTool({name: "echo", arguments: {}}), {content: [{"type": "text", text: "echo"}]});
    }
}

@test:Config
function testMessagesOfTheServerBeforeTheResponseAreSkippedOrAnswered() returns error? {
    resetMcpHttp();
    mcpEventStream = true;
    mcpServerRequests = true;
    mcpAuthorize = hasHeader("authorization", API_KEY);
    McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));
    map<json> result = check toolKit.callTool({name: "echo", arguments: {}});

    test:assertEquals(result, {content: [{"type": "text", text: "echo"}]});
    McpCall[] answers = from McpCall call in mcpCalls where call.rpc == "answer" select call;
    test:assertEquals(from McpCall answer in answers select answer.message,
        [{jsonrpc: "2.0", id: "srv-ping", result: {}},
         {jsonrpc: "2.0", id: "srv-other", 'error: {code: -32601, message: "Method not found"}}]);
    foreach McpCall answer in answers {
        test:assertEquals(answer.headers["authorization"], API_KEY);
    }
}

@test:Config
function testAWrongOrBrokenResponseIsAnError() returns error? {
    map<string> expected = {
        "wrong-id": "the response does not answer the request",
        "bad-json": "the response is not valid JSON",
        "text": "unsupported response content type",
        "no-result": "the response has no result",
        "stream-ends": "the event stream ended before the response",
        "stream-invalid": "the event stream sent invalid JSON"
    };
    foreach [string, string] [fault, problem] in expected.entries() {
        resetMcpHttp();
        mcpEventStream = fault.startsWith("stream");
        mcpFault = fault;
        McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));
        map<json>|error result = toolKit.callTool({name: "echo", arguments: {}});
        test:assertTrue(result is error, fault);
        test:assertEquals((<error>result).message(), string `${MCP_HTTP_LABEL}: tools/call failed: ${problem}`, fault);
    }
}

@test:Config
function testAJsonRpcErrorIsAnErrorButAToolErrorIsAResult() returns error? {
    resetMcpHttp();
    McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));

    map<json>|error failure = toolKit.callTool({name: "boom", arguments: {}});
    test:assertTrue(failure is error);
    test:assertEquals((<error>failure).message(),
        string `${MCP_HTTP_LABEL}: tools/call failed: JSON-RPC error -32602 (Invalid params)`);

    map<json> toolError = check toolKit.callTool({name: "fail", arguments: {}});
    test:assertEquals(toolError, {content: [{"type": "text", text: "it failed"}], isError: true});
}

@test:Config
function testAnUnsupportedProtocolVersionIsAnError() returns error? {
    resetMcpHttp();
    mcpProtocolVersion = "2025-06-18";
    check connectFails(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}),
        "does not support MCP protocol version 2025-03-26 (it answered 2025-06-18)");
    test:assertEquals(rpcSequence(), ["initialize"]);
    test:assertEquals(mcpCalls[0].message["params"], {protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: {name: "AFM Ballerina interpreter", version: "1.0.0"}});
}

@test:Config
function testRedirectsAreNotFollowed() returns error? {
    resetMcpHttp();
    mcpStatus = {"initialize": 307};
    check connectFails(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}),
        "initialize failed (HTTP 307; redirects are not followed)");
    test:assertEquals(mcpRedirectHits, 0);
}

@test:Config
function testAStalledEventStreamEndsWithTheTimeout() returns error? {
    McpHttpClient stalled = check new ("http://localhost:9296/stall", check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}),
        MCP_HTTP_LABEL, 2);
    decimal started = time:monotonicNow();
    error? result = stalled.connect();

    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(), string `${MCP_HTTP_LABEL}: initialize failed: the event stream failed`);
    test:assertTrue(time:monotonicNow() - started < 8d, "the call ends by the timeout, not when the server does");
}

@test:Config
function testAnUnusableUrlIsReportedWithoutTheLibraryError() returns error? {
    McpHttpToolKit|error result = new ("http://[not-ipv6]/mcp", check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}),
        (), MCP_HTTP_LABEL);
    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(), string `${MCP_HTTP_LABEL}: the transport url cannot be used by the HTTP client`);
}

@test:Config
function testTheSessionIdIsSentOnEveryRequestAfterInitialize() returns error? {
    resetMcpHttp();
    mcpStateful = true;
    McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));
    _ = check toolKit.callTool({name: "echo", arguments: {}});

    test:assertEquals(rpcSequence(), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    test:assertFalse(mcpCalls[0].headers.hasKey("mcp-session-id"));
    foreach McpCall call in mcpCalls.slice(1) {
        test:assertEquals(call.headers["mcp-session-id"], "session-1", call.rpc);
    }
}

@test:Config
function testAStatelessServerGetsNoSessionId() returns error? {
    resetMcpHttp();
    McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));
    _ = check toolKit.callTool({name: "echo", arguments: {}});
    foreach McpCall call in mcpCalls {
        test:assertFalse(call.headers.hasKey("mcp-session-id"), call.rpc);
    }
}

@test:Config
function testAnExpiredSessionIsRecoveredOnce() returns error? {
    resetMcpHttp();
    mcpStateful = true;
    McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));

    mcpSessionId = "expired";
    map<json> result = check toolKit.callTool({name: "echo", arguments: {text: "hi"}});
    test:assertEquals(result, {content: [{"type": "text", text: "echo"}]});
    test:assertEquals(rpcSequence().slice(3),
        ["tools/call", "initialize", "notifications/initialized", "tools/call"]);
    test:assertEquals(mcpCalls[mcpCalls.length() - 1].headers["mcp-session-id"], "session-2");
    test:assertEquals(executedTools.length(), 1);
}

@test:Config
function testASessionThatIsNeverFoundIsNotRecoveredInALoop() returns error? {
    resetMcpHttp();
    mcpStateful = true;
    McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));

    mcpStatus = {"tools/call": 404};
    map<json>|error result = toolKit.callTool({name: "echo", arguments: {}});
    test:assertTrue(result is error);
    test:assertEquals(rpcSequence().slice(3),
        ["tools/call", "initialize", "notifications/initialized", "tools/call"]);
}

@test:Config
function testASessionIdThatIsNotVisibleAsciiIsRejected() returns error? {
    resetMcpHttp();
    mcpStateful = true;
    mcpFault = "bad-session";
    check connectFails(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}), "the session ID is not visible ASCII",
        "bad id");
}

@test:Config
function testANotFoundWithoutASessionIsAnError() returns error? {
    resetMcpHttp();
    mcpStatus = {"initialize": 404};
    check connectFails(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}), "initialize failed (HTTP 404)");
    test:assertEquals(rpcSequence(), ["initialize"]);
}

@test:Config
function testTheToolsOfAllPagesAreListed() returns error? {
    resetMcpHttp();
    mcpPages = [[echoTool()], [plainTool("hidden")], [plainTool("third")]];
    McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));

    test:assertEquals(toolNames(toolKit), ["echo", "hidden", "third"]);
    test:assertEquals(from McpCall call in mcpCalls where call.rpc == "tools/list" select call.message["params"],
        [{}, {cursor: "1"}, {cursor: "2"}]);
}

@test:Config
function testAnEndlessCursorIsBounded() returns error? {
    resetMcpHttp();
    mcpFault = "endless-cursor";
    check connectFails(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}), "more than 100 pages of tools");
}

@test:Config
function testTheToolFilter() returns error? {
    resetMcpHttp();
    mcpPages = [[echoTool(), plainTool("hidden"), plainTool("third")]];
    [ToolFilter?, string[]][] cases = [
        [(), ["echo", "hidden", "third"]],
        [{}, ["echo", "hidden", "third"]],
        [{allow: ["echo", "third"]}, ["echo", "third"]],
        [{deny: ["hidden"]}, ["echo", "third"]],
        [{allow: ["echo", "hidden"], deny: ["hidden"]}, ["echo"]],
        [{allow: []}, []],
        [{allow: [], deny: ["echo"]}, []],
        [{allow: ["missing"]}, []]
    ];
    foreach [ToolFilter?, string[]] [filter, expected] in cases {
        McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}), filter);
        test:assertEquals(toolNames(toolKit), expected, filter.toString());
    }
}

@test:Config
function testOnlyTheExposedToolsCanBeCalled() returns error? {
    resetMcpHttp();
    McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}), {deny: ["hidden"]});

    map<json>|error result = toolKit.callTool({name: "hidden", arguments: {}});
    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(), "Tool 'hidden' is not available");
    test:assertEquals(executedTools.length(), 0);
}

@test:Config
function testMalformedToolDefinitionsAreAnError() returns error? {
    json[][] malformed = [
        [{name: "", inputSchema: {"type": "object"}}],
        [{inputSchema: {"type": "object"}}],
        [{name: "no-schema"}],
        [{name: "schema-not-an-object", inputSchema: "object"}],
        [{name: "description-not-text", description: 5, inputSchema: {"type": "object"}}]
    ];
    foreach json[] page in malformed {
        resetMcpHttp();
        mcpPages = [page];
        check connectFails(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}),
            string `${MCP_HTTP_LABEL}: tools/list failed: a tool has an invalid definition`);
    }
}

@test:Config
function testADescriptionIsOptionalAndOtherMembersAreIgnored() returns error? {
    resetMcpHttp();
    mcpPages = [[{name: "plain", title: "Plain", inputSchema: {"type": "object"}, annotations: {readOnlyHint: true}}]];
    McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));
    ai:ToolConfig[] tools = toolKit.getTools();
    test:assertEquals(tools.length(), 1);
    test:assertEquals(tools[0].description, "");
    test:assertEquals(tools[0].parameters, {"type": "object"});
}

int llmTurns = 0;
json llmTools = ();
string llmLastMessage = "";

service /llm on new http:Listener(9297) {
    resource function post chat/completions(@http:Payload json payload) returns json|error {
        map<json> request = check payload.ensureType();
        json[] messages = check request["messages"].ensureType();
        llmTurns += 1;
        llmTools = request["functions"];
        llmLastMessage = messages[messages.length() - 1].toJsonString();

        json message;
        if llmTurns == 1 {
            message = {role: "assistant", content: (), function_call: {name: "echo", arguments: "{\"text\":\"hi\"}"}};
        } else {
            message = {role: "assistant", content: "done"};
        }
        return {id: "chatcmpl-1", 'object: "chat.completion", created: 1, model: "mock",
            choices: [{index: 0, message, finish_reason: "stop"}],
            usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}};
    }
}

@test:Config
function testAnAgentRunsTheToolsOfTheToolKit() returns error? {
    resetMcpHttp();
    llmTurns = 0;
    mcpAuthorize = hasHeader("authorization", API_KEY);
    McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}), {deny: ["hidden", "boom", "fail"]});
    ai:Wso2ModelProvider model = check new ("http://localhost:9297/llm", "token");
    ai:Agent agent = check new ({systemPrompt: {role: "tester", instructions: "Use the tools."}, model, tools: [toolKit]});

    string answer = check agent.run("Say hi");

    test:assertEquals(answer, "done");
    json[] offered = check llmTools.ensureType();
    test:assertEquals(offered.length(), 1);
    map<json> echo = check echoTool().ensureType();
    test:assertEquals(check offered[0].name, "echo");
    test:assertEquals(check offered[0].parameters, echo["inputSchema"]);
    test:assertEquals(executedTools, [{name: "echo", arguments: {text: "hi"}}]);
    test:assertEquals(mcpCalls[mcpCalls.length() - 1].headers["authorization"], API_KEY);
    test:assertEquals(llmTurns, 2);
    test:assertTrue(llmLastMessage.includes("echo"), llmLastMessage);
}

@test:Config
function testTheToolStoreReturnsTheResultOfAToolWithItsErrorFlag() returns error? {
    resetMcpHttp();
    McpHttpToolKit toolKit = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));
    ai:ToolStore store = check new (toolKit);

    ai:ToolOutput ok = check store.execute({name: "echo", arguments: {text: "hi"}});
    test:assertEquals(ok.value, {content: [{"type": "text", text: "echo"}]});
    ai:ToolOutput flagged = check store.execute({name: "fail", arguments: {}});
    test:assertEquals(flagged.value, {content: [{"type": "text", text: "it failed"}], isError: true});
    test:assertEquals(executedTools, [{name: "echo", arguments: {text: "hi"}}, {name: "fail", arguments: {}}]);

    ai:ToolOutput|ai:Error unknown = store.execute({name: "hidden2", arguments: {}});
    test:assertTrue(unknown is error);
}

@test:Config
function testTwoServersWithTheSameToolAreNotMerged() returns error? {
    resetMcpHttp();
    McpHttpToolKit first = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));
    McpHttpToolKit second = check connect(check headersOf(<ApiKeyAuthentication>{api_key: API_KEY}));
    ai:ToolStore|ai:Error store = new (first, second);
    test:assertTrue(store is error);
}
