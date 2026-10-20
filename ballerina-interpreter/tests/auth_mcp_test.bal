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
import ballerina/crypto;
import ballerina/http;
import ballerina/lang.array;
import ballerina/test;

const MCP_URL = "http://localhost:9292/mcp";
const MCP_LOCATION = "tools.mcp[0].transport.authentication";

type CapturedMcpRequest record {|
    string method;
    string authorization;
|};

CapturedMcpRequest[] mcpRequests = [];
string mcpRequiredScheme = "Bearer ";

service /mcp on new http:Listener(9292) {
    resource function post .(http:Request request) returns http:Response|error {
        map<json> message = check (check request.getJsonPayload()).ensureType();
        string method = check message["method"].ensureType();
        string authorization = request.getHeader("Authorization") is string ? check request.getHeader("Authorization") : "";
        mcpRequests.push({method, authorization});

        http:Response response = new;
        if !authorization.startsWith(mcpRequiredScheme) {
            response.statusCode = 401;
            return response;
        }
        match method {
            "initialize" => {
                response.setJsonPayload({jsonrpc: "2.0", id: message["id"], result: {protocolVersion: "2025-03-26",
                    capabilities: {tools: {}}, serverInfo: {name: "mock", version: "1.0.0"}}});
            }
            "tools/list" => {
                response.setJsonPayload({jsonrpc: "2.0", id: message["id"], result: {tools: [
                    {name: "echo", description: "Echoes the text", inputSchema: {"type": "object", properties: {text: {"type": "string"}}, required: ["text"]}},
                    {name: "hidden", inputSchema: {"type": "object"}}
                ]}});
            }
            "tools/call" => {
                response.setJsonPayload({jsonrpc: "2.0", id: message["id"], result: {content: [{"type": "text", text: "echo"}]}});
            }
            _ => {
                response.statusCode = 202;
            }
        }
        return response;
    }
}

function resetMcpServer(string requiredScheme) {
    mcpRequests = [];
    mcpRequiredScheme = requiredScheme;
}

function connectToMcpServer(BearerAuthentication|BasicAuthentication|JwtAuthentication auth) returns error? {
    http:ClientAuthConfig? clientAuth = check mcpClientAuth(auth, check resourcesDirectory(), MCP_LOCATION);
    ai:McpToolKit toolKit = check new (MCP_URL, permittedTools = ["echo"], auth = clientAuth);
    test:assertEquals(from ai:ToolConfig tool in toolKit.getTools() select tool.name, ["echo"]);
    _ = check toolKit.callTool({name: "echo", arguments: {"text": "hi"}});
}

function assertEveryRequestWasAuthenticated() {
    test:assertEquals(from CapturedMcpRequest r in mcpRequests select r.method,
        ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    foreach CapturedMcpRequest r in mcpRequests {
        test:assertTrue(r.authorization.startsWith(mcpRequiredScheme), r.method);
    }
}

@test:Config
function testBearerAuthenticatesEveryRequestOfTheSession() returns error? {
    resetMcpServer("Bearer ");
    check connectToMcpServer({token: "abc"});
    assertEveryRequestWasAuthenticated();
    foreach CapturedMcpRequest r in mcpRequests {
        test:assertEquals(r.authorization, "Bearer abc");
    }
}

@test:Config
function testBasicAuthenticatesEveryRequestOfTheSession() returns error? {
    resetMcpServer("Basic ");
    check connectToMcpServer({username: "üser", password: "pässwörd"});
    assertEveryRequestWasAuthenticated();
    string expected = "Basic " + array:toBase64("üser:pässwörd".toBytes());
    foreach CapturedMcpRequest r in mcpRequests {
        test:assertEquals(r.authorization, expected);
    }
}

@test:Config
function testJwtAuthenticatesEveryRequestWithAFreshSignedToken() returns error? {
    resetMcpServer("Bearer ");
    check connectToMcpServer({signing_key: "keys/rsa-2048.pem", issuer: "my-issuer", audience: "llm-api",
        algorithm: "RS256", subject: "svc", key_id: "key-1", custom_claims: {scope: "api:read"}, expiry_seconds: 120});
    assertEveryRequestWasAuthenticated();

    crypto:PublicKey rightKey = check publicKey("rsa-2048-cert.pem");
    foreach CapturedMcpRequest r in mcpRequests {
        string token = r.authorization.substring("Bearer ".length());
        test:assertTrue(check verifyJwt(token, "RS256", rightKey), r.method);
        test:assertEquals(check jsonPart(token, 0), {alg: "RS256", typ: "JWT", kid: "key-1"});
        map<json> claims = check jsonPart(token, 1);
        test:assertEquals(claims["iss"], "my-issuer");
        test:assertEquals(claims["aud"], "llm-api");
        test:assertEquals(claims["sub"], "svc");
        test:assertEquals(claims["scope"], "api:read");
        int issuedAt = check claims["iat"].ensureType();
        test:assertEquals(claims["exp"], issuedAt + 120);
        test:assertEquals(claims["nbf"], issuedAt);
    }
}

@test:Config
function testJwtWithAnHmacSecret() returns error? {
    resetMcpServer("Bearer ");
    check connectToMcpServer({issuer: "my-issuer", audience: "llm-api", signing_key: HMAC_SECRETS.get("HS384"), algorithm: "HS384"});
    assertEveryRequestWasAuthenticated();
    string token = mcpRequests[0].authorization.substring("Bearer ".length());
    test:assertTrue(check verifyJwt(token, "HS384", HMAC_SECRETS.get("HS384").toBytes()));
}

@test:Config
function testNoAuthenticationNeedsNoClientAuth() returns error? {
    test:assertTrue((check mcpClientAuth((), "/unused", MCP_LOCATION)) is ());
}

@test:Config
function testTheLibraryClientAuthMatchesTheAuthentication() returns error? {
    string directory = check resourcesDirectory();
    test:assertEquals(check mcpClientAuth(<BearerAuthentication>{token: "t"}, directory, MCP_LOCATION), {token: "t"});
    test:assertEquals(check mcpClientAuth(<BasicAuthentication>{username: "u", password: "p"}, directory, MCP_LOCATION),
        {username: "u", password: "p"});

    http:ClientAuthConfig? jwt = check mcpClientAuth(<JwtAuthentication>{issuer: "i", audience: ["a", "b"],
        signing_key: "keys/rsa-2048.pem", subject: "s", key_id: "k", expiry_seconds: 60}, directory, MCP_LOCATION);
    http:JwtIssuerConfig config = check jwt.ensureType();
    test:assertEquals(config.issuer, "i");
    test:assertEquals(config.audience, ["a", "b"]);
    test:assertEquals(config.username, "s");
    test:assertEquals(config.keyId, "k");
    test:assertEquals(config.expTime, 60d);
    test:assertEquals(config?.signatureConfig?.algorithm, "RS256");
    test:assertEquals(config?.signatureConfig?.config, {keyFile: directory + "/keys/rsa-2048.pem"});
}

@test:Config
function testUnusableJwtKeysAreRejectedBeforeAnyRequest() returns error? {
    string directory = check resourcesDirectory();
    foreach string keyFile in ["keys/rsa-2047.pem", "keys/rsa-1024.pem"] {
        http:ClientAuthConfig|error? result = mcpClientAuth(<JwtAuthentication>{issuer: "i", audience: "a", signing_key: keyFile},
            directory, MCP_LOCATION);
        test:assertTrue(result is error, keyFile);
        test:assertEquals((<error>result).message(), "signing_key RSA key must be at least 2048 bits");
    }
}
