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
import ballerina/lang.array;
import ballerina/lang.runtime;
import ballerina/test;
import ballerina/url;

const TOKEN_URL = "http://localhost:9294/oauth/token";
const OAUTH2_SECRET = "S3CR3T-VALUE";

type CapturedTokenRequest record {|
    string authorization;
    string contentType;
    string accept;
    string body;
|};

type TokenReply record {|
    int status = 200;
    json|string body = {};
    map<string> headers = {};
    decimal delay = 0;
|};

CapturedTokenRequest[] tokenRequests = [];
TokenReply[] tokenReplies = [];
int redirectTargetHits = 0;

service /oauth on new http:Listener(9294) {
    resource function post token(http:Request request) returns http:Response|error {
        tokenRequests.push({
            authorization: request.getHeader("Authorization") is string ? check request.getHeader("Authorization") : "",
            contentType: request.getHeader("Content-Type") is string ? check request.getHeader("Content-Type") : "",
            accept: request.getHeader("Accept") is string ? check request.getHeader("Accept") : "",
            body: check request.getTextPayload()
        });

        TokenReply reply = tokenReplies.length() > 1 ? tokenReplies.remove(0) : tokenReplies[0];
        if reply.delay > 0d {
            runtime:sleep(reply.delay);
        }
        http:Response response = new;
        response.statusCode = reply.status;
        json|string body = reply.body;
        if body is string {
            response.setTextPayload(body);
        } else {
            response.setJsonPayload(body);
        }
        foreach [string, string] [name, value] in reply.headers.entries() {
            response.setHeader(name, value);
        }
        return response;
    }

    resource function post elsewhere() returns http:Ok {
        redirectTargetHits += 1;
        return {};
    }
}

isolated decimal fakeMonotonic = 1000;

isolated function monotonicClock() returns decimal {
    lock {
        return fakeMonotonic;
    }
}

function advanceClock(decimal seconds) {
    lock {
        fakeMonotonic += seconds;
    }
}

function useTokenReplies(TokenReply... replies) {
    tokenRequests = [];
    tokenReplies = [...replies];
    redirectTargetHits = 0;
    lock {
        fakeMonotonic = 1000;
    }
}

function tokenReply(string accessToken = "access-1", json... extra) returns TokenReply {
    map<json> body = {access_token: accessToken, token_type: "Bearer"};
    foreach json member in extra {
        map<json> members = <map<json>>member;
        foreach [string, json] [name, value] in members.entries() {
            body[name] = value;
        }
    }
    return {body};
}

function clientCredentials() returns OAuth2Authentication =>
    {grant_type: CLIENT_CREDENTIALS, token_url: TOKEN_URL, client_id: "client", client_secret: "secret"};

function newProvider(OAuth2Authentication auth, JwtSigner? signer = ()) returns OAuth2TokenProvider|error =>
    new (auth, signer, monotonicClock);

function parseForm(string body) returns map<string>|error {
    map<string> fields = {};
    foreach string pair in re `&`.split(body) {
        int? separator = pair.indexOf("=");
        string name = check url:decode(separator is int ? pair.substring(0, separator) : pair, "UTF-8");
        fields[name] = separator is int ? check url:decode(pair.substring(separator + 1), "UTF-8") : "";
    }
    return fields;
}

function lastForm() returns map<string>|error => parseForm(tokenRequests[tokenRequests.length() - 1].body);

@test:Config
function testBasicClientAuthenticationFormEncodesTheCredentials() returns error? {
    useTokenReplies(tokenReply());
    OAuth2Authentication auth = clientCredentials();
    auth.client_id = "a:b+c%d&e f é~*";
    auth.client_secret = "s:e+c%r&t f ü";

    test:assertEquals(check (check newProvider(auth)).getToken(), "access-1");

    CapturedTokenRequest request = tokenRequests[0];
    string expected = array:toBase64("a%3Ab%2Bc%25d%26e+f+%C3%A9%7E*:s%3Ae%2Bc%25r%26t+f+%C3%BC".toBytes());
    test:assertEquals(request.authorization, "Basic " + expected);
    test:assertEquals(request.contentType, "application/x-www-form-urlencoded");
    test:assertEquals(request.accept, "application/json");
    test:assertEquals(request.body, "grant_type=client_credentials");
}

