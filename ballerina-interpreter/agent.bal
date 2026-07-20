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
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import afm_ballerina.everit.validator;

import ballerina/ai;
import ballerina/log;
import ballerina/os;
import ballerina/http;
import ballerinax/ai.anthropic;
import ballerinax/ai.openai;

function createAgent(AFMRecord afmRecord, string afmFileDir) returns ai:Agent|error {
    AFMRecord {metadata, role, instructions} = afmRecord;

    ai:McpToolKit[] mcpToolKits = [];
    MCPServer[]? mcpServers = metadata?.tools?.mcp;
    if mcpServers is MCPServer[] {
        foreach MCPServer mcpConn in mcpServers {
            Transport transport = mcpConn.transport;
            if transport is StdioTransport {
                return error("Stdio transport is not yet supported by the Ballerina interpreter");
            }

            string[]? filteredTools = getFilteredTools(mcpConn.tool_filter);
            mcpToolKits.push(check new ai:McpToolKit(
                transport.url,
                permittedTools = filteredTools,
                auth = check mapToHttpClientAuth(transport.authentication)
            ));
        }
    }

    [string, SkillsToolKit]? catalog = check extractSkillCatalog(metadata, afmFileDir);

    string effectiveInstructions;
    (ai:BaseToolKit)[] toolKits;

    if catalog is () {
        effectiveInstructions = instructions;
        toolKits = mcpToolKits;
    } else {
        effectiveInstructions = string `${instructions}\n\n${catalog[0]}`;
        toolKits = [...mcpToolKits, catalog[1]];
    }

    ai:ModelProvider model = check getModel(metadata?.model);

    ai:AgentConfiguration agentConfig = {
        systemPrompt: {
            role,
            instructions: effectiveInstructions
        },
        tools: toolKits,
        model
    };
    
    int? maxIterations = metadata?.max_iterations;
    if maxIterations is int {
        agentConfig.maxIter = maxIterations;
    }
    
    ai:Agent|ai:Error agent = new (agentConfig);
    if agent is ai:Error {
        return error("Failed to create agent", agent);
    }
    return agent;
}

function getModel(Model? model) returns ai:ModelProvider|error {
    if model is () {        
        string? accessToken = os:getEnv("WSO2_MODEL_PROVIDER_TOKEN");
        if accessToken is () {
            return error("Environment variable WSO2_MODEL_PROVIDER_TOKEN must be set for Wso2ModelProvider");
        }

        return new ai:Wso2ModelProvider(
            "https://dev-tools.wso2.com/ballerina-copilot/v2.0",
            accessToken);
    }

    string? provider = model.provider;

    if provider is () {
        return error("This implementation requires the 'provider' of the model to be specified");
    }

    string providerLower = provider.toLowerAscii();

    if providerLower == "wso2" {
        return new ai:Wso2ModelProvider(
            model.url ?: "https://dev-tools.wso2.com/ballerina-copilot/v2.0",
            check getToken(model.authentication)
        );
    }

    string? name = model.name;
    if name is () {
        return error("This implementation requires the 'name' of the model to be specified");
    }

    match providerLower {
        "openai" => {
            return new openai:ModelProvider(
                check getApiKey(model.authentication),
                check name.ensureType(),
                model.url ?: "https://api.openai.com/v1"
            );
        }
        "anthropic" => {
            return new anthropic:ModelProvider(
                check getApiKey(model.authentication),
                check name.ensureType(),
                model.url ?: "https://api.anthropic.com/v1"
            );
        }
    }
    return error(string `Model provider: ${provider} not yet supported`);
}

const DEFAULT_SESSION_ID = "sessionId";

