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
import ballerina/lang.array;
import ballerina/test;

const RF_URL = "http://localhost:9298/rf";
const string RF_SECRET = "S3CR3T-hmac-secret-0123456789abcdefghijkl";

listener http:Listener rfListener = new (9298);
string rfMode = "";
map<string>[] rfSeen = [];
int rfInitializedCalls = 0;

service /rf on rfListener {
    resource function post .(http:Request request) returns http:Response|error {
        map<json> message = check (check request.getJsonPayload()).ensureType();
        json method = message["method"];
        string rpc = method is string ? method : "answer";
        map<string> headers = {};
        foreach string name in request.getHeaderNames() {
            headers[name.toLowerAscii()] = check request.getHeader(name);
        }
        headers["rpc"] = rpc;
        rfSeen.push(headers);
        json id = message["id"];
        http:Response response = new;
        match rpc {
            "initialize" => {
                response.setJsonPayload({jsonrpc: "2.0", id, result: {protocolVersion: "2025-03-26", capabilities: {tools: {}},
                    serverInfo: {name: "rf", version: "1"}}});
                response.setHeader("Mcp-Session-Id", "rf-session-1");
                return response;
            }
            "notifications/initialized" => {
                rfInitializedCalls += 1;
                boolean refuse = (rfMode == "initialized-404-once" && rfInitializedCalls == 1) || rfMode == "initialized-404-always";
                response.statusCode = refuse ? 404 : 202;
                return response;
            }
            "tools/list" => {
                response.setJsonPayload({jsonrpc: "2.0", id, result: {tools: [{name: "echo", inputSchema: {"type": "object"}}]}});
                return response;
            }
            "tools/call" => {
                map<json> reply = {jsonrpc: "2.0", id, result: {content: [{"type": "text", text: "echo"}]}};
                match rfMode {
                    "echo-error" => {
                        string longText = string:'join("", ...from int i in 0 ..< 60 select "0123456789");
                        string credential = (headers["authorization"] ?: "") + (headers["x-api-key"] ?: "");
                        string text = "Invalid credentials: raw=" + credential + " base64=" + array:toBase64(credential.toBytes()) +
                            " first8=" + credential.substring(0, 8) + " session=" + (headers["mcp-session-id"] ?: "") +
                            "\n\u{1B}[31mINJECTED LINE\u{1B}[0m " + longText;
                        response.setJsonPayload({jsonrpc: "2.0", id, 'error: {code: -32001, message: text}});
                        return response;
                    }
                    "batch-notifications" => {
                        json batch = [{jsonrpc: "2.0", method: "notifications/message", params: {}}, {jsonrpc: "2.0", id: "srv-ping", method: "ping"}];
                        response.setTextPayload("data: " + batch.toJsonString() + "\n\n" + "data: " + reply.toJsonString() + "\n\n", "text/event-stream");
                        return response;
                    }
                    "batch-response" => {
                        json batch = [reply];
                        response.setTextPayload("data: " + batch.toJsonString() + "\n\n", "text/event-stream");
                        return response;
                    }
                    "json-array" => {
                        json batch = [reply];
                        response.setJsonPayload(batch);
                        return response;
                    }
                }
                response.setJsonPayload(reply);
                return response;
            }
        }
        response.statusCode = 202;
        return response;
    }
}

function rfRpcs() returns string[] => from map<string> h in rfSeen select h.get("rpc");

function rfConnect(string mode, HeaderProvider headers) returns McpHttpToolKit|error {
    rfMode = mode;
    rfSeen = [];
    rfInitializedCalls = 0;
    return new (RF_URL, headers, (), "probe");
}

function rfApiKey(string key) returns HeaderProvider|error => headersOf(<ApiKeyAuthentication>{api_key: key});

@test:Config
function testASecretWrittenForAnRsaKeyIsNotInTheError() returns error? {
    JwtAuthentication jwtAuth = {issuer: "i", audience: "a", signing_key: RF_SECRET};
    OAuth2Authentication assertionAuth = {grant_type: JWT_BEARER, token_url: "https://idp.example.com/token", client_id: "c",
        client_secret: "s", assertion_signing: {issuer: "i", subject: "s", audience: "a", signing_key: RF_SECRET}};
    error[] failures = [];
    foreach ClientAuthentication auth in [jwtAuth, assertionAuth] {
        HeaderProvider?|error result = createHeaderProvider(auth, "/work", "loc");
        test:assertTrue(result is error);
        failures.push(<error>result);
    }
    ai:McpBaseToolKit|error library = createMcpToolKit({url: RF_URL, authentication: jwtAuth}, (), "/work", "tools.mcp[0]");
    test:assertTrue(library is error);
    failures.push(<error>library);

    foreach error failure in failures {
        test:assertTrue(failure.message().endsWith("cannot be read"), failure.message());
        test:assertFalse(failure.message().includes(RF_SECRET), "the message must not contain the key");
    }
}

@test:Config
function testTheValueIsNeverShownEvenIfItLooksLikeAFileName() {
    foreach string value in ["keys/missing.pem", "S3CR3T.pem", "secret.key", RF_SECRET + ".pem", RF_SECRET + ".KEY"] {
        JwtAuthentication jwtAuth = {issuer: "i", audience: "a", signing_key: value};
        HeaderProvider?|error result = createHeaderProvider(jwtAuth, "/work", "loc");
        test:assertTrue(result is error, value);
        test:assertEquals((<error>result).message(), "signing_key file cannot be read", value);
    }
}

@test:Config
function testATokenUrlTheHttpLibraryCannotReadIsRejected() {
    foreach string url in ["https://[not-ipv6]/token", "https://[1:2:3]/token", "https://[v1.x]/token"] {
        test:assertFalse(isValidTokenUrl(url), url);
    }
    foreach string url in ["https://idp.example.com:8443/t", "http://[::1]:8443/token", "http://localhost:8080/token", "https://example.com/t?x=1"] {
        test:assertTrue(isValidTokenUrl(url), url);
    }
}

@test:Config
function testTheTokenProviderDoesNotForwardTheLibraryErrorOfAUrl() {
    OAuth2Authentication auth = {grant_type: CLIENT_CREDENTIALS, token_url: "https://user:S3CR3T@[bad]/token", client_id: "c", client_secret: "s"};
    OAuth2TokenProvider|error provider = new (auth, ());
    test:assertTrue(provider is error);
    test:assertEquals((<error>provider).message(), "token_url cannot be used by the HTTP client");
}

@test:Config
function testAMalformedResourceIsRejected() {
    foreach string uri in ["https://[not-ipv6]/mcp", "https://example.com:99999/mcp", "https://example.com/a%zz", "http://[::1/x", "https:///x"] {
        test:assertFalse(isAbsoluteUri(uri), uri);
    }
    foreach string uri in ["urn:example:mcp", "https://example.com:8443/a%20b?x=1", "https://mcp.example.com/mcp", "a:b", "ftp://files.example.com/x"] {
        test:assertTrue(isAbsoluteUri(uri), uri);
    }
}

@test:Config
function testAHugeJwtExpiryIsAControlledError() returns error? {
    JwtSigning signing = {issuer: "i", audience: "a", signing_key: "0123456789abcdef0123456789abcdef", algorithm: "HS256", expiry_seconds: int:MAX_VALUE};
    JwtSigner signer = check new (signing, "/tmp");
    string|error token = signer.sign();
    test:assertTrue(token is error);
    test:assertEquals((<error>token).message(), "expiry_seconds is too large");

    JwtSigning ordinary = {issuer: "i", audience: "a", signing_key: "0123456789abcdef0123456789abcdef", algorithm: "HS256", expiry_seconds: 4102444800};
    JwtSigner ordinarySigner = check new (ordinary, "/tmp");
    test:assertTrue(ordinarySigner.sign() is string);
}

@test:Config
function testTheKeyCannotUseAHeaderTheMcpTransportSets() returns error? {
    foreach string name in ["Accept", "accept", "Content-Type", "Mcp-Session-Id", "MCP-Protocol-Version", "Host", "Last-Event-ID"] {
        ApiKeyAuthentication auth = {api_key: "k", header_name: name};
        HeaderProvider?|error result = createHeaderProvider(auth, "/unused", "tools.mcp[0].transport.authentication", RF_URL);
        test:assertTrue(result is error, name);
        test:assertEquals((<error>result).message(), "tools.mcp[0].transport.authentication: header_name cannot be a header that " +
            "the MCP transport sets itself (Accept, Content-Type, Mcp-Session-Id, ...)", name);
    }
    ApiKeyAuthentication fine = {api_key: "k", header_name: "X-API-Key"};
    test:assertTrue((check createHeaderProvider(fine, "/unused", "loc", RF_URL)) is HeaderProvider);
    ApiKeyAuthentication onWebhook = {api_key: "k", header_name: "Accept"};
    test:assertTrue((check createHeaderProvider(onWebhook, "/unused", "loc")) is HeaderProvider);
}

@test:Config
function testTheKeyCannotUseAHeaderTheHttpRequestOfAWebhookNeeds() returns error? {
    foreach string name in ["Content-Type", "content-type", "Content-Length", "Host", "Transfer-Encoding", "Connection"] {
        ApiKeyAuthentication auth = {api_key: "k", header_name: name};
        HeaderProvider?|error result = createHeaderProvider(auth, "/unused", "interfaces[0].subscription.authentication");
        test:assertTrue(result is error, name);
        test:assertEquals((<error>result).message(), "interfaces[0].subscription.authentication: header_name cannot be a " +
            "header that the HTTP request needs itself (Content-Type, Content-Length, Host, ...)", name);
    }
    foreach string name in ["X-API-Key", "Authorization", "Accept", "User-Agent", "Cookie", "Expect"] {
        ApiKeyAuthentication auth = {api_key: "k", header_name: name};
        test:assertTrue((check createHeaderProvider(auth, "/unused", "loc")) is HeaderProvider, name);
    }
}

@test:Config
function testTheTextOfAServerErrorIsNeverShown() returns error? {
    string key = "S3CR3T-API-KEY-0123456789";
    McpHttpToolKit toolKit = check rfConnect("echo-error", check headersOf(<ApiKeyAuthentication>{api_key: key, header_name: "X-API-Key"}));
    map<json>|error result = toolKit.callTool({name: "echo", arguments: {}});

    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(), "probe: tools/call failed: JSON-RPC error -32001 (Server error)");
}

@test:Config
function testAnOAuth2TokenInAServerErrorIsNotShown() returns error? {
    useTokenReplies(tokenReply("access-token-value"));
    McpHttpToolKit toolKit = check rfConnect("echo-error", new OAuth2Headers(check new OAuth2TokenProvider(clientCredentials(), (), monotonicClock, RF_URL)));
    map<json>|error result = toolKit.callTool({name: "echo", arguments: {}});
    test:assertEquals((<error>result).message(), "probe: tools/call failed: JSON-RPC error -32001 (Server error)");
}

@test:Config
function testTheCodeOfAJsonRpcErrorIsNamedFromAFixedList() {
    map<string> expected = {
        "-32700": "-32700 (Parse error)",
        "-32600": "-32600 (Invalid Request)",
        "-32601": "-32601 (Method not found)",
        "-32602": "-32602 (Invalid params)",
        "-32603": "-32603 (Internal error)",
        "-32000": "-32000 (Server error)",
        "-32099": "-32099 (Server error)",
        "-32100": "-32100",
        "42": "42"
    };
    foreach [string, string] [code, text] in expected.entries() {
        test:assertEquals(describeCode(checkpanic int:fromString(code)), text, code);
    }
}

listener http:Listener rfHubListener = new (9300);

service /hub on rfHubListener {
    resource function post .(http:Request request) returns http:Response|error {
        string credential = request.getHeader("X-API-Key") is string ? check request.getHeader("X-API-Key") : "";
        http:Response response = new;
        response.statusCode = 401;
        response.setTextPayload("invalid credentials: raw=" + credential + " base64=" + array:toBase64(credential.toBytes()));
        return response;
    }
}

@test:Config
function testTheAnswerOfAHubThatRefusesTheSubscriptionIsNeverShown() returns error? {
    string afmText = string `---${"\n"}model:${"\n"}  provider: "wso2"${"\n"}  url: "http://localhost:9192/ballerina-copilot/v2.0/webhook"${"\n"}  authentication:${"\n"}    type: "bearer"${"\n"}    token: "mock-token"${"\n"}interfaces:${"\n"}  - type: webhook${"\n"}    subscription:${"\n"}      protocol: "websub"${"\n"}      hub: "http://localhost:9300/hub"${"\n"}      topic: "http://localhost:9300/events"${"\n"}      authentication:${"\n"}        type: api-key${"\n"}        api_key: S3CR3T-API-KEY-0123456789${"\n"}        header_name: X-API-Key${"\n"}---${"\n"}# Role${"\n"}r${"\n"}# Instructions${"\n"}i${"\n"}`;
    AFMRecord afm = check parseAfm(afmText);
    error? result = runAgentFromAFM(afm, 28199, check resourcesDirectory());

    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(), "Subscription initiation failed: the hub refused the request or could not be reached");
}