@test:Config
function testPostClientAuthenticationSendsTheCredentialsInTheBody() returns error? {
    useTokenReplies(tokenReply());
    OAuth2Authentication auth = clientCredentials();
    auth.token_endpoint_auth_method = "client_secret_post";
    auth.client_id = "a b";
    auth.client_secret = "p&q";

    _ = check (check newProvider(auth)).getToken();

    test:assertEquals(tokenRequests[0].authorization, "");
    test:assertEquals(check lastForm(), {grant_type: "client_credentials", client_id: "a b", client_secret: "p&q"});
}

@test:Config
function testScopesResourceAndExtraParameters() returns error? {
    useTokenReplies(tokenReply());
    OAuth2Authentication auth = clientCredentials();
    auth.scopes = ["read", "write:all"];
    auth.'resource = "https://mcp.example.com/mcp";
    auth.extra_params = {tenant: "t 1", audience: "api"};

    _ = check (check newProvider(auth)).getToken();

    test:assertTrue(tokenRequests[0].body.startsWith("grant_type=client_credentials&scope=read+write%3Aall&"));
    test:assertEquals(check lastForm(), {grant_type: "client_credentials", scope: "read write:all",
        'resource: "https://mcp.example.com/mcp", tenant: "t 1", audience: "api"});
}

@test:Config
function testEmptyScopesAreOmitted() returns error? {
    useTokenReplies(tokenReply());
    OAuth2Authentication auth = clientCredentials();
    auth.scopes = [];
    _ = check (check newProvider(auth)).getToken();
    test:assertEquals(check lastForm(), {grant_type: "client_credentials"});
}

@test:Config
function testFormEncode() returns error? {
    test:assertEquals(check formEncode("a b~*-._:+%&é"), "a+b%7E*-._%3A%2B%25%26%C3%A9");
}

@test:Config
function testATokenIsReusedUntilNearExpiryThenRenewedOnce() returns error? {
    useTokenReplies(tokenReply("t1", {expires_in: 1000}), tokenReply("t2", {expires_in: 1000}));
    OAuth2TokenProvider provider = check newProvider(clientCredentials());

    foreach int _ in 0 ..< 3 {
        test:assertEquals(check provider.getToken(), "t1");
    }
    test:assertEquals(tokenRequests.length(), 1);

    advanceClock(939);
    test:assertEquals(check provider.getToken(), "t1");
    advanceClock(2);
    test:assertEquals(check provider.getToken(), "t2");
    test:assertEquals(check provider.getToken(), "t2");
    test:assertEquals(tokenRequests.length(), 2);
}

@test:Config
function testAnAbsentExpiresInMeans3600Seconds() returns error? {
    useTokenReplies(tokenReply("t1"), tokenReply("t2"));
    OAuth2TokenProvider provider = check newProvider(clientCredentials());

    _ = check provider.getToken();
    advanceClock(3539);
    test:assertEquals(check provider.getToken(), "t1");
    advanceClock(2);
    test:assertEquals(check provider.getToken(), "t2");
    test:assertEquals(tokenRequests.length(), 2);
}

@test:Config
function testAShortLivedTokenIsNotRefetchedOnEveryRequest() returns error? {
    useTokenReplies(tokenReply("t1", {expires_in: 30}), tokenReply("t2"));
    OAuth2TokenProvider provider = check newProvider(clientCredentials());

    _ = check provider.getToken();
    advanceClock(20);
    test:assertEquals(check provider.getToken(), "t1");
    advanceClock(8);
    test:assertEquals(check provider.getToken(), "t2");
}

@test:Config
function testANumericStringExpiresInIsAccepted() returns error? {
    useTokenReplies(tokenReply("t1", {expires_in: "3599"}));
    test:assertEquals(check (check newProvider(clientCredentials())).getToken(), "t1");
}

@test:Config
function testAPresentButInvalidExpiresInIsAnError() returns error? {
    json[] invalid = [(), "abc", 0, -5, "0", true, [], "nan", {}];
    foreach json expiresIn in invalid {
        useTokenReplies(tokenReply("t1", {expires_in: expiresIn}));
        string|error result = (check newProvider(clientCredentials())).getToken();
        test:assertTrue(result is error, expiresIn.toString());
        test:assertEquals((<error>result).message(), "token response has an invalid expires_in");
    }
}

@test:Config
function testTokenTypeIsCaseInsensitive() returns error? {
    foreach string tokenType in ["bearer", "BEARER", "Bearer"] {
        useTokenReplies({body: {access_token: "t", token_type: tokenType}});
        test:assertEquals(check (check newProvider(clientCredentials())).getToken(), "t");
    }
}

@test:Config
function testOtherOrMissingTokenTypesAreRejected() returns error? {
    json[] bodies = [
        {access_token: "t", token_type: "DPoP"},
        {access_token: "t", token_type: "mac"},
        {access_token: "t", token_type: ""},
        {access_token: "t", token_type: ()},
        {access_token: "t", token_type: 5},
        {access_token: "t"}
    ];
    foreach json body in bodies {
        useTokenReplies({body});
        string|error result = (check newProvider(clientCredentials())).getToken();
        test:assertTrue(result is error, body.toString());
        test:assertEquals((<error>result).message(), "token response token_type is not Bearer");
    }
}

@test:Config
function testTokenTypeIsCheckedOnEveryResponseIncludingRenewals() returns error? {
    useTokenReplies(tokenReply("t1", {expires_in: 100}), {body: {access_token: "t2", token_type: "mac", expires_in: 100}});
    OAuth2TokenProvider provider = check newProvider(clientCredentials());

    _ = check provider.getToken();
    advanceClock(100);
    string|error renewed = provider.getToken();
    test:assertTrue(renewed is error);
    test:assertEquals((<error>renewed).message(), "token response token_type is not Bearer");
}

@test:Config
function testAnInvalidAccessTokenIsRejected() returns error? {
    json[] bodies = [
        {access_token: (), token_type: "Bearer"},
        {access_token: "", token_type: "Bearer"},
        {access_token: 5, token_type: "Bearer"},
        {access_token: ["t"], token_type: "Bearer"},
        {access_token: "a\r\nb", token_type: "Bearer"},
        {token_type: "Bearer"}
    ];
    foreach json body in bodies {
        useTokenReplies({body});
        string|error result = (check newProvider(clientCredentials())).getToken();
        test:assertTrue(result is error, body.toString());
        test:assertEquals((<error>result).message(), "token response has no valid access_token");
    }
}

@test:Config
function testAMalformedTokenResponseIsAnError() returns error? {
    useTokenReplies({body: "not json"});
    string|error notJson = (check newProvider(clientCredentials())).getToken();
    test:assertEquals((<error>notJson).message(), "token response is not valid JSON");

    useTokenReplies({body: ["a"]});
    string|error notObject = (check newProvider(clientCredentials())).getToken();
    test:assertEquals((<error>notObject).message(), "token response is not a JSON object");
}

@test:Config
function testAnUnexpectedRefreshTokenIsIgnored() returns error? {
    useTokenReplies(tokenReply("t1", {refresh_token: "r", scope: "x", extra: [1]}));
    test:assertEquals(check (check newProvider(clientCredentials())).getToken(), "t1");
}

@test:Config
function testConcurrentRequestsFetchASingleToken() returns error? {
    useTokenReplies({body: {access_token: "t1", token_type: "Bearer"}, delay: 0.3});
    OAuth2TokenProvider provider = check newProvider(clientCredentials());

    future<string|error>[] futures = [];
    foreach int _ in 0 ..< 5 {
        future<string|error> pending = start provider.getToken();
        futures.push(pending);
    }
    foreach future<string|error> pending in futures {
        string|error token = wait pending;
        test:assertEquals(check token, "t1");
    }
    test:assertEquals(tokenRequests.length(), 1);
}

@test:Config
function testConcurrentRequestsRenewAnExpiredTokenOnce() returns error? {
    useTokenReplies({body: {access_token: "t1", token_type: "Bearer", expires_in: 100}},
        {body: {access_token: "t2", token_type: "Bearer"}, delay: 0.3});
    OAuth2TokenProvider provider = check newProvider(clientCredentials());
    _ = check provider.getToken();
    advanceClock(100);

    future<string|error>[] futures = [];
    foreach int _ in 0 ..< 5 {
        future<string|error> pending = start provider.getToken();
        futures.push(pending);
    }
    foreach future<string|error> pending in futures {
        string|error token = wait pending;
        test:assertEquals(check token, "t2");
    }
    test:assertEquals(tokenRequests.length(), 2);
}

@test:Config
function testErrorResponsesReportOnlyTheStatusAndTheRfcErrorCode() returns error? {
    useTokenReplies({status: 401, body: {"error": "invalid_client", error_description: OAUTH2_SECRET + " rejected"}});
    string|error result = (check newProvider(clientCredentials())).getToken();
    test:assertEquals((<error>result).message(), "token request failed (HTTP 401, error invalid_client)");
}

@test:Config
function testResponseBodiesNeverReachTheMessage() returns error? {
    TokenReply[] replies = [
        {status: 500, body: OAUTH2_SECRET + " internal error"},
        {status: 400, body: {"error": OAUTH2_SECRET}},
        {status: 400, body: {"error": ["x"]}},
        {status: 400, body: [OAUTH2_SECRET]}
    ];
    foreach TokenReply reply in replies {
        useTokenReplies(reply);
        string|error result = (check newProvider(clientCredentials())).getToken();
        test:assertTrue(result is error);
        string message = (<error>result).message();
        test:assertFalse(message.includes(OAUTH2_SECRET), message);
        test:assertTrue(message.startsWith("token request failed (HTTP "), message);
    }
}

@test:Config
function testTransportErrorsDoNotLeakLibraryText() returns error? {
    OAuth2Authentication auth = clientCredentials();
    auth.token_url = "http://localhost:9/token";
    auth.client_id = OAUTH2_SECRET;
    auth.client_secret = OAUTH2_SECRET;
    string|error result = (check newProvider(auth)).getToken();
    test:assertEquals((<error>result).message(), "token request failed");
}

@test:Config
function testARedirectIsAnErrorAndIsNotFollowed() returns error? {
    foreach int status in [301, 302, 303, 307, 308] {
        useTokenReplies({status, headers: {"Location": "http://localhost:9294/oauth/elsewhere"}});
        string|error result = (check newProvider(clientCredentials())).getToken();
        test:assertEquals((<error>result).message(),
            string `token endpoint answered with a redirect (HTTP ${status}); redirects are not followed`);
        test:assertEquals(tokenRequests.length(), 1);
        test:assertEquals(redirectTargetHits, 0);
    }
}

function assertionSigning(JwtSigning signing) returns AssertionSigning {
    JwtSigning {subject, ...others} = signing;
    return {...others, subject: subject ?: "service-account"};
}

function assertionSigner(JwtSigning signing) returns JwtSigner|error => new (assertionSigning(signing), check keysDirectory());

function jwtBearer(JwtSigning signing) returns OAuth2Authentication =>
    {grant_type: JWT_BEARER, token_url: TOKEN_URL, client_id: "client", client_secret: "secret", assertion_signing: assertionSigning(signing)};

function assertionOf(int index) returns string|error {
    map<string> form = check parseForm(tokenRequests[index].body);
    return form.get("assertion");
}

@test:Config
function testTheAssertionIsSignedAndSentWithTheGrant() returns error? {
    useTokenReplies(tokenReply());
    JwtSigning signing = rsaSigning("RS256");
    signing.audience = "https://aud.example.com/";
    _ = check (check newProvider(jwtBearer(signing), check assertionSigner(signing))).getToken();

    map<string> form = check lastForm();
    test:assertEquals(form.keys().sort(), ["assertion", "grant_type"]);
    test:assertEquals(form["grant_type"], JWT_BEARER);
    test:assertTrue(tokenRequests[0].authorization.startsWith("Basic "));

    string assertion = check assertionOf(0);
    test:assertTrue(check verifyJwt(assertion, "RS256", check publicKey("rsa-2048-cert.pem")));
    test:assertFalse(check verifyJwt(assertion, "RS256", check publicKey("rsa-2048-other-cert.pem")));
    test:assertEquals(check jsonPart(assertion, 0), {alg: "RS256", typ: "JWT"});
    map<json> claims = check jsonPart(assertion, 1);
    test:assertEquals(claims.keys().sort(), ["aud", "exp", "iat", "iss", "jti", "sub"]);
    test:assertEquals(claims["iss"], "my-issuer");
    test:assertEquals(claims["sub"], "service-account");
    test:assertEquals(claims["aud"], "https://aud.example.com/");
    int issuedAt = check claims["iat"].ensureType();
    test:assertEquals(claims["exp"], issuedAt + 300);
}

@test:Config
function testTheAudienceIsNotDerivedFromTheTokenUrlOrTheResource() returns error? {
    useTokenReplies(tokenReply());
    JwtSigning signing = hmacSigning("HS256");
    signing.audience = "https://aud.example.com/";
    OAuth2Authentication auth = jwtBearer(signing);
    auth.'resource = "https://resource.example.com";
    _ = check (check newProvider(auth, check assertionSigner(signing))).getToken();

    test:assertEquals((check jsonPart(check assertionOf(0), 1))["aud"], "https://aud.example.com/");
    test:assertEquals((check lastForm())["resource"], "https://resource.example.com");
}

@test:Config
function testSubjectKeyIdAndCustomClaims() returns error? {
    useTokenReplies(tokenReply());
    JwtSigning signing = hmacSigning("HS256");
    signing.subject = "svc";
    signing.key_id = "k1";
    signing.audience = ["a", "b"];
    signing.custom_claims = {scope: "api:read"};
    signing.expiry_seconds = 60;
    _ = check (check newProvider(jwtBearer(signing), check assertionSigner(signing))).getToken();

    string assertion = check assertionOf(0);
    test:assertEquals(check jsonPart(assertion, 0), {alg: "HS256", typ: "JWT", kid: "k1"});
    map<json> claims = check jsonPart(assertion, 1);
    test:assertEquals(claims["sub"], "svc");
    test:assertEquals(claims["scope"], "api:read");
    test:assertEquals(claims["aud"], ["a", "b"]);
    test:assertFalse(claims.hasKey("nbf"));
    int issuedAt = check claims["iat"].ensureType();
    test:assertEquals(claims["exp"], issuedAt + 60);
}

@test:Config
function testEveryTokenRequestSignsANewAssertion() returns error? {
    useTokenReplies(tokenReply("t1", {expires_in: 100}), tokenReply("t2"));
    JwtSigning signing = hmacSigning("HS256");
    OAuth2TokenProvider provider = check newProvider(jwtBearer(signing), check assertionSigner(signing));

    _ = check provider.getToken();
    advanceClock(100);
    _ = check provider.getToken();

    test:assertEquals(tokenRequests.length(), 2);
    test:assertNotEquals((check jsonPart(check assertionOf(0), 1))["jti"], (check jsonPart(check assertionOf(1), 1))["jti"]);
}

@test:Config
function testPostClientAuthenticationWithTheJwtBearerGrant() returns error? {
    useTokenReplies(tokenReply());
    JwtSigning signing = hmacSigning("HS256");
    OAuth2Authentication auth = jwtBearer(signing);
    auth.token_endpoint_auth_method = "client_secret_post";
    _ = check (check newProvider(auth, check assertionSigner(signing))).getToken();

    test:assertEquals(tokenRequests[0].authorization, "");
    map<string> form = check lastForm();
    test:assertEquals(form["client_id"], "client");
    test:assertEquals(form["client_secret"], "secret");
}

@test:Config
function testNoClientAuthenticationSendsNeitherSecretNorBasicHeader() returns error? {
    useTokenReplies(tokenReply());
    JwtSigning signing = hmacSigning("HS256");
    OAuth2Authentication withoutClient = {grant_type: JWT_BEARER, token_url: TOKEN_URL,
        token_endpoint_auth_method: "none", assertion_signing: assertionSigning(signing)};
    _ = check (check newProvider(withoutClient, check assertionSigner(signing))).getToken();

    test:assertEquals(tokenRequests[0].authorization, "");
    test:assertEquals((check lastForm()).keys().sort(), ["assertion", "grant_type"]);

    useTokenReplies(tokenReply());
    OAuth2Authentication withClientId = withoutClient.clone();
    withClientId.client_id = "client";
    _ = check (check newProvider(withClientId, check assertionSigner(signing))).getToken();

    test:assertEquals(tokenRequests[0].authorization, "");
    map<string> form = check lastForm();
    test:assertEquals(form["client_id"], "client");
    test:assertFalse(form.hasKey("client_secret"));
}

@test:Config
function testAssertionKeyErrorsAreReportedWhenTheProviderIsBuilt() returns error? {
    JwtSigning signing = rsaSigning("RS256", "rsa-2047.pem");
    OAuth2Authentication auth = jwtBearer(signing);
    HeaderProvider|error? provider = createHeaderProvider(auth, check keysDirectory(), "interfaces[0].subscription.authentication");
    test:assertTrue(provider is error);
    test:assertEquals((<error>provider).message(), "signing_key RSA key must be at least 2048 bits");
}
