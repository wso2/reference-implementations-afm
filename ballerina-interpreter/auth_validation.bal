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

const CLIENT_CREDENTIALS = "client_credentials";
const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

final readonly & string[] AUTH_TYPES = ["bearer", "basic", "api-key", "jwt", "oauth2"];
final readonly & string[] JWT_REQUIRED = ["issuer", "audience", "signing_key"];
final readonly & string[] JWT_OPTIONAL = ["algorithm", "key_id", "subject", "custom_claims", "expiry_seconds"];
final readonly & string[] ASSERTION_REQUIRED = [...JWT_REQUIRED, "subject"];
final readonly & string[] RESERVED_CLAIMS = ["iss", "aud", "sub", "iat", "exp", "nbf", "jti"];
final readonly & string[] RESERVED_PARAMS = ["grant_type", "scope", "client_id", "client_secret", "resource",
    "assertion", "username", "password", "refresh_token", "client_assertion", "client_assertion_type"];
final readonly & string[] LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];
final readonly & map<int> HMAC_MIN_KEY_BYTES = {"HS256": 32, "HS384": 48, "HS512": 64};

function validateAuthentication(json raw, string location, boolean forModel = false) returns map<json>|error {
    if raw !is map<json> {
        return error(string `${location}: authentication must be an object`);
    }
    json rawType = raw["type"];
    string authType = rawType is string ? rawType.toLowerAscii() : "";
    if AUTH_TYPES.indexOf(authType) is () {
        return error(string `${location}: 'type' is required and must be one of: ${string:'join(", ", ...AUTH_TYPES)}`);
    }

    string label = string `type '${authType}'`;
    map<json> auth = raw.clone();
    auth["type"] = authType;

    match authType {
        "bearer" => {
            check checkStructure(auth, location, label, ["type", "token"], ["token"]);
            check validateBearer(auth, location, label);
        }
        "basic" => {
            check checkStructure(auth, location, label, ["type", "username", "password"], ["username", "password"]);
            check validateBasic(auth, location, label);
        }
        "api-key" => {
            check checkStructure(auth, location, label, ["type", "api_key", "header_name"], ["api_key"]);
            check validateApiKey(auth, location, label);
        }
        "jwt" => {
            check checkStructure(auth, location, label, ["type", ...JWT_REQUIRED, ...JWT_OPTIONAL], JWT_REQUIRED);
            check validateJwtSigning(auth, location, label);
        }
        _ => {
            check checkStructure(auth, location, label,
                ["type", "grant_type", "token_url", "client_id", "client_secret", "assertion_signing", "scopes",
                "token_endpoint_auth_method", "resource", "extra_params"], ["grant_type", "token_url"]);
            check validateOAuth2(auth, location, label);
        }
    }

    if forModel {
        check checkModelAuthentication(auth, authType, location);
    }
    return auth;
}

function checkModelAuthentication(map<json> auth, string authType, string location) returns error? {
    if authType != "bearer" && authType != "api-key" {
        return error(string `${location}: model authentication must be of type 'bearer' or 'api-key'`);
    }
    if auth.hasKey("header_name") {
        return error(string `${location}: 'header_name' must not be set for model authentication; ` +
            "the model service determines how the credential is sent");
    }
}

function checkStructure(map<json> target, string location, string label, string[] allowed, string[] required)
        returns error? {
    string[] unknown = from string name in target.keys() where allowed.indexOf(name) is () order by name select name;
    if unknown.length() > 0 {
        return error(string `${location}: ${label} does not support field(s): ${string:'join(", ", ...unknown)}`);
    }

    foreach [string, json] [name, value] in target.entries() {
        if value is () {
            return fieldError(location, label, name, "must not be null");
        }
    }

    string[] missing = from string name in required
        where !target.hasKey(name)
        select name;
    if missing.length() > 0 {
        string quoted = string:'join(" and ", ...from string name in missing select string `'${name}'`);
        return error(string `${location}: ${label} requires ${quoted} ${missing.length() == 1 ? "field" : "fields"}`);
    }

    foreach string name in required {
        json value = target.get(name);
        if value == "" || (value is json[] && value.length() == 0) {
            return fieldError(location, label, name, "must not be empty");
        }
    }
}

function fieldError(string location, string label, string fieldName, string problem) returns error =>
    error(string `${location}: ${label}: field '${fieldName}' ${problem}`);

function validateBearer(map<json> auth, string location, string label) returns error? {
    string token = check stringField(auth, "token", location, label);
    if hasControlChars(token) {
        return fieldError(location, label, "token", "must not contain control characters");
    }
    if hasWhitespace(token) {
        return fieldError(location, label, "token", "must not contain whitespace");
    }
}