@test:Config
function testASessionThatIsGoneBeforeInitializedIsStartedAgainOnce() returns error? {
    McpHttpToolKit toolKit = check rfConnect("initialized-404-once", check rfApiKey("k"));
    test:assertEquals(rfRpcs(), ["initialize", "notifications/initialized", "initialize", "notifications/initialized", "tools/list"]);
    test:assertEquals(toolNames(toolKit), ["echo"]);
    test:assertEquals(rfSeen[3].get("mcp-session-id"), "rf-session-1");
    test:assertFalse(rfSeen[2].hasKey("mcp-session-id"), "the new session starts without a session ID");
}

@test:Config
function testASessionThatIsAlwaysGoneIsNotStartedInALoop() returns error? {
    McpHttpToolKit|error toolKit = rfConnect("initialized-404-always", check rfApiKey("k"));
    test:assertTrue(toolKit is error);
    test:assertEquals(rfRpcs(), ["initialize", "notifications/initialized", "initialize", "notifications/initialized"]);
}

@test:Config
function testBatchedMessagesAreAccepted() returns error? {
    foreach string mode in ["batch-notifications", "batch-response", "json-array"] {
        McpHttpToolKit toolKit = check rfConnect(mode, check rfApiKey("k"));
        map<json> result = check toolKit.callTool({name: "echo", arguments: {}});
        test:assertEquals(result, {content: [{"type": "text", text: "echo"}]}, mode);
    }
    test:assertEquals(rfSeen[rfSeen.length() - 1].get("rpc"), "tools/call");
    rfSeen = [];
    McpHttpToolKit toolKit = check rfConnect("batch-notifications", check rfApiKey("k"));
    _ = check toolKit.callTool({name: "echo", arguments: {}});
    test:assertEquals(rfRpcs().slice(3), ["tools/call", "answer"]);
}
