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
import ballerina/lang.runtime;
import ballerina/test;

type CapturedSubscription record {|
    string authorization;
    string apiKey;
    string body;
|};

CapturedSubscription[] subscriptions_requests = [];

service /hub on new http:Listener(9295) {
    resource function post .(http:Request request) returns http:Accepted|error {
        subscriptions_requests.push({
            authorization: request.getHeader("Authorization") is string ? check request.getHeader("Authorization") : "",
            apiKey: request.getHeader("X-API-Key") is string ? check request.getHeader("X-API-Key") : "",
            body: check request.getTextPayload()
        });
        return http:ACCEPTED;
    }
}

function webhookAfm(string authentication) returns string {
    string authenticationBlock = authentication == "" ? "" : "      authentication:\n" + authentication + "\n";
    return string `---
interfaces:
  - type: webhook
    subscription:
      protocol: "websub"
      hub: "http://localhost:9295/hub"
      topic: "http://localhost:9295/events/orders"
${authenticationBlock}model:
  provider: "wso2"
  url: "http://localhost:9192/ballerina-copilot/v2.0/webhook"
  authentication:
    type: "bearer"
    token: "mock-token"
---
# Role
You handle webhook events.

# Instructions
Summarize the event.
`;
}

function subscribeWith(string authentication, int port) returns CapturedSubscription|error {
    subscriptions_requests = [];
    AFMRecord afm = check parseAfm(webhookAfm(authentication));
    string directory = check resourcesDirectory();
    future<error?> started = start runAgentFromAFM(afm, port, directory);
    error? result = wait started;
    if result is error {
        return result;
    }

    int waited = 0;
    while subscriptions_requests.length() == 0 && waited < 100 {
        runtime:sleep(0.1);
        waited += 1;
    }
    if subscriptions_requests.length() == 0 {
        return error("the hub received no subscribe request");
    }
    return subscriptions_requests[0];
}

@test:Config
function testNoAuthenticationAddsNoHeaders() returns error? {
    CapturedSubscription request = check subscribeWith("", 29601);
    test:assertEquals(request.authorization, "");
    test:assertEquals(request.apiKey, "");
}

@test:Config
function testBearerIsSentOnTheSubscribeRequest() returns error? {
    CapturedSubscription request = check subscribeWith("        type: bearer\n        token: hub-token", 29602);
    test:assertEquals(request.authorization, "Bearer hub-token");
    test:assertTrue(request.body.includes("hub.mode=subscribe"));
}

@test:Config
function testApiKeyIsSentInTheConfiguredHeader() returns error? {
    CapturedSubscription request = check subscribeWith("        type: api-key\n        api_key: key-123\n        header_name: X-API-Key", 29603);
    test:assertEquals(request.apiKey, "key-123");
    test:assertEquals(request.authorization, "");
}

@test:Config
function testApiKeyDefaultsToTheAuthorizationHeaderAsARawValue() returns error? {
    CapturedSubscription request = check subscribeWith("        type: api-key\n        api_key: \"Bot abc\"", 29604);
    test:assertEquals(request.authorization, "Bot abc");
}

@test:Config
function testJwtIsSignedForTheSubscribeRequest() returns error? {
    string secret = HMAC_SECRETS.get("HS256");
    CapturedSubscription request = check subscribeWith(
        string `        type: jwt${"\n"}        issuer: hub-client${"\n"}        audience: the-hub${"\n"}        signing_key: "${secret}"${"\n"}        algorithm: HS256`, 29605);

    test:assertTrue(request.authorization.startsWith("Bearer "));
    string token = request.authorization.substring("Bearer ".length());
    test:assertTrue(check verifyJwt(token, "HS256", secret.toBytes()));
    map<json> claims = check jsonPart(token, 1);
    test:assertEquals(claims["iss"], "hub-client");
    test:assertEquals(claims["aud"], "the-hub");
    test:assertFalse(claims.hasKey("nbf"));
}

@test:Config
function testOAuth2TokenIsRequestedAndSentOnTheSubscribeRequest() returns error? {
    useTokenReplies(tokenReply("hub-access-token"));
    CapturedSubscription request = check subscribeWith(
        string `        type: oauth2${"\n"}        grant_type: client_credentials${"\n"}        token_url: "${TOKEN_URL}"${"\n"}        client_id: client${"\n"}        client_secret: secret${"\n"}        scopes: [hub]`, 29606);

    test:assertEquals(request.authorization, "Bearer hub-access-token");
    test:assertEquals(tokenRequests.length(), 1);
    test:assertEquals((check lastForm())["scope"], "hub");
}

@test:Config
function testAnInvalidTokenResponseStopsTheStartWithoutASubscription() returns error? {
    useTokenReplies({body: {access_token: "t", token_type: "mac"}});
    CapturedSubscription|error result = subscribeWith(
        string `        type: oauth2${"\n"}        grant_type: client_credentials${"\n"}        token_url: "${TOKEN_URL}"${"\n"}        client_id: client${"\n"}        client_secret: secret`, 29607);

    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(), "token response token_type is not Bearer");
    test:assertEquals(subscriptions_requests.length(), 0);
}

@test:Config
function testAnUnusableSigningKeyStopsTheStartWithoutASubscription() returns error? {
    CapturedSubscription|error result = subscribeWith(
        string `        type: jwt${"\n"}        issuer: i${"\n"}        audience: a${"\n"}        signing_key: keys/rsa-2047.pem`, 29608);

    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(), "signing_key RSA key must be at least 2048 bits");
    test:assertEquals(subscriptions_requests.length(), 0);
}
