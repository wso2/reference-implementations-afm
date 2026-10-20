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
import ballerina/io;
import ballerina/lang.array;
import ballerina/test;

final readonly & map<string> HMAC_SECRETS = {
    "HS256": "0123456789abcdef0123456789abcdef",
    "HS384": "0123456789abcdef0123456789abcdef0123456789abcdef",
    "HS512": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
};
final readonly & JwtAlgorithm[] RSA_ALGORITHMS = ["RS256", "RS384", "RS512"];
final readonly & JwtAlgorithm[] HMAC_ALGORITHMS = ["HS256", "HS384", "HS512"];

isolated int fakeNow = 1000;

isolated function fakeClock() returns int {
    lock {
        return fakeNow;
    }
}

function keysDirectory() returns string|error => check resourcesDirectory() + "/keys";

function publicKey(string certificate) returns crypto:PublicKey|error =>
    crypto:decodeRsaPublicKeyFromCertFile(check keysDirectory() + "/" + certificate);

function base64UrlDecode(string value) returns byte[]|error {
    string standard = "";
    foreach string character in value {
        standard += character == "-" ? "+" : character == "_" ? "/" : character;
    }
    while standard.length() % 4 != 0 {
        standard += "=";
    }
    return array:fromBase64(standard);
}

function jsonPart(string token, int index) returns map<json>|error {
    string[] parts = re `\.`.split(token);
    string text = check string:fromBytes(check base64UrlDecode(parts[index]));
    json decoded = check text.fromJsonString();
    map<json> result = check decoded.ensureType();
    return result;
}

function verifyJwt(string token, JwtAlgorithm algorithm, byte[]|crypto:PublicKey key) returns boolean|error {
    string[] parts = re `\.`.split(token);
    byte[] signingInput = (parts[0] + "." + parts[1]).toBytes();
    byte[] signature = check base64UrlDecode(parts[2]);
    if key is byte[] {
        match algorithm {
            "HS256" => {
                return check crypto:hmacSha256(signingInput, key) == signature;
            }
            "HS384" => {
                return check crypto:hmacSha384(signingInput, key) == signature;
            }
            _ => {
                return check crypto:hmacSha512(signingInput, key) == signature;
            }
        }
    }
    match algorithm {
        "RS256" => {
            return crypto:verifyRsaSha256Signature(signingInput, signature, key);
        }
        "RS384" => {
            return crypto:verifyRsaSha384Signature(signingInput, signature, key);
        }
        _ => {
            return crypto:verifyRsaSha512Signature(signingInput, signature, key);
        }
    }
}

function tamper(string token) returns string|error {
    string[] parts = re `\.`.split(token);
    map<json> claims = check jsonPart(token, 1);
    claims["iss"] = "someone-else";
    return parts[0] + "." + base64Url(claims.toJsonString().toBytes()) + "." + parts[2];
}

function hmacSigning(JwtAlgorithm algorithm) returns JwtSigning => {
    issuer: "my-issuer",
    audience: "llm-api",
    signing_key: HMAC_SECRETS.get(algorithm),
    algorithm
};

function rsaSigning(JwtAlgorithm algorithm, string keyFile = "rsa-2048.pem") returns JwtSigning => {
    issuer: "my-issuer",
    audience: "llm-api",
    signing_key: keyFile,
    algorithm
};

@test:Config
function testHmacSignaturesVerifyAndRejectAWrongKeyOrATamperedPayload() returns error? {
    foreach JwtAlgorithm algorithm in HMAC_ALGORITHMS {
        JwtSigner signer = check new (hmacSigning(algorithm), check keysDirectory());
        string token = check signer.sign();

        test:assertTrue(check verifyJwt(token, algorithm, HMAC_SECRETS.get(algorithm).toBytes()), algorithm);
        test:assertFalse(check verifyJwt(token, algorithm, "x".toBytes()), algorithm);
        test:assertFalse(check verifyJwt(check tamper(token), algorithm, HMAC_SECRETS.get(algorithm).toBytes()), algorithm);
    }
}