function validateBasic(map<json> auth, string location, string label) returns error? {
    string username = check stringField(auth, "username", location, label);
    if hasControlChars(username) {
        return fieldError(location, label, "username", "must not contain control characters");
    }
    if username.includes(":") {
        return fieldError(location, label, "username", "must not contain a colon");
    }
    string password = check stringField(auth, "password", location, label);
    if hasControlChars(password) {
        return fieldError(location, label, "password", "must not contain control characters");
    }
}

function validateApiKey(map<json> auth, string location, string label) returns error? {
    string apiKey = check stringField(auth, "api_key", location, label);
    if hasControlChars(apiKey) {
        return fieldError(location, label, "api_key", "must not contain control characters");
    }
    if auth.hasKey("header_name") {
        string headerName = check stringField(auth, "header_name", location, label);
        if !isHeaderName(headerName) {
            return fieldError(location, label, "header_name", "must be a valid HTTP header field name");
        }
    }
}

function validateJwtSigning(map<json> target, string location, string label) returns error? {
    _ = check stringField(target, "issuer", location, label);
    _ = check stringField(target, "signing_key", location, label);

    json audience = target.get("audience");
    if audience is json[] {
        foreach json entry in audience {
            if entry !is string || entry == "" {
                return fieldError(location, label, "audience", "entries must be non-empty strings");
            }
        }
    } else if audience !is string {
        return fieldError(location, label, "audience", "must be a string or an array of strings");
    }

    string algorithm = "RS256";
    if target.hasKey("algorithm") {
        algorithm = check stringField(target, "algorithm", location, label);
        if algorithm != "RS256" && algorithm != "RS384" && algorithm != "RS512"
                && algorithm != "HS256" && algorithm != "HS384" && algorithm != "HS512" {
            return fieldError(location, label, "algorithm", "must be one of RS256, RS384, RS512, HS256, HS384, HS512");
        }
    }
    foreach string name in ["key_id", "subject"] {
        if target.hasKey(name) {
            _ = check stringField(target, name, location, label);
        }
    }

    if target.hasKey("custom_claims") {
        json claims = target.get("custom_claims");
        if claims !is map<json> {
            return fieldError(location, label, "custom_claims", "must be an object");
        }
        string[] reserved = [];
        foreach string name in RESERVED_CLAIMS {
            if claims.hasKey(name) {
                reserved.push(name);
            }
        }
        if reserved.length() > 0 {
            return fieldError(location, label, "custom_claims",
                string `must not contain reserved claims: ${string:'join(", ", ...reserved)}`);
        }
    }

    if target.hasKey("expiry_seconds") {
        int|error seconds = parseExpirySeconds(target.get("expiry_seconds"));
        if seconds is error {
            return fieldError(location, label, "expiry_seconds", seconds.message());
        }
        target["expiry_seconds"] = seconds;
    }

    int? minimum = HMAC_MIN_KEY_BYTES[algorithm];
    if minimum is int && target.get("signing_key").toString().toBytes().length() < minimum {
        return fieldError(location, label, "signing_key", string `must be at least ${minimum} bytes for ${algorithm}`);
    }
}

function parseExpirySeconds(json value) returns int|error {
    int|error seconds = error("must be an integer or a string of digits");
    if value is int {
        seconds = value;
    } else if value is string && isAsciiDigits(value) {
        seconds = int:fromString(value);
    }
    if seconds is error {
        return error("must be an integer or a string of digits");
    }
    if seconds <= 0 {
        return error("must be greater than zero");
    }
    return seconds;
}

