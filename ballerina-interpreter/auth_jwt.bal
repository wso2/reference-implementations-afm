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

import ballerina/crypto;
import ballerina/file;
import ballerina/io;
import ballerina/lang.array;
import ballerina/time;
import ballerina/uuid;

const MIN_RSA_KEY_BITS = 2048;

isolated class JwtSigner {
    private final readonly & JwtSigning signing;
    private final byte[]|crypto:PrivateKey key;
    private final (isolated function () returns int)? clock;

    isolated function init(JwtSigning signing, string afmFileDir, (isolated function () returns int)? clock = ())
            returns error? {
        self.signing = signing.cloneReadOnly();
        self.key = check loadSigningKey(self.signing, afmFileDir);
        self.clock = clock;
    }

    isolated function sign(boolean withJti = false) returns string|error {
        (isolated function () returns int)? clock = self.clock;
        int issuedAt = clock is () ? time:utcNow()[0] : clock();

        map<json> header = {alg: self.signing.algorithm, typ: "JWT"};
        string? keyId = self.signing?.key_id;
        if keyId is string {
            header["kid"] = keyId;
        }

        map<json> claims = {...(self.signing?.custom_claims ?: {})};
        claims["iss"] = self.signing.issuer;
        claims["aud"] = self.signing.audience;
        claims["iat"] = issuedAt;
        int|error expiresAt = trap issuedAt + self.signing.expiry_seconds;
        if expiresAt is error {
            return error("expiry_seconds is too large");
        }
        claims["exp"] = expiresAt;
        string? subject = self.signing?.subject;
        if subject is string {
            claims["sub"] = subject;
        }
        if withJti {
            claims["jti"] = uuid:createRandomUuid();
        }

        string signingInput = base64Url(header.toJsonString().toBytes()) + "." + base64Url(claims.toJsonString().toBytes());
        lock {
            byte[] signature = check signJwtInput(signingInput.toBytes(), self.signing.algorithm, self.key);
            return signingInput + "." + base64Url(signature);
        }
    }
}

isolated function signJwtInput(byte[] input, JwtAlgorithm algorithm, byte[]|crypto:PrivateKey key) returns byte[]|error {
    if key is byte[] {
        match algorithm {
            "HS256" => {
                return crypto:hmacSha256(input, key);
            }
            "HS384" => {
                return crypto:hmacSha384(input, key);
            }
            _ => {
                return crypto:hmacSha512(input, key);
            }
        }
    }
    match algorithm {
        "RS256" => {
            return crypto:signRsaSha256(input, key);
        }
        "RS384" => {
            return crypto:signRsaSha384(input, key);
        }
        _ => {
            return crypto:signRsaSha512(input, key);
        }
    }
}

isolated function base64Url(byte[] data) returns string {
    string encoded = array:toBase64(data);
    string result = "";
    foreach string character in encoded {
        match character {
            "+" => {
                result += "-";
            }
            "/" => {
                result += "_";
            }
            "=" => {
            }
            _ => {
                result += character;
            }
        }
    }
    return result;
}

isolated function signingKeyPath(JwtSigning signing, string afmFileDir) returns string|error {
    boolean|error absolute = file:isAbsolutePath(signing.signing_key);
    return absolute is true ? signing.signing_key : file:joinPath(afmFileDir, signing.signing_key);
}

isolated function loadSigningKey(JwtSigning signing, string afmFileDir) returns byte[]|crypto:PrivateKey|error {
    if signing.algorithm.startsWith("HS") {
        return signing.signing_key.toBytes();
    }

    string path = check signingKeyPath(signing, afmFileDir);
    string|error pem = io:fileReadString(path);
    if pem is error {
        return error("signing_key file cannot be read");
    }
    if pem.includes("ENCRYPTED") {
        return error("signing_key file is encrypted; only unencrypted PEM keys are supported");
    }

    int|error bits = rsaModulusBits(pem);
    if bits is error {
        return error("signing_key file must contain an unencrypted RSA PEM private key");
    }
    if bits < MIN_RSA_KEY_BITS {
        return error(string `signing_key RSA key must be at least ${MIN_RSA_KEY_BITS} bits`);
    }

    crypto:PrivateKey|error key = crypto:decodeRsaPrivateKeyFromKeyFile(path);
    if key is error {
        return error("signing_key file must contain an unencrypted RSA PEM private key");
    }
    return key;
}

isolated function rsaModulusBits(string pem) returns int|error {
    boolean pkcs8 = pem.includes("-----BEGIN PRIVATE KEY-----");
    if !pkcs8 && !pem.includes("-----BEGIN RSA PRIVATE KEY-----") {
        return error("not an RSA private key");
    }

    string encoded = "";
    foreach string line in re `\r?\n`.split(pem) {
        string trimmed = line.trim();
        if trimmed != "" && !trimmed.startsWith("-----") {
            encoded += trimmed;
        }
    }
    byte[] der = check array:fromBase64(encoded);
    return pkcs8 ? check modulusBitsOfPkcs8(der) : check modulusBitsOfPkcs1(der);
}

isolated function modulusBitsOfPkcs8(byte[] der) returns int|error {
    var [_, position, _] = check readDerElement(der, 0, 0x30);
    var [_, versionEnd, versionLength] = check readDerElement(der, position, 0x02);
    var [_, algorithmEnd, algorithmLength] = check readDerElement(der, versionEnd + versionLength, 0x30);
    var [keyStart, keyLength] = check readDerContent(der, algorithmEnd + algorithmLength, 0x04);
    return modulusBitsOfPkcs1(der.slice(keyStart, keyStart + keyLength));
}

isolated function modulusBitsOfPkcs1(byte[] der) returns int|error {
    var [_, position, _] = check readDerElement(der, 0, 0x30);
    var [_, versionEnd, versionLength] = check readDerElement(der, position, 0x02);
    var [modulusStart, modulusLength] = check readDerContent(der, versionEnd + versionLength, 0x02);

    int first = modulusStart;
    int end = modulusStart + modulusLength;
    while first < end && der[first] == 0 {
        first += 1;
    }
    if first == end {
        return error("empty modulus");
    }
    int bits = (end - first - 1) * 8;
    int top = der[first];
    while top > 0 {
        bits += 1;
        top = top >> 1;
    }
    return bits;
}

isolated function readDerContent(byte[] der, int position, int expectedTag) returns [int, int]|error {
    var [_, contentStart, length] = check readDerElement(der, position, expectedTag);
    return [contentStart, length];
}

isolated function readDerElement(byte[] der, int position, int expectedTag) returns [int, int, int]|error {
    if position + 2 > der.length() || der[position] != expectedTag {
        return error("unexpected DER element");
    }
    int contentStart = position + 2;
    int length = der[position + 1];
    if length >= 0x80 {
        int count = length - 0x80;
        if count == 0 || count > 4 || contentStart + count > der.length() {
            return error("unsupported DER length");
        }
        length = 0;
        foreach int index in 0 ..< count {
            length = length * 256 + der[contentStart + index];
        }
        contentStart += count;
    }
    if contentStart + length > der.length() {
        return error("truncated DER element");
    }
    return [expectedTag, contentStart, length];
}
