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

import ballerina/http;
import ballerina/io;
import ballerina/lang.runtime;
import ballerina/test;

@test:Config
function testValidateJsonSchemaNullSchema() returns error? {
    json sample = {"name": "Alice"};
    error? result = validateJsonSchema((), sample);
    test:assertTrue(result is ());
}

@test:Config
function testValidateJsonSchemaObjectValid() returns error? {
    map<json> schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "age": {"type": "number"}
        },
        "required": ["name"]
    };
    json sample = {"name": "Alice", "age": 30};
    error? result = validateJsonSchema(schema, sample);
    test:assertTrue(result is ());
}

@test:Config
function testValidateJsonSchemaObjectInvalid() returns error? {
    map<json> schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "age": {"type": "number"}
        },
        "required": ["name"]
    };
    json sample = {"age": 30}; // Missing required 'name'
    error? result = validateJsonSchema(schema, sample);
    test:assertTrue(result is error);
}

@test:Config
function testValidateJsonSchemaObjectTypeInvalid() returns error? {
    map<json> schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "age": {"type": "number"}
        }
    };
    json sample = {"name": "Alice", "age": "thirty"}; // Wrong type for age
    error? result = validateJsonSchema(schema, sample);
    test:assertTrue(result is error);
}

@test:Config
function testValidateJsonSchemaPrimitiveStringValid() returns error? {
    map<json> schema = {"type": "string"};
    json sample = "hello";
    error? result = validateJsonSchema(schema, sample);
    test:assertTrue(result is ());
}

@test:Config
function testValidateJsonSchemaPrimitiveStringInvalid() returns error? {
    map<json> schema = {"type": "string"};
    json sample = 123;
    error? result = validateJsonSchema(schema, sample);
    test:assertTrue(result is error);
}

@test:Config
function testValidateJsonSchemaPrimitiveNumberValid() returns error? {
    map<json> schema = {"type": "number"};
    json sample = 42;
    error? result = validateJsonSchema(schema, sample);
    test:assertTrue(result is ());
}

@test:Config
function testValidateJsonSchemaPrimitiveNumberInvalid() returns error? {
    map<json> schema = {"type": "number"};
    json sample = "not a number";
    error? result = validateJsonSchema(schema, sample);
    test:assertTrue(result is error);
}

@test:Config
function testValidateJsonSchemaPrimitiveBooleanValid() returns error? {
    map<json> schema = {"type": "boolean"};
    json sample = true;
    error? result = validateJsonSchema(schema, sample);
    test:assertTrue(result is ());
}

@test:Config
function testValidateJsonSchemaPrimitiveBooleanInvalid() returns error? {
    map<json> schema = {"type": "boolean"};
    json sample = "true"; // String instead of boolean
    error? result = validateJsonSchema(schema, sample);
    test:assertTrue(result is error);
}

@test:Config
function testValidateJsonSchemaNestedObjectValid() returns error? {
    map<json> schema = {
        "type": "object",
        "properties": {
            "user": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"}
                },
                "required": ["name"]
            }
        }
    };
    json sample = {"user": {"name": "Bob"}};
    error? result = validateJsonSchema(schema, sample);
    test:assertTrue(result is ());
}

@test:Config
function testValidateJsonSchemaArrayValid() returns error? {
    map<json> schema = {
        "type": "array",
        "items": {"type": "string"}
    };
    json sample = ["apple", "banana", "cherry"];
    error? result = validateJsonSchema(schema, sample);
    test:assertTrue(result is ());
}

@test:Config
function testValidateJsonSchemaArrayInvalid() returns error? {
    map<json> schema = {
        "type": "array",
        "items": {"type": "string"}
    };
    json sample = ["apple", 123, "cherry"]; // 123 is not a string
    error? result = validateJsonSchema(schema, sample);
    test:assertTrue(result is error);
}

@test:Config
function testValidateJsonSchemaArrayNotArray() returns error? {
    map<json> schema = {
        "type": "array",
        "items": {"type": "string"}
    };
    json sample = "not an array";
    error? result = validateJsonSchema(schema, sample);
    test:assertTrue(result is error);
}

