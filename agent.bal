// Copyright (c) 2024, WSO2 LLC. (https://www.wso2.com).
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

function createAgent(AFMRecord afmRecord) returns ai:Agent|error {
    AFMRecord {metadata, role, instructions} = afmRecord;

    ai:McpToolKit[] mcpToolkits = [];
    MCPServer[]? mcpServers = metadata?.tools?.mcp;
    if mcpServers is MCPServer[] {
        foreach MCPServer mcpConn in mcpServers {
            Transport transport = mcpConn.transport;
            if transport.'type != "http" {
                log:printWarn(string `Unsupported transport type: ${transport.'type}, only 'http' is supported`);
                continue;
            }

            string[]? filteredTools = getFilteredTools(mcpConn.tool_filter);
            mcpToolkits.push(check new ai:McpToolKit(
                transport.url,
                permittedTools = filteredTools,
                auth = check mapToHttpClientAuth(transport.authentication)
            ));
        }
    }

    ai:ModelProvider model = check getModel(metadata?.model);
    
    ai:AgentConfiguration agentConfig = {
        systemPrompt: {
            role, 
            instructions
        },
        tools: mcpToolkits,
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

    provider = provider.toLowerAscii();

    if provider == "wso2" {
        return new ai:Wso2ModelProvider(
            model.url ?: "https://dev-tools.wso2.com/ballerina-copilot/v2.0",
            check getToken(model.authentication)
        );
    }

    string? name = model.name;
    if name is () {
        return error("This implementation requires the 'name' of the model to be specified");
    }

    match provider {
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
    return error(string `Model provider: ${<string>provider} not yet supported`);
}

const DEFAULT_SESSION_ID = "sessionId";

function runAgent(ai:Agent agent, json payload, map<json>? inputSchema = (), map<json>? outputSchema = (), string sessionId = DEFAULT_SESSION_ID) 
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

        if schemaType !is "object"|"array" {
            effectiveOutputSchema = {
                "type": "object",
                "properties": { "value": { "type": schemaType } },
                "required": ["value"]
            };
            isUpdatedSchema = true;
        }
    }
    string|ai:Error run = agent.run(
        string `${payload.toJsonString()}
        
        ${effectiveOutputSchema is map<json> ? 
        string `The final response MUST conform to the following JSON schema: ${
            effectiveOutputSchema.toJsonString()}` : ""}

        Respond only with the value enclosed between ${"```"} and ${"```"}.`, sessionId);

    if run is ai:Error {
        log:printError("Agent run failed", 'error = run);
        return error AgentError("Agent run failed", run);
    }

    string responseJsonStr = run;
    
    int? tripleBacktickStart = run.indexOf("```");
    int? tripleBacktickEnd = run.lastIndexOf("```");
    if tripleBacktickStart is int && tripleBacktickEnd is int && tripleBacktickEnd > tripleBacktickStart {
        responseJsonStr = run.substring(tripleBacktickStart + 3, tripleBacktickEnd).trim();
    }

    json|error responseJson = responseJsonStr.toJsonString().fromJsonString();

    if responseJson is error {
        log:printError("Failed to parse agent response JSON", 'error = responseJson);
        return error AgentError("Failed to parse agent response JSON");
    }

    error? validateOutputSchemaResult = validateJsonSchema(effectiveOutputSchema, responseJson);
    if validateOutputSchemaResult is error {
        log:printError("Agent response does not conform to output schema", 'error = validateOutputSchemaResult);
        return error AgentError("Agent response does not conform to output schema", validateOutputSchemaResult);
    }
    return isUpdatedSchema ? (<map<json>> responseJson).get("value") : responseJson;
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
            return error("JSON validation failed: " + validationResult.message());
        }
        return (); 
    }

    // Wrap value and validate using generated object schema
    map<json> valueSchema = {
        "type": "object",
        "properties": { "value": { "type": schemaType } },
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
        "oauth2" => {
            // record {string grantType;}|error oauth2Config = check rest.cloneWithType();
            // if oauth2Config is error {
            //     return error("OAuth2 authentication requires 'grantType' field", oauth2Config);
            // }
            
            // var {grantType, ...oauth2ConfigRest} = oauth2Config;

            // match grantType.toLowerAscii() {
            //     "client_credentials" => {
            //         return oauth2ConfigRest.cloneWithType(http:OAuth2ClientCredentialsGrantConfig);
            //     }
            //     "password" => {
            //         return oauth2ConfigRest.cloneWithType(http:OAuth2PasswordGrantConfig);
            //     }
            //     "refresh_token" => {
            //         return oauth2ConfigRest.cloneWithType(http:OAuth2RefreshTokenGrantConfig);
            //     }
            //     "jwt" => {
            //         return oauth2Config.cloneWithType(http:OAuth2JwtBearerGrantConfig);
            //     }
            // }
            // panic error(string `Unsupported OAuth2 grant type: ${grantType}`);
            return error("OAuth2 authentication not yet supported");
        }
        "jwt" => {
            // return rest.cloneWithType(http:JwtIssuerConfig);
            return error("JWT authentication not yet supported");
        }
        _ => {
            return error(string `Unsupported authentication type: ${'type}`);
        }
    }
}