function validateOAuth2(map<json> auth, string location, string label) returns error? {
    string grantType = (check stringField(auth, "grant_type", location, label)).toLowerAscii();
    if grantType != CLIENT_CREDENTIALS && grantType != JWT_BEARER {
        return fieldError(location, label, "grant_type", string `must be '${CLIENT_CREDENTIALS}' or '${JWT_BEARER}'`);
    }
    auth["grant_type"] = grantType;

    string tokenUrl = check stringField(auth, "token_url", location, label);
    if !isValidTokenUrl(tokenUrl) {
        return fieldError(location, label, "token_url",
            "must be an absolute https URL (http is allowed only for localhost, 127.0.0.1 or ::1)");
    }

    foreach string name in ["client_id", "client_secret"] {
        if auth.hasKey(name) {
            _ = check stringField(auth, name, location, label);
        }
    }

    if auth.hasKey("scopes") {
        json scopes = auth.get("scopes");
        if scopes !is json[] {
            return fieldError(location, label, "scopes", "must be an array of strings");
        }
        foreach int index in 0 ..< scopes.length() {
            json scope = scopes[index];
            if scope !is string || !isScopeToken(scope) {
                return fieldError(location, label, "scopes", string `entry ${index} is not a valid scope token`);
            }
        }
    }

    string method = "client_secret_basic";
    if auth.hasKey("token_endpoint_auth_method") {
        method = check stringField(auth, "token_endpoint_auth_method", location, label);
        if method != "client_secret_basic" && method != "client_secret_post" && method != "none" {
            return fieldError(location, label, "token_endpoint_auth_method",
                "must be one of client_secret_basic, client_secret_post, none");
        }
    }

    if auth.hasKey("resource") {
        string resourceUri = check stringField(auth, "resource", location, label);
        if !isAbsoluteUri(resourceUri) {
            return fieldError(location, label, "resource", "must be an absolute URI without a fragment");
        }
    }

    if auth.hasKey("extra_params") {
        json params = auth.get("extra_params");
        if params !is map<json> {
            return fieldError(location, label, "extra_params", "must be an object");
        }
        foreach json value in params {
            if value !is string {
                return fieldError(location, label, "extra_params", "values must be strings");
            }
        }
        string[] reserved = [];
        foreach string name in RESERVED_PARAMS {
            if params.hasKey(name) {
                reserved.push(name);
            }
        }
        if reserved.length() > 0 {
            return fieldError(location, label, "extra_params",
                string `must not contain reserved parameters: ${string:'join(", ", ...reserved)}`);
        }
    }

    boolean jwtBearer = grantType == JWT_BEARER;
    if jwtBearer {
        json signing = auth["assertion_signing"];
        if signing is () {
            return error(string `${location}: ${label}: the JWT bearer grant requires 'assertion_signing'`);
        }
        if signing !is map<json> {
            return fieldError(location, label, "assertion_signing", "must be an object");
        }
        map<json> assertion = signing.clone();
        string assertionLabel = string `${label} assertion_signing`;
        check checkStructure(assertion, location, assertionLabel, [...JWT_REQUIRED, ...JWT_OPTIONAL], ASSERTION_REQUIRED);
        check validateJwtSigning(assertion, location, assertionLabel);
        auth["assertion_signing"] = assertion;
    } else if auth.hasKey("assertion_signing") {
        return error(string `${location}: ${label}: 'assertion_signing' is only allowed with the JWT bearer grant`);
    }

    if method == "none" {
        if !jwtBearer {
            return error(string `${location}: ${label}: token_endpoint_auth_method 'none' ` +
                "is only allowed with the JWT bearer grant");
        }
        if auth.hasKey("client_secret") {
            return error(string `${location}: ${label}: 'client_secret' must not be set ` +
                "with token_endpoint_auth_method 'none'");
        }
    } else if auth["client_id"] is () || auth["client_secret"] is () || auth["client_id"] == "" || auth["client_secret"] == "" {
        return error(string `${location}: ${label}: token_endpoint_auth_method '${method}' ` +
            "requires 'client_id' and 'client_secret'");
    }
}

function stringField(map<json> target, string fieldName, string location, string label) returns string|error {
    json value = target[fieldName];
    if value is string {
        return value;
    }
    return fieldError(location, label, fieldName, "must be a string");
}

isolated function isSendableHeaderValue(string value) returns boolean {
    foreach int codePoint in value.toCodePointInts() {
        if codePoint > 0xff {
            return false;
        }
    }
    return true;
}

function checkSendable(string fieldName, string value, string location) returns error? {
    if !isSendableHeaderValue(value) {
        return error(string `${location}: ${fieldName} cannot be sent: it contains characters ` +
            "the HTTP client cannot encode in a header");
    }
}

isolated function hasControlChars(string value) returns boolean {
    foreach int codePoint in value.toCodePointInts() {
        if codePoint < 0x20 || codePoint == 0x7f {
            return true;
        }
    }
    return false;
}

isolated function hasWhitespace(string value) returns boolean {
    foreach int c in value.toCodePointInts() {
        if (c >= 0x09 && c <= 0x0d) || c == 0x20 || c == 0x85 || c == 0xa0 || c == 0x1680
                || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f
                || c == 0x3000 {
            return true;
        }
    }
    return false;
}

