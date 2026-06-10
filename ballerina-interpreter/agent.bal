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
import ballerina/io;
import ballerina/log;
import ballerina/os;
import ballerina/http;
import ballerinax/ai.anthropic;
import ballerinax/ai.openai;
import ballerinax/ai.ollama;
import ballerinax/ai.googleapis.vertex;

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
        "ollama" => {
            string url = model.url ?: "http://localhost:11434";
            return new ollama:ModelProvider(check name.ensureType(), url);
        }
        "gemini" => {
            return getGeminiModel(model, name);
        }
    }
    return error(string `Model provider: ${provider} not yet supported`);
}

// Standard Google environment variable holding the path to a service account JSON key.
const GOOGLE_APP_CREDENTIALS_ENV = "GOOGLE_APPLICATION_CREDENTIALS";
const DEFAULT_VERTEX_LOCATION = "us-central1";
//(e.g. "gemini-2.5-flash" -> "google/gemini-2.5-flash").
const DEFAULT_MODEL_PUBLISHER = "google";


function getGeminiModel(Model model, string name) returns ai:ModelProvider|error {
    string? project = model.project;
    if project is () {
        return error("Vertex AI requires the 'project' field to be set in the model block " +
            "(AI Studio Gemini is not yet supported by the Ballerina interpreter)");
    }

    string? credentialsPath = os:getEnv(GOOGLE_APP_CREDENTIALS_ENV);
    if credentialsPath is () || credentialsPath.trim() == "" {
        return error(string `Vertex AI authentication requires Google credentials. Set the ` +
            string `'${GOOGLE_APP_CREDENTIALS_ENV}' environment variable to the path of a service account ` +
            string `JSON key file or a gcloud Application Default Credentials file.`);
    }

    vertex:VertexAiAuth auth = check resolveVertexAuth(credentialsPath);

    string location = model.location ?: DEFAULT_VERTEX_LOCATION;
    string qualifiedModel = name.includes("/") ? name : string `${DEFAULT_MODEL_PUBLISHER}/${name}`;

    vertex:ModelProvider|error vertexModel = new (auth, project, qualifiedModel, location = location);
    if vertexModel is error {
        return error(string `Failed to initialize the Vertex AI model provider: ${vertexModel.message()}`, vertexModel);
    }
    return vertexModel;
}

function resolveVertexAuth(string credentialsPath) returns vertex:VertexAiAuth|error {
    json|error credsJson = io:fileReadJson(credentialsPath);
    if credsJson is error {
        return error(string `Unable to read Google credentials file at '${credentialsPath}': ${credsJson.message()}`, credsJson);
    }

    map<json>|error creds = credsJson.ensureType();
    if creds is error {
        return error(string `Google credentials file at '${credentialsPath}' is not a valid JSON object`);
    }

    if creds["type"] == "authorized_user" {
        json clientId = creds["client_id"];
        json clientSecret = creds["client_secret"];
        json refreshToken = creds["refresh_token"];
        if clientId !is string || clientSecret !is string || refreshToken !is string {
            return error("Authorized-user (ADC) credentials must contain string 'client_id', " +
                "'client_secret', and 'refresh_token' fields");
        }
        vertex:OAuth2RefreshConfig oauth2Config = {clientId, clientSecret, refreshToken};
        return oauth2Config;
    }

    return credentialsPath;
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