@test:Config
function testRsaSignaturesVerifyAndRejectAWrongKeyOrATamperedPayload() returns error? {
    crypto:PublicKey rightKey = check publicKey("rsa-2048-cert.pem");
    crypto:PublicKey otherKey = check publicKey("rsa-2048-other-cert.pem");
    foreach JwtAlgorithm algorithm in RSA_ALGORITHMS {
        JwtSigner signer = check new (rsaSigning(algorithm), check keysDirectory());
        string token = check signer.sign();

        test:assertTrue(check verifyJwt(token, algorithm, rightKey), algorithm);
        test:assertFalse(check verifyJwt(token, algorithm, otherKey), algorithm);
        test:assertFalse(check verifyJwt(check tamper(token), algorithm, rightKey), algorithm);
    }
}

@test:Config
function testPkcs1KeysSign() returns error? {
    JwtSigner signer = check new (rsaSigning("RS256", "rsa-2048-pkcs1.pem"), check keysDirectory());
    test:assertTrue(check verifyJwt(check signer.sign(), "RS256", check publicKey("rsa-2048-cert.pem")));
}

@test:Config
function testTokensSignedByPyJwtVerify() returns error? {
    map<json> golden = check readResourceFile("golden-tokens.json");
    json[] tokens = check golden["tokens"].ensureType();
    test:assertEquals(tokens.length(), 6);
    foreach json item in tokens {
        map<json> entry = check item.ensureType();
        string algorithm = check entry["algorithm"].ensureType();
        string keyText = check entry["key"].ensureType();
        string token = check entry["token"].ensureType();
        JwtAlgorithm jwtAlgorithm = check algorithm.ensureType();

        byte[]|crypto:PublicKey key = algorithm.startsWith("HS")
            ? keyText.toBytes()
            : check crypto:decodeRsaPublicKeyFromCertFile(check resourcesDirectory() + "/" + keyText);
        test:assertTrue(check verifyJwt(token, jwtAlgorithm, key), algorithm);
        test:assertEquals(check jsonPart(token, 1), check golden["claims"].ensureType(), algorithm);
    }
}

@test:Config
function testHeaderAndClaims() returns error? {
    JwtSigning signing = {
        issuer: "my-issuer",
        audience: ["a", "b"],
        signing_key: HMAC_SECRETS.get("HS256"),
        algorithm: "HS256",
        key_id: "key-1",
        subject: "svc",
        custom_claims: {tenant: "t1", count: 5},
        expiry_seconds: 120
    };
    JwtSigner signer = check new (signing, check keysDirectory());
    string token = check signer.sign();

    test:assertEquals(check jsonPart(token, 0), {alg: "HS256", typ: "JWT", kid: "key-1"});
    map<json> claims = check jsonPart(token, 1);
    test:assertEquals(claims.keys().sort(), ["aud", "count", "exp", "iat", "iss", "sub", "tenant"]);
    test:assertEquals(claims["aud"], ["a", "b"]);
    test:assertEquals(claims["sub"], "svc");
    test:assertEquals(claims["count"], 5);
    int issuedAt = check claims["iat"].ensureType();
    test:assertEquals(claims["exp"], issuedAt + 120);
}

@test:Config
function testOptionalClaimsAreOnlySentWhenConfigured() returns error? {
    JwtSigner signer = check new (hmacSigning("HS256"), check keysDirectory());
    string token = check signer.sign();

    test:assertEquals(check jsonPart(token, 0), {alg: "HS256", typ: "JWT"});
    map<json> claims = check jsonPart(token, 1);
    test:assertEquals(claims.keys().sort(), ["aud", "exp", "iat", "iss"]);
    int issuedAt = check claims["iat"].ensureType();
    test:assertEquals(claims["exp"], issuedAt + 300);
    test:assertFalse(claims.hasKey("nbf"));
    test:assertFalse(claims.hasKey("jti"));
}

@test:Config
function testEmptyOptionalValuesAreSentAsConfigured() returns error? {
    JwtSigning signing = hmacSigning("HS256");
    signing.subject = "";
    signing.key_id = "";
    JwtSigner signer = check new (signing, check keysDirectory());
    string token = check signer.sign();

    test:assertEquals((check jsonPart(token, 0))["kid"], "");
    test:assertEquals((check jsonPart(token, 1))["sub"], "");
}