isolated function runAgent(ai:Agent agent, json payload, map<json>? inputSchema = (), 
                  map<json>? outputSchema = (), string sessionId = DEFAULT_SESSION_ID) 
        returns json|InputError|AgentError {
    error? validateJsonSchemaResult = validateJsonSchema(inputSchema, payload);
    if validateJsonSchemaResult is error {
        log:printError("Invalid input payload", 'error = validateJsonSchemaResult);
        return error InputError("Invalid input payload");
    }

    boolean isUpdatedSchema = false;
    map<json>? effectiveOutputSchema = outputSchema;

    if outputSchema is map<json> {
        string|error schemaType = outputSchema["type"].ensureType();
        if schemaType is error {
            log:printError("Invalid output schema", 'error = schemaType);
            return error AgentError("Invalid output schema, expected a 'type' field", schemaType);
        }

        if schemaType !is "object" {
            effectiveOutputSchema = {
                "type": "object",
                "properties": { "value": outputSchema },
                "required": ["value"]
            };
            isUpdatedSchema = true;
        }
    }
    string|ai:Error run = agent.run(
        outputSchema is map<json> ?
            string `${payload.toJsonString()}

            The final response MUST conform to the following JSON schema: ${effectiveOutputSchema.toJsonString()}

            Respond only with the value enclosed between ${"```"} and ${"```"}.`
            : payload.toJsonString(),
        sessionId);

    if run is ai:Error {
        log:printError("Agent run failed", 'error = run);
        return error AgentError("Agent run failed", run);
    }

    // If no output schema, return raw response without JSON parsing
    if effectiveOutputSchema is () {
        return run;
    }

    string responseJsonStr = extractJsonFromCodeBlock(run);

    json|error responseJson = responseJsonStr.fromJsonString();

    if responseJson is error {
        log:printError("Failed to parse agent response JSON", 'error = responseJson);
        return error AgentError("Failed to parse agent response JSON");
    }

    error? validateOutputSchemaResult = validateJsonSchema(effectiveOutputSchema, responseJson);
    if validateOutputSchemaResult is error {
        log:printError("Agent response does not conform to output schema", 'error = validateOutputSchemaResult);
        return error AgentError("Agent response does not conform to output schema", validateOutputSchemaResult);
    }

    if !isUpdatedSchema {
        return responseJson;
    }

    map<json>|error responseJsonObject = responseJson.ensureType();
    if responseJsonObject is error {
        log:printError("Expected agent response to be a JSON object", 'error = responseJsonObject);
        return error AgentError("Expected agent response to be a JSON object");
    }

    return responseJsonObject.get("value");
}

isolated function extractJsonFromCodeBlock(string response) returns string {
    // Prioritize ```json block, fall back to generic ```
    int? jsonBlockStart = response.indexOf("```json");
    int? contentStart = jsonBlockStart is int ? jsonBlockStart + 7 : ();

    if contentStart is () {
        int? genericStart = response.indexOf("```");
        contentStart = genericStart is int ? genericStart + 3 : ();
    }

    if contentStart is int {
        int? blockEnd = response.indexOf("```", contentStart);
        if blockEnd is int {
            return response.substring(contentStart, blockEnd).trim();
        }
    }

    return response;
}

function getFilteredTools(ToolFilter? toolFilter) returns string[]? {
    if toolFilter is () {
        return (); // No filtering - all tools allowed
    }
    
    string[]? allow = toolFilter.allow;
    string[]? deny = toolFilter.deny;
    
    // If no filters specified, return null (all tools)
    if allow is () && deny is () {
        return ();
    }
    
    // If only allow is specified, return it
    if allow is string[] && deny is () {
        return allow;
    }
    
    // If only deny is specified, we can't handle it with current API
    // (would need to fetch all tools first, then filter)
    if allow is () && deny is string[] {
        log:printWarn("Deny-only tool filter not fully supported - ignoring deny list");
        return (); // Return all for now
    }
    
    // If both specified: apply allow first, then remove denied tools
    if allow is string[] && deny is string[] {
        string[] filtered = [];
        foreach string tool in allow {
            boolean isDenied = false;
            foreach string deniedTool in deny {
                if tool == deniedTool {
                    isDenied = true;
                    break;
                }
            }
            if !isDenied {
                filtered.push(tool);
            }
        }
        return filtered;
    }
    
    return ();
}

isolated function validateJsonSchema(map<json>? jsonSchemaVal, json sampleJson) returns error? {
    if jsonSchemaVal is () {
        return ();
    }

    string schemaType = check jsonSchemaVal["type"].ensureType();
    if schemaType == "object" {
        validator:JSONObject schemaObject = validator:newJSONObject7(jsonSchemaVal.toJsonString());
        validator:SchemaLoaderBuilder builder = validator:newSchemaLoaderBuilder1();
        validator:SchemaLoader schemaLoader = builder.schemaJson(schemaObject).build();
        validator:Schema schema = schemaLoader.load().build();
        validator:JSONObject jsonObject = validator:newJSONObject7(sampleJson.toJsonString());
        error? validationResult = trap schema.validate(jsonObject);
        if validationResult is error {
            return error(string `JSON validation failed: ${validationResult.message()}`);
        }
        return (); 
    }

    // Wrap value and validate using generated object schema
    map<json> valueSchema = {
        "type": "object",
        "properties": { "value": jsonSchemaVal },
        "required": ["value"]
    };
    validator:JSONObject schemaObject = validator:newJSONObject7(valueSchema.toJsonString());
    validator:SchemaLoaderBuilder builder = validator:newSchemaLoaderBuilder1();
    validator:SchemaLoader schemaLoader = builder.schemaJson(schemaObject).build();
    validator:Schema schema = schemaLoader.load().build();
    map<json> wrapped = { "value": sampleJson };
    validator:JSONObject jsonObject = validator:newJSONObject7(wrapped.toJsonString());
    error? validationResult = trap schema.validate(jsonObject);
    if validationResult is error {
        return error("JSON validation failed: " + validationResult.message());
    }
}

function getApiKey(ClientAuthentication? auth) returns string|error =>
    getAuthTokenOrApiKey(auth, "api-key", "api_key");

function getToken(ClientAuthentication? auth) returns string|error =>
    getAuthTokenOrApiKey(auth, "bearer", "token");

function getAuthTokenOrApiKey(ClientAuthentication? auth, string expectedType, string expectedKey) returns string|error {
    if auth is () {
        return error("No authentication provided");
    }

    if auth.'type.toLowerAscii() != expectedType {
        return error(string `Unsupported authentication type for ${expectedType}: ${auth.'type}`);
    }

    if !auth.hasKey(expectedKey) {
        return error(string `${expectedKey} not found in 'authentication'`);
    }
    
    return auth.get(expectedKey).ensureType();
}

function mapToHttpClientAuth(ClientAuthentication? auth) returns http:ClientAuthConfig|error? {
    if auth is () {
        return ();
    }
    
    ClientAuthentication {'type, ...rest} = auth;

    'type = 'type.toLowerAscii();
    
    match 'type {
        "basic" => {
            return rest.cloneWithType(http:CredentialsConfig);
        }
        "bearer" => {
            return rest.cloneWithType(http:BearerTokenConfig);
        }
        "api-key" => {
            return error("API key authentication is not yet supported for MCP/webhook transport in the Ballerina interpreter");
        }
        "oauth2" => {
            OAuth2Config|error oauth2Config = rest.cloneWithType();
            if oauth2Config is error {
                return error("Invalid OAuth2 authentication configuration", oauth2Config);
            }
            return buildOAuth2GrantConfig(oauth2Config);
        }
        "jwt" => {
            JwtAuthConfig|error jwtConfig = rest.cloneWithType();
            if jwtConfig is error {
                return error("Invalid JWT authentication configuration", jwtConfig);
            }
            return buildJwtIssuerConfig(jwtConfig);
        }
        _ => {
            if 'type.startsWith("x-") {
                return error(string `extension authentication type '${'type}' is not supported by this runtime`);
            }
            return error(string `Unsupported authentication type: ${'type}`);
        }
    }
}

type JwtAuthConfig record {|
    string issuer;
    string|string[] audience?;
    string signing_key;
    string algorithm = "RS256";
    string key_id?;
    string subject?;
    map<json> custom_claims?;
    decimal expiry_seconds = 300;
|};

function buildJwtIssuerConfig(JwtAuthConfig jwtConfig) returns http:JwtIssuerConfig|error {
    string algorithm = jwtConfig.algorithm;
    boolean isHmac = algorithm == "HS256" || algorithm == "HS384" || algorithm == "HS512";
    json signatureKeyConfig = isHmac ? jwtConfig.signing_key : {keyFile: jwtConfig.signing_key};

    map<json> issuerConfig = {
        issuer: jwtConfig.issuer,
        expTime: jwtConfig.expiry_seconds,
        signatureConfig: {
            algorithm,
            config: signatureKeyConfig
        }
    };

    string|string[]? audience = jwtConfig?.audience;
    if audience is string|string[] {
        issuerConfig["audience"] = audience;
    }

    string? keyId = jwtConfig?.key_id;
    if keyId is string {
        issuerConfig["keyId"] = keyId;
    }
    string? subject = jwtConfig?.subject;
    if subject is string {
        issuerConfig["username"] = subject;
    }
    map<json>? customClaims = jwtConfig?.custom_claims;
    if customClaims is map<json> {
        issuerConfig["customClaims"] = customClaims;
    }

    http:JwtIssuerConfig|error result = issuerConfig.cloneWithType();
    if result is error {
        return error("Invalid JWT authentication configuration", result);
    }
    return result;
}

type OAuth2Config record {|
    string grant_type;
    string token_url?;
    string client_id?;
    string client_secret?;
    string username?;
    string password?;
    string refresh_token?;
    string assertion?;
    string[] scopes?;
    string credential_bearer = "auth_header";
|};

function buildOAuth2GrantConfig(OAuth2Config cfg) returns http:OAuth2GrantConfig|error {
    string grant = cfg.grant_type.toLowerAscii();
    string credentialBearer = cfg.credential_bearer == "post_body" ? "POST_BODY_BEARER" : "AUTH_HEADER_BEARER";
    match grant {
        "client_credentials" => {
            map<json> grantConfig = {tokenUrl: cfg?.token_url, clientId: cfg?.client_id, clientSecret: cfg?.client_secret, credentialBearer};
            addScopes(grantConfig, cfg?.scopes);
            return wrapOAuth2(grantConfig.cloneWithType(http:OAuth2ClientCredentialsGrantConfig));
        }
        "password" => {
            map<json> grantConfig = {tokenUrl: cfg?.token_url, username: cfg?.username, password: cfg?.password, credentialBearer};
            addOptional(grantConfig, "clientId", cfg?.client_id);
            addOptional(grantConfig, "clientSecret", cfg?.client_secret);
            addScopes(grantConfig, cfg?.scopes);
            return wrapOAuth2(grantConfig.cloneWithType(http:OAuth2PasswordGrantConfig));
        }
        "refresh_token" => {
            map<json> grantConfig = {refreshUrl: cfg?.token_url, refreshToken: cfg?.refresh_token, clientId: cfg?.client_id, clientSecret: cfg?.client_secret, credentialBearer};
            addScopes(grantConfig, cfg?.scopes);
            return wrapOAuth2(grantConfig.cloneWithType(http:OAuth2RefreshTokenGrantConfig));
        }
        "jwt_bearer" => {
            map<json> grantConfig = {tokenUrl: cfg?.token_url, assertion: cfg?.assertion, credentialBearer};
            addOptional(grantConfig, "clientId", cfg?.client_id);
            addOptional(grantConfig, "clientSecret", cfg?.client_secret);
            addScopes(grantConfig, cfg?.scopes);
            return wrapOAuth2(grantConfig.cloneWithType(http:OAuth2JwtBearerGrantConfig));
        }
    }
    return error(string `Unsupported OAuth2 grant type: ${cfg.grant_type}`);
}

function wrapOAuth2(http:OAuth2GrantConfig|error result) returns http:OAuth2GrantConfig|error {
    if result is error {
        return error("Invalid OAuth2 authentication configuration", result);
    }
    return result;
}

function addScopes(map<json> target, string[]? scopes) {
    if scopes is string[] {
        target["scopes"] = scopes;
    }
}

function addOptional(map<json> target, string key, string? value) {
    if value is string {
        target[key] = value;
    }
}