isolated function isAsciiDigits(string value) returns boolean {
    if value == "" {
        return false;
    }
    foreach int c in value.toCodePointInts() {
        if c < 0x30 || c > 0x39 {
            return false;
        }
    }
    return true;
}

isolated function isAsciiAlphanumeric(int c) returns boolean =>
    (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

final readonly & int[] HEADER_NAME_PUNCTUATION = [0x21, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2a, 0x2b, 0x2d, 0x2e, 0x5e, 0x5f,
    0x60, 0x7c, 0x7e];

isolated function isHeaderName(string value) returns boolean {
    if value == "" {
        return false;
    }
    foreach int c in value.toCodePointInts() {
        if !isAsciiAlphanumeric(c) && HEADER_NAME_PUNCTUATION.indexOf(c) is () {
            return false;
        }
    }
    return true;
}

isolated function isScopeToken(string value) returns boolean {
    if value == "" {
        return false;
    }
    foreach int c in value.toCodePointInts() {
        if !(c == 0x21 || (c >= 0x23 && c <= 0x5b) || (c >= 0x5d && c <= 0x7e)) {
            return false;
        }
    }
    return true;
}

isolated function isAbsoluteUri(string value) returns boolean {
    int? colon = value.indexOf(":");
    if colon is () || colon == 0 || colon == value.length() - 1 {
        return false;
    }
    if value.includes("#") || hasControlChars(value) || hasWhitespace(value) || hasBadPercentEncoding(value) {
        return false;
    }
    int[] scheme = value.substring(0, colon).toCodePointInts();
    foreach int index in 0 ..< scheme.length() {
        int c = scheme[index];
        boolean letter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
        boolean other = (c >= 0x30 && c <= 0x39) || c == 0x2b || c == 0x2d || c == 0x2e;
        if !(letter || (index > 0 && other)) {
            return false;
        }
    }
    if !value.substring(colon + 1).startsWith("//") {
        return true;
    }
    [string, string]? parts = splitAuthority(value);
    return parts is [string, string] && (!isHttpScheme(parts[0]) || httpLibraryReads(value));
}

isolated function isHttpScheme(string scheme) returns boolean => scheme == "http" || scheme == "https";

isolated function hasBadPercentEncoding(string value) returns boolean {
    foreach int index in 0 ..< value.length() {
        if value.substring(index, index + 1) == "%" &&
                (index + 3 > value.length() || !re `[0-9A-Fa-f]{2}`.isFullMatch(value.substring(index + 1, index + 3))) {
            return true;
        }
    }
    return false;
}

isolated function httpLibraryReads(string url) returns boolean {
    http:Client|error probe = new (url);
    return probe !is error;
}

isolated function splitAuthority(string url) returns [string, string]? {
    int? schemeEnd = url.indexOf("://");
    if schemeEnd is () {
        return ();
    }
    string scheme = url.substring(0, schemeEnd).toLowerAscii();

    string rest = url.substring(schemeEnd + 3);
    int authorityEnd = rest.length();
    foreach string separator in ["/", "?", "#"] {
        int? index = rest.indexOf(separator);
        if index is int && index < authorityEnd {
            authorityEnd = index;
        }
    }
    string authority = rest.substring(0, authorityEnd);
    int? at = authority.lastIndexOf("@");
    string hostPort = at is int ? authority.substring(at + 1) : authority;

    string host;
    string port = "";
    if hostPort.startsWith("[") {
        int? close = hostPort.indexOf("]");
        if close is () {
            return ();
        }
        host = hostPort.substring(1, close);
        string after = hostPort.substring(close + 1);
        if after != "" {
            if !after.startsWith(":") {
                return ();
            }
            port = after.substring(1);
        }
    } else {
        int? colon = hostPort.indexOf(":");
        host = colon is int ? hostPort.substring(0, colon) : hostPort;
        port = colon is int ? hostPort.substring(colon + 1) : "";
    }

    if host == "" {
        return ();
    }
    if port != "" {
        int|error portNumber = isAsciiDigits(port) ? int:fromString(port) : error("invalid port");
        if portNumber is error || portNumber > 65535 {
            return ();
        }
    }
    return [scheme, host];
}

isolated function isValidTokenUrl(string url) returns boolean {
    if hasControlChars(url) || hasWhitespace(url) {
        return false;
    }
    [string, string]? parts = splitAuthority(url);
    if parts is () {
        return false;
    }
    var [scheme, host] = parts;
    return (scheme == "https" || (scheme == "http" && LOOPBACK_HOSTS.indexOf(host.toLowerAscii()) is int))
        && httpLibraryReads(url);
}
