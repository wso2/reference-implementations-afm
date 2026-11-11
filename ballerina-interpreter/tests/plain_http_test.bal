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


import ballerina/test;

const PLAIN_HTTP_SECRET = "S3CR3T-VALUE";
const PLAIN_HTTP_TARGET = "tools.mcp[0].transport.url";

@test:Config
function testPlainHttpToARemoteHostIsDetected() {
    string[] urls = ["http://example.com", "http://example.com:8080/mcp", "HTTP://Example.COM/mcp",
        "http://localhost.example.com/", "http://127.0.0.1.example.com/", "http://localhost@example.com/",
        "http://127.0.0.2/", "http://[2001:db8::1]:8080/"];
    foreach string url in urls {
        test:assertTrue(isPlainHttpRemote(url), url);
    }
}

@test:Config
function testOtherUrlsAreNotDetectedAsPlainHttpToARemoteHost() {
    string[] urls = ["https://example.com", "HTTPS://example.com/mcp", "http://localhost", "http://LOCALHOST:8080/mcp",
        "http://127.0.0.1:9000/x", "http://[::1]:8080/x", "http://example.com@localhost/", "ws://example.com", "http://",
        "http://[::1", "example.com", ""];
    foreach string url in urls {
        test:assertFalse(isPlainHttpRemote(url), url);
    }
}

@test:Config
function testAuthenticationOverPlainHttpIsWarnedAbout() {
    ClientAuthentication[] authentications = [<BearerAuthentication>{token: "abc"},
        <BasicAuthentication>{username: "u", password: "p"}, <ApiKeyAuthentication>{api_key: "k"}];
    foreach ClientAuthentication auth in authentications {
        test:assertEquals(plainHttpWarning("http://example.com/mcp", auth, PLAIN_HTTP_TARGET),
            "tools.mcp[0].transport.url: authentication is sent over plain http, which does not protect credentials or " +
            "tokens on the network; use an https URL");
    }
}

@test:Config
function testSecureLoopbackAndUnauthenticatedUrlsAreNotWarnedAbout() {
    BearerAuthentication auth = {token: "abc"};
    foreach string url in ["https://example.com/mcp", "http://localhost:8080/mcp", "http://[::1]/mcp"] {
        test:assertTrue(plainHttpWarning(url, auth, PLAIN_HTTP_TARGET) is (), url);
    }
    test:assertTrue(plainHttpWarning("http://example.com/mcp", (), PLAIN_HTTP_TARGET) is ());
}

@test:Config
function testTheWarningDoesNotContainTheUrlOrTheCredentials() {
    string url = string `http://user:${PLAIN_HTTP_SECRET}@mcp.example.com/mcp?key=${PLAIN_HTTP_SECRET}`;
    string? warning = plainHttpWarning(url, <BearerAuthentication>{token: PLAIN_HTTP_SECRET}, PLAIN_HTTP_TARGET);

    test:assertTrue(warning is string);
    test:assertFalse((<string>warning).includes(PLAIN_HTTP_SECRET));
    test:assertFalse((<string>warning).includes("mcp.example.com"));
}
