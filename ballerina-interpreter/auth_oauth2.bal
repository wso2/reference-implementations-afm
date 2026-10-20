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
import ballerina/time;
import ballerina/url;

const decimal DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const decimal TOKEN_REFRESH_MARGIN_SECONDS = 60;
const decimal TOKEN_REQUEST_TIMEOUT_SECONDS = 30;

final readonly & string[] TOKEN_ERROR_CODES = ["invalid_request", "invalid_client", "invalid_grant",
    "unauthorized_client", "unsupported_grant_type", "invalid_scope"];

isolated class OAuth2TokenProvider {
    private final readonly & OAuth2Authentication config;
    private final JwtSigner? signer;
    private final http:Client tokenClient;
    private final (isolated function () returns decimal)? clock;
    private final string? defaultResource;
    private string token = "";
    private decimal refreshAt = 0;

    isolated function init(OAuth2Authentication config, JwtSigner? signer, (isolated function () returns decimal)? clock = (),
            string? mcpUrl = ()) returns error? {
        self.config = config.cloneReadOnly();
        self.signer = signer;
        self.clock = clock;
        self.defaultResource = mcpUrl is string ? canonicalResourceUri(mcpUrl) : ();
        http:Client|error created = new (config.token_url, timeout = TOKEN_REQUEST_TIMEOUT_SECONDS);
        if created is error {
            return error("token_url cannot be used by the HTTP client");
        }
        self.tokenClient = created;
    }

    isolated function getToken() returns string|error {
        lock {
            if self.token == "" || self.now() >= self.refreshAt {
                var [accessToken, refreshAt] = check self.fetchToken();
                self.token = accessToken;
                self.refreshAt = refreshAt;
            }
            return self.token;
        }
    }

    isolated function invalidate(string rejectedToken) {
        lock {
            if self.token == rejectedToken {
                self.token = "";
            }
        }
    }

    private isolated function now() returns decimal {
        (isolated function () returns decimal)? clock = self.clock;
        return clock is () ? time:monotonicNow() : clock();
    }

    private isolated function fetchToken() returns [string, decimal]|error {
        http:Request request = new;
        request.setHeader("Accept", "application/json");
        [string, string][] fields = check self.tokenRequestFields(request);

        string[] pairs = [];
        foreach [string, string] [name, value] in fields {
            pairs.push(check formEncode(name) + "=" + check formEncode(value));
        }
        request.setTextPayload(string:'join("&", ...pairs), "application/x-www-form-urlencoded");

        http:Response|error response = self.tokenClient->post("", request);
        if response is error {
            return error("token request failed");
        }

        var [accessToken, lifetime] = check readTokenResponse(response);
        decimal margin = lifetime / 10 < TOKEN_REFRESH_MARGIN_SECONDS ? lifetime / 10 : TOKEN_REFRESH_MARGIN_SECONDS;
        return [accessToken, self.now() + lifetime - margin];
    }

    private isolated function tokenRequestFields(http:Request request) returns [string, string][]|error {
        OAuth2Authentication config = self.config;
        [string, string][] fields = [["grant_type", config.grant_type]];

        JwtSigner? signer = self.signer;
        if signer is JwtSigner {
            fields.push(["assertion", check signer.sign(withJti = true)]);
        }
        string[]? scopes = config?.scopes;
        if scopes is string[] && scopes.length() > 0 {
            fields.push(["scope", string:'join(" ", ...scopes)]);
        }
        string? resourceUri = config?.'resource ?: self.defaultResource;
        if resourceUri is string {
            fields.push(["resource", resourceUri]);
        }
        map<string>? extraParams = config?.extra_params;
        if extraParams is map<string> {
            foreach [string, string] [name, value] in extraParams.entries() {
                fields.push([name, value]);
            }
        }

        string? clientId = config?.client_id;
        string? clientSecret = config?.client_secret;
        match config.token_endpoint_auth_method {
            "client_secret_basic" => {
                if clientId is () || clientSecret is () {
                    return error("client authentication requires client_id and client_secret");
                }
                string credentials = check formEncode(clientId) + ":" + check formEncode(clientSecret);
                request.setHeader("Authorization", "Basic " + array:toBase64(credentials.toBytes()));
            }
            "client_secret_post" => {
                if clientId is () || clientSecret is () {
                    return error("client authentication requires client_id and client_secret");
                }
                fields.push(["client_id", clientId]);
                fields.push(["client_secret", clientSecret]);
            }
            _ => {
                if clientId is string {
                    fields.push(["client_id", clientId]);
                }
            }
        }
        return fields;
    }
}

isolated function canonicalResourceUri(string url) returns string {
    string withoutFragment = url.indexOf("#") is int ? url.substring(0, <int>url.indexOf("#")) : url;
    int? schemeEnd = withoutFragment.indexOf("://");
    if schemeEnd is () {
        return withoutFragment;
    }
    string rest = withoutFragment.substring(schemeEnd + 3);
    int authorityEnd = rest.length();
    foreach string separator in ["/", "?"] {
        int? index = rest.indexOf(separator);
        if index is int && index < authorityEnd {
            authorityEnd = index;
        }
    }
    string authority = rest.substring(0, authorityEnd);
    int hostStart = (authority.lastIndexOf("@") ?: -1) + 1;
    return withoutFragment.substring(0, schemeEnd).toLowerAscii() + "://" + authority.substring(0, hostStart) +
        authority.substring(hostStart).toLowerAscii() + rest.substring(authorityEnd);
}

isolated function formEncode(string value) returns string|error {
    string encoded = check url:encode(value, "UTF-8");
    return re `%20`.replaceAll(re `~`.replaceAll(re `%2A`.replaceAll(encoded, "*"), "%7E"), "+");
}

isolated function readTokenResponse(http:Response response) returns [string, decimal]|error {
    int status = response.statusCode;
    if status >= 300 && status < 400 {
        return error(string `token endpoint answered with a redirect (HTTP ${status}); redirects are not followed`);
    }
    json body = readJsonBody(response);
    if status < 200 || status >= 300 {
        json errorCode = body is map<json> ? body["error"] : ();
        string suffix = errorCode is string && TOKEN_ERROR_CODES.indexOf(errorCode) is int
            ? string `, error ${errorCode}` : "";
        return error(string `token request failed (HTTP ${status}${suffix})`);
    }

    if body is () {
        return error("token response is not valid JSON");
    }
    if body !is map<json> {
        return error("token response is not a JSON object");
    }

    json tokenType = body["token_type"];
    if tokenType !is string || tokenType.toLowerAscii() != "bearer" {
        return error("token response token_type is not Bearer");
    }
    json accessToken = body["access_token"];
    if accessToken !is string || accessToken == "" || hasControlChars(accessToken) || !isSendableHeaderValue(accessToken) {
        return error("token response has no valid access_token");
    }
    return [accessToken, check tokenLifetime(body)];
}

isolated function readJsonBody(http:Response response) returns json {
    byte[]|error payload = response.getBinaryPayload();
    if payload is error {
        return ();
    }
    string|error text = string:fromBytes(payload);
    json|error body = text is string ? text.fromJsonString() : text;
    return body is error ? () : body;
}

isolated function tokenLifetime(map<json> body) returns decimal|error {
    if !body.hasKey("expires_in") {
        return DEFAULT_TOKEN_LIFETIME_SECONDS;
    }
    json value = body.get("expires_in");
    decimal|error lifetime = error("invalid");
    if value is int|float|decimal|string {
        lifetime = decimal:fromString(value.toString());
    }
    if lifetime is error || lifetime <= 0d {
        return error("token response has an invalid expires_in");
    }
    return lifetime;
}
