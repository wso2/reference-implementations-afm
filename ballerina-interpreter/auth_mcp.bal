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
import ballerina/http;

function createMcpToolKit(HttpTransport transport, ToolFilter? filter, string afmFileDir, string location)
        returns ai:McpBaseToolKit|error {
    ClientAuthentication? auth = transport.authentication;
    string authLocation = location + ".transport.authentication";
    if auth is ApiKeyAuthentication|OAuth2Authentication {
        HeaderProvider headers = <HeaderProvider>check createHeaderProvider(auth, afmFileDir, authLocation, transport.url);
        return new McpHttpToolKit(transport.url, headers, filter, location);
    }

    http:ClientAuthConfig? clientAuth = check mcpClientAuth(auth, afmFileDir, authLocation);
    ai:McpToolKit toolKit = check new (transport.url, permittedTools = filter?.allow, auth = clientAuth);
    string[]? deny = filter?.deny;
    return deny is string[] ? new DenyListToolKit(toolKit, deny) : toolKit;
}

// The library can only filter by an allow list, so the deny list is applied to the tools it returns.
isolated class DenyListToolKit {
    *ai:McpBaseToolKit;

    private final ai:ToolConfig[] & readonly tools;

    isolated function init(ai:BaseToolKit toolKit, string[] deny) {
        self.tools = (from ai:ToolConfig tool in toolKit.getTools()
            where deny.indexOf(tool.name) is ()
            select tool).cloneReadOnly();
    }

    public isolated function getTools() returns ai:ToolConfig[] => self.tools;
}

function mcpClientAuth(BearerAuthentication|BasicAuthentication|JwtAuthentication? auth, string afmFileDir, string location)
        returns http:ClientAuthConfig|error? {
    if auth is () {
        return ();
    }
    if auth is BearerAuthentication {
        check checkSendable("token", auth.token, location);
        return {token: auth.token};
    }
    if auth is BasicAuthentication {
        return {username: auth.username, password: auth.password};
    }
    JwtAuthentication {'type: _, ...signing} = auth;
    return jwtIssuerConfig(signing, afmFileDir);
}

function jwtIssuerConfig(JwtSigning signing, string afmFileDir) returns http:JwtIssuerConfig|error {
    _ = check loadSigningKey(signing, afmFileDir);

    http:JwtIssuerConfig config = {
        issuer: signing.issuer,
        audience: signing.audience,
        expTime: <decimal>signing.expiry_seconds,
        signatureConfig: {
            algorithm: signing.algorithm,
            config: signing.algorithm.startsWith("HS")
                ? signing.signing_key
                : {keyFile: check signingKeyPath(signing, afmFileDir)}
        }
    };
    string? subject = signing?.subject;
    if subject is string {
        config.username = subject;
    }
    string? keyId = signing?.key_id;
    if keyId is string {
        config.keyId = keyId;
    }
    map<json>? customClaims = signing?.custom_claims;
    if customClaims is map<json> {
        config.customClaims = customClaims;
    }
    return config;
}