@test:Config
function testOnlyAssertionsCarryAUniqueJwtId() returns error? {
    JwtSigner signer = check new (hmacSigning("HS256"), check keysDirectory());

    test:assertFalse((check jsonPart(check signer.sign(), 1)).hasKey("jti"));
    string first = check (check jsonPart(check signer.sign(withJti = true), 1))["jti"].ensureType();
    string second = check (check jsonPart(check signer.sign(withJti = true), 1))["jti"].ensureType();
    test:assertNotEquals(first, second);
}

@test:Config
function testAFreshTokenIsSignedForEveryCall() returns error? {
    lock {
        fakeNow = 1000;
    }
    JwtSigning signing = hmacSigning("HS256");
    signing.expiry_seconds = 60;
    JwtSigner signer = check new (signing, check keysDirectory(), fakeClock);

    map<json> first = check jsonPart(check signer.sign(), 1);
    lock {
        fakeNow = 1061;
    }
    map<json> second = check jsonPart(check signer.sign(), 1);

    test:assertEquals(first["iat"], 1000);
    test:assertEquals(first["exp"], 1060);
    test:assertEquals(second["iat"], 1061);
    test:assertEquals(second["exp"], 1121);
}

@test:Config
function testBase64UrlHasNoPaddingAndUsesTheUrlAlphabet() {
    test:assertEquals(base64Url([0xfb, 0xff]), "-_8");
    test:assertEquals(base64Url([0xfb, 0xff, 0xbe]), "-_--");
    test:assertEquals(base64Url([]), "");
}

@test:Config
function testRsaKeysAreMeasuredExactly() returns error? {
    string directory = check keysDirectory();
    map<int> expectedBits = {
        "rsa-1024.pem": 1024,
        "rsa-2047.pem": 2047,
        "rsa-2048.pem": 2048,
        "rsa-2048-pkcs1.pem": 2048,
        "rsa-2048-other.pem": 2048
    };
    foreach [string, int] [file, bits] in expectedBits.entries() {
        test:assertEquals(check rsaModulusBits(check io:fileReadString(directory + "/" + file)), bits, file);
    }
}

@test:Config
function testKeysBelow2048BitsAreRejected() returns error? {
    foreach string keyFile in ["rsa-2047.pem", "rsa-1024.pem"] {
        JwtSigner|error signer = new (rsaSigning("RS256", keyFile), check keysDirectory());
        test:assertTrue(signer is error, keyFile);
        test:assertEquals((<error>signer).message(), "signing_key RSA key must be at least 2048 bits");
    }
}

@test:Config
function testUnusableKeyFilesAreRejected() returns error? {
    string directory = check keysDirectory();
    map<string> expected = {
        "rsa-2048-encrypted.pem": "signing_key file is encrypted; only unencrypted PEM keys are supported",
        "rsa-2048-cert.pem": "signing_key file must contain an unencrypted RSA PEM private key",
        "missing.pem": "signing_key file cannot be read"
    };
    foreach [string, string] [keyFile, message] in expected.entries() {
        JwtSigner|error signer = new (rsaSigning("RS256", keyFile), directory);
        test:assertTrue(signer is error, keyFile);
        test:assertEquals((<error>signer).message(), message);
    }
}

@test:Config
function testKeyPathsAreRelativeToTheAfmDirectoryOrAbsolute() returns error? {
    string directory = check resourcesDirectory();
    crypto:PublicKey rightKey = check publicKey("rsa-2048-cert.pem");

    JwtSigner relative = check new (rsaSigning("RS256", "keys/rsa-2048.pem"), directory);
    test:assertTrue(check verifyJwt(check relative.sign(), "RS256", rightKey));

    JwtSigner absolute = check new (rsaSigning("RS256", directory + "/keys/rsa-2048.pem"), "/nonexistent");
    test:assertTrue(check verifyJwt(check absolute.sign(), "RS256", rightKey));
}

@test:Config
function testDerLengthsInLongForm() returns error? {
    byte[] der = [0x30, 0x81, 0x08, 0x02, 0x01, 0x00, 0x02, 0x03, 0x00, 0xff, 0xff];
    test:assertEquals(check modulusBitsOfPkcs1(der), 16);
    byte[] truncated = [0x30, 0x05, 0x02, 0x01];
    test:assertTrue(modulusBitsOfPkcs1(truncated) is error);
}