@test:Config
function testGetFilteredToolsBothAllowAndDeny() returns error? {
    ToolFilter filter = {
        allow: ["tool1", "tool2", "tool3"],
        deny: ["tool2"]
    };
    string[]? result = getFilteredTools(filter);
    test:assertTrue(result is string[]);
    test:assertEquals((<string[]>result).length(), 2);
    test:assertEquals((<string[]>result)[0], "tool1");
    test:assertEquals((<string[]>result)[1], "tool3");
}

@test:Config
function testGetFilteredToolsAllowWithMultipleDenied() returns error? {
    ToolFilter filter = {
        allow: ["tool1", "tool2", "tool3", "tool4"],
        deny: ["tool2", "tool4"]
    };
    string[]? result = getFilteredTools(filter);
    test:assertTrue(result is string[]);
    test:assertEquals((<string[]>result).length(), 2);
    test:assertEquals((<string[]>result)[0], "tool1");
    test:assertEquals((<string[]>result)[1], "tool3");
}

@test:Config
function testGetFilteredToolsAllDenied() returns error? {
    ToolFilter filter = {
        allow: ["tool1", "tool2"],
        deny: ["tool1", "tool2"]
    };
    string[]? result = getFilteredTools(filter);
    test:assertTrue(result is string[]);
    test:assertEquals((<string[]>result).length(), 0);
}

@test:Config
function testGetFilteredToolsEmptyAllow() returns error? {
    ToolFilter filter = {
        allow: []
    };
    string[]? result = getFilteredTools(filter);
    test:assertTrue(result is string[]);
    test:assertEquals((<string[]>result).length(), 0);
}

@test:Config
function testGetAuthTokenOrApiKeyNullAuth() returns error? {
    string|error result = getAuthTokenOrApiKey((), "bearer", "token");
    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(), "No authentication provided");
}

@test:Config
function testGetAuthTokenOrApiKeyTypeMismatch() returns error? {
    ClientAuthentication auth = {
        'type: "basic"
    };
    string|error result = getAuthTokenOrApiKey(auth, "bearer", "token");
    test:assertTrue(result is error);
    test:assertTrue((<error>result).message().includes("Unsupported authentication type"));
}

@test:Config
function testGetAuthTokenOrApiKeyMissingKey() returns error? {
    ClientAuthentication auth = {
        'type: "bearer"
    };
    string|error result = getAuthTokenOrApiKey(auth, "bearer", "token");
    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(), "token not found in 'authentication'");
}

@test:Config
function testGetAuthTokenOrApiKeyValidBearer() returns error? {
    ClientAuthentication auth = {
        'type: "bearer",
        "token": "my-token-123"
    };
    string result = check getAuthTokenOrApiKey(auth, "bearer", "token");
    test:assertEquals(result, "my-token-123");
}

@test:Config
function testGetAuthTokenOrApiKeyValidApiKey() returns error? {
    ClientAuthentication auth = {
        'type: "api-key",
        "api_key": "my-api-key-456"
    };
    string result = check getAuthTokenOrApiKey(auth, "api-key", "api_key");
    test:assertEquals(result, "my-api-key-456");
}

@test:Config
function testGetAuthTokenOrApiKeyCaseInsensitive() returns error? {
    ClientAuthentication auth = {
        'type: "BEARER",
        "token": "case-insensitive-token"
    };
    string result = check getAuthTokenOrApiKey(auth, "bearer", "token");
    test:assertEquals(result, "case-insensitive-token");
}

@test:Config
function testGetApiKeyValid() returns error? {
    ClientAuthentication auth = {
        'type: "api-key",
        "api_key": "test-api-key"
    };
    string result = check getApiKey(auth);
    test:assertEquals(result, "test-api-key");
}

@test:Config
function testGetApiKeyNull() returns error? {
    string|error result = getApiKey(());
    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(), "No authentication provided");
}

@test:Config
function testGetTokenValid() returns error? {
    ClientAuthentication auth = {
        'type: "bearer",
        "token": "test-token"
    };
    string result = check getToken(auth);
    test:assertEquals(result, "test-token");
}

