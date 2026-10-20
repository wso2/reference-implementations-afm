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

import ballerina/lang.array;

type HeaderProvider isolated object {
    isolated function getHeaders() returns map<string>|error;

    isolated function renew(map<string> rejected) returns boolean;
};

const BEARER_PREFIX = "Bearer ";

final readonly & string[] REQUEST_RESERVED_HEADERS = ["content-type", "content-length", "host", "transfer-encoding", "connection"];

final readonly & string[] MCP_RESERVED_HEADERS = [...REQUEST_RESERVED_HEADERS, "accept", "mcp-session-id",
    "mcp-protocol-version", "last-event-id"];

isolated class StaticHeaders {
    *HeaderProvider;

    private final readonly & map<string> headers;

    isolated function init(map<string> headers) {
        self.headers = headers.cloneReadOnly();
    }

    isolated function getHeaders() returns map<string>|error => self.headers;

    isolated function renew(map<string> rejected) returns boolean => false;
}

isolated class JwtHeaders {
    *HeaderProvider;

    private final JwtSigner signer;

    isolated function init(JwtSigner signer) {
        self.signer = signer;
    }

    isolated function getHeaders() returns map<string>|error => {"Authorization": "Bearer " + check self.signer.sign()};

    isolated function renew(map<string> rejected) returns boolean => false;
}

isolated class OAuth2Headers {
    *HeaderProvider;

    private final OAuth2TokenProvider tokens;

    isolated function init(OAuth2TokenProvider tokens) {
        self.tokens = tokens;
    }

    isolated function getHeaders() returns map<string>|error => {"Authorization": BEARER_PREFIX + check self.tokens.getToken()};

    isolated function renew(map<string> rejected) returns boolean {
        self.tokens.invalidate(rejected.get("Authorization").substring(BEARER_PREFIX.length()));
        return true;
    }
}

function createHeaderProvider(ClientAuthentication? auth, string afmFileDir, string location, string? mcpUrl = ())
        returns HeaderProvider?|error {
    if auth is () {
        return ();
    }
    if auth is BearerAuthentication {
        check checkSendable("token", auth.token, location);
        return new StaticHeaders({"Authorization": "Bearer " + auth.token});
    }
    if auth is BasicAuthentication {
        return new StaticHeaders({"Authorization": "Basic " + array:toBase64(string `${auth.username}:${auth.password}`.toBytes())});
    }
    if auth is ApiKeyAuthentication {
        check checkSendable("api_key", auth.api_key, location);
        string headerName = auth?.header_name ?: "Authorization";
        if mcpUrl is string && MCP_RESERVED_HEADERS.indexOf(headerName.toLowerAscii()) is int {
            return error(string `${location}: header_name cannot be a header that the MCP transport sets itself ` +
                "(Accept, Content-Type, Mcp-Session-Id, ...)");
        }
        if mcpUrl is () && REQUEST_RESERVED_HEADERS.indexOf(headerName.toLowerAscii()) is int {
            return error(string `${location}: header_name cannot be a header that the HTTP request needs itself ` +
                "(Content-Type, Content-Length, Host, ...)");
        }
        return new StaticHeaders({[headerName]: auth.api_key});
    }
    if auth is JwtAuthentication {
        JwtAuthentication {'type: _, ...signing} = auth;
        return new JwtHeaders(check new JwtSigner(signing, afmFileDir));
    }

    AssertionSigning? assertionSigning = auth?.assertion_signing;
    JwtSigner? signer = assertionSigning is AssertionSigning ? check new JwtSigner(assertionSigning, afmFileDir) : ();
    return new OAuth2Headers(check new OAuth2TokenProvider(auth, signer, mcpUrl = mcpUrl));
}
