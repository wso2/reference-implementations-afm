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

import ballerina/http;
import ballerina/test;

const HEADER_LOCATION = "interfaces[0].subscription.authentication";

@test:Config
function testStaticHeadersOfTheSimpleTypes() returns error? {
    string directory = check resourcesDirectory();

    HeaderProvider? bearer = check createHeaderProvider(<BearerAuthentication>{token: "abc"}, directory, HEADER_LOCATION);
    test:assertEquals(check (<HeaderProvider>bearer).getHeaders(), {"Authorization": "Bearer abc"});

    HeaderProvider? basic = check createHeaderProvider(<BasicAuthentication>{username: "üser", password: "pässwörd"},
        directory, HEADER_LOCATION);
    test:assertEquals(check (<HeaderProvider>basic).getHeaders(), {"Authorization": "Basic w7xzZXI6cMOkc3N3w7ZyZA=="});

    HeaderProvider? apiKey = check createHeaderProvider(<ApiKeyAuthentication>{api_key: "Bot abc"}, directory, HEADER_LOCATION);
    test:assertEquals(check (<HeaderProvider>apiKey).getHeaders(), {"Authorization": "Bot abc"});

    HeaderProvider? custom = check createHeaderProvider(<ApiKeyAuthentication>{api_key: "k", header_name: "X-API-Key"},
        directory, HEADER_LOCATION);
    test:assertEquals(check (<HeaderProvider>custom).getHeaders(), {"X-API-Key": "k"});

    test:assertTrue((check createHeaderProvider((), directory, HEADER_LOCATION)) is ());
}

@test:Config
function testAFreshJwtIsSignedForEveryCallOfTheProvider() returns error? {
    string directory = check resourcesDirectory();
    HeaderProvider? provider = check createHeaderProvider(<JwtAuthentication>{issuer: "i", audience: "a",
        signing_key: HMAC_SECRETS.get("HS256"), algorithm: "HS256"}, directory, HEADER_LOCATION);

    map<string> headers = check (<HeaderProvider>provider).getHeaders();
    string token = headers.get("Authorization").substring("Bearer ".length());
    test:assertTrue(check verifyJwt(token, "HS256", HMAC_SECRETS.get("HS256").toBytes()));
}

@test:Config
function testCredentialsTheHttpClientCannotEncodeAreReported() returns error? {
    string directory = check resourcesDirectory();
    string expected = "token cannot be sent: it contains characters the HTTP client cannot encode in a header";

    HeaderProvider|error? bearer = createHeaderProvider(<BearerAuthentication>{token: "tökén-ключ"}, directory, HEADER_LOCATION);
    test:assertTrue(bearer is error);
    test:assertEquals((<error>bearer).message(), HEADER_LOCATION + ": " + expected);

    HeaderProvider|error? apiKey = createHeaderProvider(<ApiKeyAuthentication>{api_key: "ключ"}, directory, HEADER_LOCATION);
    test:assertEquals((<error>apiKey).message(),
        HEADER_LOCATION + ": api_key cannot be sent: it contains characters the HTTP client cannot encode in a header");

    http:ClientAuthConfig|error? mcp = mcpClientAuth(<BearerAuthentication>{token: "ключ"}, directory, MCP_LOCATION);
    test:assertEquals((<error>mcp).message(), MCP_LOCATION + ": " + expected);
}

@test:Config
function testLatin1CredentialsAreSentFaithfully() returns error? {
    CapturedSubscription request = check subscribeWith("        type: api-key\n        api_key: \"clé\"\n        header_name: X-API-Key", 29609);
    test:assertEquals(request.apiKey, "clé");
}

@test:Config
function testAnAccessTokenTheHttpClientCannotEncodeIsRejected() returns error? {
    useTokenReplies({body: {access_token: "tökén-ключ", token_type: "Bearer"}});
    string|error result = (check newProvider(clientCredentials())).getToken();
    test:assertEquals((<error>result).message(), "token response has no valid access_token");
}