@test:Config
function testGetTokenNull() returns error? {
    string|error result = getToken(());
    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(), "No authentication provided");
}

@test:Config
function testGetModelNoProviderSpecified() returns error? {
    Model model = {
        name: "gpt-4"
    };
    var result = getModel(model);
    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(), "This implementation requires the 'provider' of the model to be specified");
}

@test:Config
function testGetModelNoNameSpecified() returns error? {
    Model model = {
        provider: "openai"
    };
    var result = getModel(model);
    test:assertTrue(result is error);
    test:assertEquals((<error>result).message(), "This implementation requires the 'name' of the model to be specified");
}

@test:Config
function testGetModelUnsupportedProvider() returns error? {
    Model model = {
        provider: "google",
        name: "gemini-pro"
    };
    var result = getModel(model);
    test:assertTrue(result is error);
    test:assertTrue((<error>result).message().includes("not yet supported"));
}

function extractJsonFromCodeBlockDataProvider() returns [string, string, string][] {
    return [
        ["json marker", "Here is the result:\n```json\n{\"name\": \"Alice\"}\n```\nDone.", "{\"name\": \"Alice\"}"],
        ["generic marker", "Here is the result:\n```\n{\"name\": \"Bob\"}\n```\nDone.", "{\"name\": \"Bob\"}"],
        ["no marker", "{\"name\": \"Charlie\"}", "{\"name\": \"Charlie\"}"],
        // Might not be the ideal answer, but we'll leave as is since unexpected.
        ["prioritizes json over other blocks", "Code:\n```python\nprint('hello')\n```\nJSON:\n```json\n{\"value\": 42}\n```", "{\"value\": 42}"],
        ["multiple generic blocks extracts first", "First:\n```\n{\"first\": true}\n```\nSecond:\n```\n{\"second\": true}\n```", "{\"first\": true}"]
    ];
}

@test:Config {
    dataProvider: extractJsonFromCodeBlockDataProvider
}
function testExtractJsonFromCodeBlock(string description, string response, string expected) {
    string result = extractJsonFromCodeBlock(response);
    test:assertEquals(result, expected);
}

// ============================================
// Array Schema End-to-End Tests
// ============================================

@test:Config
function testArrayOutputSchemaEndToEnd() returns error? {
    // Parse AFM and start agent on a different port to avoid conflicts
    string content = check io:fileReadString("tests/sample_array_agent.afm.md");
    AFMRecord afm = check parseAfm(content);

    int testPort = 9195;
    future<error?> _ = start runAgentFromAFM(afm, testPort);

    // Wait for agent to start
    runtime:sleep(2);

    // Create HTTP client to call the agent
    http:Client agentClient = check new (string `http://localhost:${testPort}`);

    // Call the agent with array output schema
    json response = check agentClient->post("/list", {"query": "List some fruits"});

    // Verify the response is an array
    test:assertTrue(response is json[], "Response should be an array");
    json[] responseArray = <json[]>response;
    test:assertEquals(responseArray.length(), 3);
    test:assertEquals(responseArray[0], "apple");
    test:assertEquals(responseArray[1], "banana");
    test:assertEquals(responseArray[2], "cherry");
}

@test:Config
function testArrayOutputSchemaInvalidResponse() returns error? {
    // Parse AFM and start agent on a different port
    string content = check io:fileReadString("tests/sample_array_agent.afm.md");
    AFMRecord afm = check parseAfm(content);

    int testPort = 9196;
    future<error?> _ = start runAgentFromAFM(afm, testPort);

    // Wait for agent to start
    runtime:sleep(2);

    // Create HTTP client to call the agent
    http:Client agentClient = check new (string `http://localhost:${testPort}`);

    // Call the agent with prompt that triggers invalid response (array with non-string item)
    http:Response response = check agentClient->post("/list", {"query": "List with invalid items"});

    // Should return 500 error due to schema validation failure
    test:assertEquals(response.statusCode, 500, "Should return 500 for schema validation failure");
}
