import ballerina/http;
import ballerina/io;
import ballerina/os;
import ballerina/test;

final string[] & readonly TEST_ENV_VARS = [
    "TEST_VAR_1",
    "TEST_VAR_2",
    "VAR_A",
    "VAR_B",
    "COMMENT_VAR"
];

@test:AfterSuite
function cleanupTestEnvVars() returns error? {
    foreach string varName in TEST_ENV_VARS {
        check os:unsetEnv(varName);
    }
}

// ============================================
// Parser Tests
// ============================================

@test:Config
function testParseAfm() returns error? {
    string afmContent = check io:fileReadString("tests/sample_agent.afm.md");
    AFMRecord parsed = check parseAfm(afmContent);
    AFMRecord expected = {
        metadata: {
            spec_version: "0.3.0",
            name: "TestAgent",
            description: "A test agent for AFM parsing.",
            authors: ["Maryam", "Copilot"],
            version: "0.1.0",
            icon_url: "https://example.com/icon.png",
            license: "Apache-2.0",
            interfaces: [
                <WebChatInterface>{
                    'type: "webchat",
                    signature: {
                        input: {
                            'type: "object",
                            properties: {
                                user_prompt: {
                                    'type: "string",
                                    description: "Prompt from user."
                                }
                            },
                            required: ["user_prompt"]
                        },
                        output: {
                            'type: "object",
                            properties: {
                                response: {
                                    'type: "string",
                                    description: "Agent response."
                                }
                            },
                            required: ["response"]
                        }
                    },
                    exposure: {
                        http: {
                            path: "/chat"
                        }
                    }
                }
            ],
            tools: {
                mcp: [
                    {
                        name: "TestServer",
                        transport: {
                            'type: "http",
                            url: "https://test-server.com/api",
                            authentication: {
                                'type: "bearer",
                                "token": "dummy-token"
                            }
                        },
                        tool_filter: {
                            allow: ["tool1", "tool2"]
                        }
                    }
                ]
            },
            max_iterations: 5
        },
        role: "This is a test role for the agent. It should be parsed correctly.",
        instructions: "These are the instructions for the agent. They should also be parsed correctly."
    };
    test:assertEquals(parsed, expected);
}

@test:Config
function testSplitLines() {
    string content = "line1\nline2\nline3";
    string[] lines = splitLines(content);
    test:assertEquals(lines.length(), 3);
    test:assertEquals(lines[0], "line1");
    test:assertEquals(lines[1], "line2");
    test:assertEquals(lines[2], "line3");
}

@test:Config
function testSplitLinesWithEmptyLines() {
    string content = "line1\n\nline3";
    string[] lines = splitLines(content);
    test:assertEquals(lines.length(), 3);
    test:assertEquals(lines[0], "line1");
    test:assertEquals(lines[1], "");
    test:assertEquals(lines[2], "line3");
}

@test:Config
function testSplitLinesSingleLine() {
    string content = "single line";
    string[] lines = splitLines(content);
    test:assertEquals(lines.length(), 1);
    test:assertEquals(lines[0], "single line");
}

@test:Config
function testResolveVariablesWithEnvPrefix() returns error? {
    check os:setEnv("TEST_VAR_1", "test_value");
    string content = "Config: ${env:TEST_VAR_1}";
    string result = check resolveVariables(content);
    test:assertEquals(result, "Config: test_value");
}

@test:Config
function testResolveVariablesWithoutPrefix() returns error? {
    check os:setEnv("TEST_VAR_2", "another_value");
    string content = "Value: ${TEST_VAR_2}";
    string result = check resolveVariables(content);
    test:assertEquals(result, "Value: another_value");
}

@test:Config
function testResolveVariablesMissingEnvVar() {
    string content = "Config: ${NONEXISTENT_VAR_XYZ}";
    string|error result = resolveVariables(content);
    if result is string {
        test:assertFail("Expected error for missing environment variable");
    }
    test:assertEquals(result.message(), "Environment variable 'NONEXISTENT_VAR_XYZ' not found");
}

@test:Config
function testResolveVariablesSkipsHttpVariables() returns error? {
    // http: variables should NOT be resolved here - they're handled by webhook template compilation
    string content = "Webhook: ${http:payload.field}";
    string result = check resolveVariables(content);
    test:assertEquals(result, "Webhook: ${http:payload.field}");
}

@test:Config
function testResolveVariablesMultiple() returns error? {
    check os:setEnv("VAR_A", "valueA");
    check os:setEnv("VAR_B", "valueB");
    string content = "${VAR_A} and ${env:VAR_B}";
    string result = check resolveVariables(content);
    test:assertEquals(result, "valueA and valueB");
}

@test:Config
function testResolveVariablesInComment() returns error? {
    check os:setEnv("COMMENT_VAR", "should_not_replace");
    string content = "# This is a comment with ${COMMENT_VAR}";
    string result = check resolveVariables(content);
    test:assertEquals(result, "# This is a comment with ${COMMENT_VAR}");
}

@test:Config
function testContainsHttpVariable() {
    test:assertTrue(containsHttpVariable("${http:payload.field}"));
    test:assertTrue(containsHttpVariable("text ${http:header.auth} more"));
    test:assertFalse(containsHttpVariable("${env:VAR}"));
    test:assertFalse(containsHttpVariable("no variables here"));
}

@test:Config
function testParseAfmWithoutFrontmatter() {
    string content = string `# Role
This is the role.

# Instructions
These are instructions.`;

    AFMRecord|error parsed = parseAfm(content);
    if parsed is AFMRecord {
        test:assertFail("Expected error when parsing AFM without frontmatter");
    }
}

@test:Config
function testParseAfmMinimal() returns error? {
    string content = string `---
spec_version: "0.3.0"
---

# Role
Agent role here.

# Instructions
Agent instructions here.`;

    AFMRecord parsed = check parseAfm(content);
    test:assertEquals(parsed.metadata.spec_version, "0.3.0");
    test:assertEquals(parsed.role, "Agent role here.");
    test:assertEquals(parsed.instructions, "Agent instructions here.");
}

// ============================================
// Interface Validation Tests
// ============================================

@test:Config
function testValidateAndExtractInterfacesSingleConsoleChat() returns error? {
    Interface[] interfaces = [<ConsoleChatInterface>{}];
    var [console, web, webhook] = check validateAndExtractInterfaces(interfaces);
    test:assertTrue(console is ConsoleChatInterface);
    test:assertTrue(web is ());
    test:assertTrue(webhook is ());
}

@test:Config
function testValidateAndExtractInterfacesSingleWebChat() returns error? {
    Interface[] interfaces = [<WebChatInterface>{}];
    var [console, web, webhook] = check validateAndExtractInterfaces(interfaces);
    test:assertTrue(console is ());
    test:assertTrue(web is WebChatInterface);
    test:assertTrue(webhook is ());
}

@test:Config
function testValidateAndExtractInterfacesMixed() returns error? {
    Interface[] interfaces = [
        <ConsoleChatInterface>{},
        <WebChatInterface>{}
    ];
    var [console, web, webhook] = check validateAndExtractInterfaces(interfaces);
    test:assertTrue(console is ConsoleChatInterface);
    test:assertTrue(web is WebChatInterface);
    test:assertTrue(webhook is ());
}

@test:Config
function testValidateAndExtractInterfacesDuplicateConsoleChat() {
    Interface[] interfaces = [
        <ConsoleChatInterface>{},
        <ConsoleChatInterface>{}
    ];
    var result = validateAndExtractInterfaces(interfaces);
    if result !is error {
        test:assertFail("Expected error for duplicate console chat interfaces");
    }
    test:assertEquals(result.message(), "Multiple interfaces of the same type are not supported");
}

@test:Config
function testValidateAndExtractInterfacesDuplicateWebChat() {
    Interface[] interfaces = [
        <WebChatInterface>{},
        <WebChatInterface>{}
    ];
    var result = validateAndExtractInterfaces(interfaces);
    if result !is error {
        test:assertFail("Expected error for duplicate web chat interfaces");
    }
    test:assertEquals(result.message(), "Multiple interfaces of the same type are not supported");
}

// ============================================
// Tool Filtering Tests
// ============================================

@test:Config
function testGetFilteredToolsNoFilter() {
    string[]? result = getFilteredTools(());
    test:assertTrue(result is ());
}

@test:Config
function testGetFilteredToolsEmptyFilter() {
    ToolFilter filter = {};
    string[]? result = getFilteredTools(filter);
    test:assertTrue(result is ());
}

@test:Config
function testGetFilteredToolsAllowOnly() {
    ToolFilter filter = {allow: ["tool1", "tool2"]};
    string[]? result = getFilteredTools(filter);
    if result is () {
        test:assertFail("Expected string[] but got ()");
    }
    test:assertEquals(result.length(), 2);
    test:assertEquals(result[0], "tool1");
    test:assertEquals(result[1], "tool2");
}

@test:Config
function testGetFilteredToolsAllowAndDeny() {
    ToolFilter filter = {
        allow: ["tool1", "tool2", "tool3"],
        deny: ["tool2"]
    };
    string[]? result = getFilteredTools(filter);
    if result is () {
        test:assertFail("Expected string[] but got ()");
    }
    test:assertEquals(result.length(), 2);
    test:assertTrue(result.indexOf("tool1") is int);
    test:assertTrue(result.indexOf("tool3") is int);
    test:assertFalse(result.indexOf("tool2") is int);
}

@test:Config
function testGetFilteredToolsDenyOnly() {
    ToolFilter filter = {deny: ["tool1"]};
    string[]? result = getFilteredTools(filter);
    test:assertTrue(result is ());
}

// ============================================
// Authentication Helper Tests
// ============================================

@test:Config
function testGetApiKeySuccess() returns error? {
    ClientAuthentication auth = {'type: "api-key", "api_key": "test-key-123"};
    string apiKey = check getApiKey(auth);
    test:assertEquals(apiKey, "test-key-123");
}

@test:Config
function testGetApiKeyWrongType() {
    ClientAuthentication auth = {'type: "bearer", "token": "test-token"};
    string|error result = getApiKey(auth);
    if result is string {
        test:assertFail("Expected error for wrong authentication type");
    }
    test:assertEquals(result.message(), "Unsupported authentication type for api-key: bearer");
}

@test:Config
function testGetApiKeyMissingKey() {
    ClientAuthentication auth = {'type: "api-key"};
    string|error result = getApiKey(auth);
    if result is string {
        test:assertFail("Expected error for missing API key");
    }
    test:assertEquals(result.message(), "api_key not found in 'authentication'");
}

@test:Config
function testGetTokenSuccess() returns error? {
    ClientAuthentication auth = {'type: "bearer", "token": "test-token-456"};
    string token = check getToken(auth);
    test:assertEquals(token, "test-token-456");
}

@test:Config
function testGetTokenWrongType() {
    ClientAuthentication auth = {'type: "api-key", "api_key": "test-key"};
    string|error result = getToken(auth);
    if result is string {
        test:assertFail("Expected error for wrong authentication type");
    }
    test:assertEquals(result.message(), "Unsupported authentication type for bearer: api-key");
}

@test:Config
function testGetTokenNoAuth() {
    ClientAuthentication? auth = ();
    string|error result = getToken(auth);
    if result is string {
        test:assertFail("Expected error for null authentication");
    }
    test:assertEquals(result.message(), "No authentication provided");
}

// ============================================
// Webhook Template Tests
// ============================================

@test:Config
function testCompileTemplateLiteral() returns error? {
    string template = "This is a literal string";
    CompiledTemplate compiled = check compileTemplate(template);
    test:assertEquals(compiled.segments.length(), 1);
    TemplateSegment segment = compiled.segments[0];
    if segment !is LiteralSegment {
        test:assertFail("Expected LiteralSegment");
    }
    test:assertEquals(segment.text, "This is a literal string");
}

@test:Config
function testCompileTemplatePayloadVariable() returns error? {
    string template = "Value: ${http:payload.field}";
    CompiledTemplate compiled = check compileTemplate(template);
    test:assertEquals(compiled.segments.length(), 2);
    TemplateSegment seg0 = compiled.segments[0];
    if seg0 !is LiteralSegment {
        test:assertFail("Expected LiteralSegment at index 0");
    }
    test:assertEquals(seg0.text, "Value: ");
    TemplateSegment seg1 = compiled.segments[1];
    if seg1 !is PayloadVariable {
        test:assertFail("Expected PayloadVariable at index 1");
    }
    test:assertEquals(seg1.path, "field");
}

@test:Config
function testCompileTemplateHeaderVariable() returns error? {
    string template = "Auth: ${http:header.Authorization}";
    CompiledTemplate compiled = check compileTemplate(template);
    test:assertEquals(compiled.segments.length(), 2);
    TemplateSegment seg0 = compiled.segments[0];
    if seg0 !is LiteralSegment {
        test:assertFail("Expected LiteralSegment at index 0");
    }
    test:assertEquals(seg0.text, "Auth: ");
    TemplateSegment seg1 = compiled.segments[1];
    if seg1 !is HeaderVariable {
        test:assertFail("Expected HeaderVariable at index 1");
    }
    test:assertEquals(seg1.name, "Authorization");
}

@test:Config
function testCompileTemplateMultipleVariables() returns error? {
    string template = "User ${http:payload.name} from ${http:header.Origin}";
    CompiledTemplate compiled = check compileTemplate(template);
    test:assertEquals(compiled.segments.length(), 4);
    TemplateSegment seg0 = compiled.segments[0];
    if seg0 !is LiteralSegment {
        test:assertFail("Expected LiteralSegment at index 0");
    }
    test:assertEquals(seg0.text, "User ");
    TemplateSegment seg1 = compiled.segments[1];
    if seg1 !is PayloadVariable {
        test:assertFail("Expected PayloadVariable at index 1");
    }
    test:assertEquals(seg1.path, "name");
    TemplateSegment seg2 = compiled.segments[2];
    if seg2 !is LiteralSegment {
        test:assertFail("Expected LiteralSegment at index 2");
    }
    test:assertEquals(seg2.text, " from ");
    TemplateSegment seg3 = compiled.segments[3];
    if seg3 !is HeaderVariable {
        test:assertFail("Expected HeaderVariable at index 3");
    }
    test:assertEquals(seg3.name, "Origin");
}

@test:Config
function testCompileTemplateNonHttpVariable() returns error? {
    string template = "Static: ${env:VAR}";
    CompiledTemplate compiled = check compileTemplate(template);
    test:assertEquals(compiled.segments.length(), 2);
    TemplateSegment seg0 = compiled.segments[0];
    if seg0 !is LiteralSegment {
        test:assertFail("Expected LiteralSegment at index 0");
    }
    test:assertEquals(seg0.text, "Static: ");
    TemplateSegment seg1 = compiled.segments[1];
    if seg1 !is LiteralSegment {
        test:assertFail("Expected LiteralSegment at index 1");
    }
    test:assertEquals(seg1.text, "${env:VAR}");
}

@test:Config
function testEvaluateTemplateLiteral() returns error? {
    CompiledTemplate compiled = {
        segments: [
            {kind: "literal", text: "Hello, World!"}
        ]
    };
    string result = check evaluateTemplate(compiled, {}, ());
    test:assertEquals(result, "Hello, World!");
}

@test:Config
function testEvaluateTemplatePayloadField() returns error? {
    CompiledTemplate compiled = {
        segments: [
            {kind: "literal", text: "Name: "},
            {kind: "payload", path: "name"}
        ]
    };
    json payload = {name: "John Doe", age: 30};
    string result = check evaluateTemplate(compiled, payload, ());
    test:assertEquals(result, "Name: John Doe");
}

@test:Config
function testEvaluateTemplatePayloadEntire() returns error? {
    CompiledTemplate compiled = {
        segments: [
            {kind: "payload", path: ""}
        ]
    };
    json payload = {message: "Hello"};
    string result = check evaluateTemplate(compiled, payload, ());
    test:assertEquals(result, payload.toJsonString());
}

@test:Config
function testEvaluateTemplatePayloadNested() returns error? {
    CompiledTemplate compiled = {
        segments: [
            {kind: "payload", path: "user.name"}
        ]
    };
    json payload = {user: {name: "Alice", id: 123}};
    string result = check evaluateTemplate(compiled, payload, ());
    test:assertEquals(result, "Alice");
}

@test:Config
function testEvaluateTemplateHeader() returns error? {
    CompiledTemplate compiled = {
        segments: [
            {kind: "literal", text: "Auth: "},
            {kind: "header", name: "Authorization"}
        ]
    };
    map<string|string[]> headers = {
        "Authorization": "Bearer token123",
        "Content-Type": "application/json"
    };
    string result = check evaluateTemplate(compiled, {}, headers);
    test:assertEquals(result, "Auth: Bearer token123");
}

@test:Config
function testEvaluateTemplateHeaderCaseInsensitive() returns error? {
    CompiledTemplate compiled = {
        segments: [
            {kind: "header", name: "authorization"}
        ]
    };
    map<string|string[]> headers = {
        "Authorization": "Bearer token"
    };
    string result = check evaluateTemplate(compiled, {}, headers);
    test:assertEquals(result, "Bearer token");
}

@test:Config
function testAccessJsonFieldDotNotation() returns error? {
    json payload = {user: {name: "Bob", address: {city: "NYC"}}};
    json result = check accessJsonField(payload, "user.name");
    test:assertEquals(result, "Bob");
}

@test:Config
function testAccessJsonFieldNestedDotNotation() returns error? {
    json payload = {user: {name: "Bob", address: {city: "NYC"}}};
    json result = check accessJsonField(payload, "user.address.city");
    test:assertEquals(result, "NYC");
}

@test:Config
function testAccessJsonFieldBracketNotationQuoted() returns error? {
    json payload = {"field.with.dots": "value"};
    json result = check accessJsonField(payload, "['field.with.dots']");
    test:assertEquals(result, "value");
}

@test:Config
function testAccessJsonFieldArrayIndex() returns error? {
    json payload = {items: ["first", "second", "third"]};
    json result = check accessJsonField(payload, "items[1]");
    test:assertEquals(result, "second");
}

@test:Config
function testAccessJsonFieldMixed() returns error? {
    json payload = {data: {items: ["a", "b", "c"]}};
    json result = check accessJsonField(payload, "data.items[2]");
    test:assertEquals(result, "c");
}

@test:Config
function testAccessJsonFieldBracketWithArrayAccess() returns error? {
    json payload = {
        "users.list": [
            {"full.name": "Alice"},
            {"full.name": "Bob"},
            {"full.name": "Charlie"}
        ]
    };
    json result = check accessJsonField(payload, "['users.list'][1]['full.name']");
    test:assertEquals(result, "Bob");
}

@test:Config
function testAccessJsonFieldArrayObjectArray() returns error? {
    json payload = [
        {"items": [1, 2, 3]},
        {"items": [4, 5, 6]},
        {"items": [7, 8, 9]}
    ];
    json result = check accessJsonField(payload, "[1].items[2]");
    test:assertEquals(result, 6);
}

@test:Config
function testAccessJsonFieldInvalidPath() {
    json payload = {user: {name: "Alice"}};
    json|error result = accessJsonField(payload, "user.nonexistent");
    if result is json {
        test:assertFail("Expected error for invalid field path");
    }
    test:assertEquals(result.message(), "Field 'nonexistent' not found");
}

@test:Config
function testAccessJsonFieldInvalidArrayIndex() {
    json payload = {items: ["a", "b"]};
    json|error result = accessJsonField(payload, "items[5]");
    if result is json {
        test:assertFail("Expected error for array index out of bounds");
    }
    test:assertEquals(result.message(), "Array index out of bounds: 5");
}

// ============================================
// Template Compilation Edge Cases
// ============================================

@test:Config
function testCompileTemplateMalformedMissingCloseBrace() returns error? {
    // Template with missing closing brace
    // Expected: 2 segments - "Value: " as literal, then "${http:payload.field" as literal
    string template = "Value: ${http:payload.field";
    CompiledTemplate compiled = check compileTemplate(template);

    test:assertEquals(compiled.segments.length(), 2);

    TemplateSegment seg0 = compiled.segments[0];
    if seg0 !is LiteralSegment {
        test:assertFail("Expected LiteralSegment at index 0");
    }
    test:assertEquals(seg0.text, "Value: ");

    TemplateSegment seg1 = compiled.segments[1];
    if seg1 !is LiteralSegment {
        test:assertFail("Expected LiteralSegment at index 1");
    }
    test:assertEquals(seg1.text, "Value: ${http:payload.field");
}

@test:Config
function testCompileTemplateEmptyString() returns error? {
    string template = "";
    CompiledTemplate compiled = check compileTemplate(template);

    // Empty template should have no segments
    test:assertEquals(compiled.segments.length(), 0);
}

@test:Config
function testCompileTemplateOnlyVariable() returns error? {
    string template = "${http:payload.data}";
    CompiledTemplate compiled = check compileTemplate(template);

    test:assertEquals(compiled.segments.length(), 1);
    TemplateSegment seg = compiled.segments[0];
    if seg !is PayloadVariable {
        test:assertFail("Expected PayloadVariable");
    }
    test:assertEquals(seg.path, "data");
}

@test:Config
function testCompileTemplateUnknownPrefix() returns error? {
    // ${http:unknown.field} should be treated as literal (not payload or header)
    string template = "Data: ${http:unknown.field}";
    CompiledTemplate compiled = check compileTemplate(template);

    test:assertEquals(compiled.segments.length(), 2);
    TemplateSegment seg1 = compiled.segments[1];
    if seg1 !is LiteralSegment {
        test:assertFail("Expected LiteralSegment for unknown prefix");
    }
    test:assertEquals(seg1.text, "${http:unknown.field}");
}

@test:Config
function testCompileTemplateInvalidFormat() returns error? {
    // ${http:header} without the required subprefix (should be http:header.name)
    string template = "Value: ${http:header}";
    CompiledTemplate compiled = check compileTemplate(template);

    test:assertEquals(compiled.segments.length(), 2);
    TemplateSegment seg0 = compiled.segments[0];
    if seg0 !is LiteralSegment {
        test:assertFail("Expected LiteralSegment at index 0");
    }
    test:assertEquals(seg0.text, "Value: ");

    TemplateSegment seg1 = compiled.segments[1];
    if seg1 !is LiteralSegment {
        test:assertFail("Expected LiteralSegment for invalid format");
    }
    test:assertEquals(seg1.text, "${http:header}");
}

@test:Config
function testCompileTemplateConsecutiveVariables() returns error? {
    string template = "${http:payload.a}${http:payload.b}";
    CompiledTemplate compiled = check compileTemplate(template);

    test:assertEquals(compiled.segments.length(), 2);
    TemplateSegment seg0 = compiled.segments[0];
    if seg0 !is PayloadVariable {
        test:assertFail("Expected PayloadVariable at index 0");
    }
    test:assertEquals(seg0.path, "a");

    TemplateSegment seg1 = compiled.segments[1];
    if seg1 !is PayloadVariable {
        test:assertFail("Expected PayloadVariable at index 1");
    }
    test:assertEquals(seg1.path, "b");
}

@test:Config
function testCompileTemplateWholePayload() returns error? {
    string template = "Payload: ${http:payload}";
    CompiledTemplate compiled = check compileTemplate(template);

    test:assertEquals(compiled.segments.length(), 2);
    TemplateSegment seg1 = compiled.segments[1];
    if seg1 !is PayloadVariable {
        test:assertFail("Expected PayloadVariable");
    }
    test:assertEquals(seg1.path, "");
}

@test:Config
function testIncompletePayloadAccess() returns error? {
    string template = "Payload: ${http:payload.}";
    CompiledTemplate compiled = check compileTemplate(template);

    test:assertEquals(compiled.segments.length(), 2);
    TemplateSegment seg1 = compiled.segments[1];
    if seg1 !is LiteralSegment {
        test:assertFail("Expected LiteralSegment for incomplete payload access");
    }
    test:assertEquals(seg1.text, "${http:payload.}");
}

// ============================================
// Template Evaluation Edge Cases
// ============================================

@test:Config
function testEvaluateTemplateHeaderMissing() returns error? {
    CompiledTemplate compiled = {
        segments: [
            {kind: "header", name: "NonExistent"}
        ]
    };
    map<string|string[]> headers = {
        "Authorization": "Bearer token"
    };

    // Should return empty string for missing header
    string result = check evaluateTemplate(compiled, {}, headers);
    test:assertEquals(result, "");
}

@test:Config
function testEvaluateTemplateHeaderWithNoHeaders() returns error? {
    CompiledTemplate compiled = {
        segments: [
            {kind: "header", name: "Authorization"}
        ]
    };

    // No headers provided - should return empty string
    string result = check evaluateTemplate(compiled, {}, ());
    test:assertEquals(result, "");
}

@test:Config
function testEvaluateTemplateHeaderArrayValue() returns error? {
    CompiledTemplate compiled = {
        segments: [
            {kind: "header", name: "Accept"}
        ]
    };
    map<string|string[]> headers = {
        "Accept": ["application/json", "text/html"]
    };

    // Should join array values with ", "
    string result = check evaluateTemplate(compiled, {}, headers);
    test:assertEquals(result, "application/json, text/html");
}

@test:Config
function testEvaluateTemplatePayloadFieldMissing() returns error? {
    CompiledTemplate compiled = {
        segments: [
            {kind: "payload", path: "nonexistent.field"}
        ]
    };
    json payload = {name: "test"};

    // Should return empty string for missing field
    string result = check evaluateTemplate(compiled, payload, ());
    test:assertEquals(result, "");
}

@test:Config
function testEvaluateTemplatePayloadFieldNonString() returns error? {
    CompiledTemplate compiled = {
        segments: [
            {kind: "payload", path: "count"}
        ]
    };
    json payload = {count: 42};

    // Should convert non-string values to JSON string
    string result = check evaluateTemplate(compiled, payload, ());
    test:assertEquals(result, "42");
}

@test:Config
function testEvaluateTemplatePayloadFieldObject() returns error? {
    CompiledTemplate compiled = {
        segments: [
            {kind: "payload", path: "user"}
        ]
    };
    json payload = {user: {name: "Alice", age: 30}};

    // Should convert object to JSON string (Ballerina adds spaces after colons)
    string result = check evaluateTemplate(compiled, payload, ());
    test:assertEquals(result, "{\"name\":\"Alice\", \"age\":30}");
}

@test:Config
function testEvaluateTemplateComplexMixed() returns error? {
    CompiledTemplate compiled = {
        segments: [
            {kind: "literal", text: "Request from "},
            {kind: "header", name: "User-Agent"},
            {kind: "literal", text: " with data: "},
            {kind: "payload", path: "message"},
            {kind: "literal", text: " (count: "},
            {kind: "payload", path: "count"},
            {kind: "literal", text: ")"}
        ]
    };
    json payload = {message: "Hello", count: 5};
    map<string|string[]> headers = {
        "User-Agent": "TestClient/1.0"
    };

    string result = check evaluateTemplate(compiled, payload, headers);
    test:assertEquals(result, "Request from TestClient/1.0 with data: Hello (count: 5)");
}

// ============================================
// JSON Field Access Edge Cases
// ============================================

@test:Config
function testAccessJsonFieldEmptyPath() returns error? {
    json payload = {data: "value"};
    json|error result = accessJsonField(payload, "");

    if result is error {
        test:assertFail("Expected success for empty path");
    }
    // Empty path should return the payload itself (based on handleDotNotation logic)
    test:assertEquals(result, payload);
}

@test:Config
function testAccessJsonFieldBracketMissingCloseBrace() {
    json payload = {data: "value"};
    json|error result = accessJsonField(payload, "[field");

    if result is json {
        test:assertFail("Expected error for missing close brace");
    }
    test:assertEquals(result.message(), "Invalid bracket notation in path: [field");
}

@test:Config
function testAccessJsonFieldBracketNonObject() {
    json payload = "string value";
    json|error result = accessJsonField(payload, "['field']");

    if result is json {
        test:assertFail("Expected error for accessing field on non-object");
    }
    test:assertEquals(result.message(), "Cannot access field 'field' on non-object");
}

@test:Config
function testAccessJsonFieldBracketFieldNotFound() {
    json payload = {other: "value"};
    json|error result = accessJsonField(payload, "['missing']");

    if result is json {
        test:assertFail("Expected error for field not found");
    }
    test:assertEquals(result.message(), "Field 'missing' not found");
}

@test:Config
function testAccessJsonFieldArrayInvalidIndex() {
    json payload = {items: ["a", "b"]};
    json|error result = accessJsonField(payload, "items[abc]");

    if result is json {
        test:assertFail("Expected error for invalid array index");
    }
    test:assertEquals(result.message(), "Invalid array index: abc");
}

@test:Config
function testAccessJsonFieldArrayOnNonArray() {
    json payload = {data: "not an array"};
    json|error result = accessJsonField(payload, "data[0]");

    if result is json {
        test:assertFail("Expected error for accessing index on non-array");
    }
    test:assertEquals(result.message(), "Cannot access index 0 on non-array");
}

@test:Config
function testAccessJsonFieldDotOnNonObject() {
    json payload = ["array", "items"];
    json|error result = accessJsonField(payload, "field");

    if result is json {
        test:assertFail("Expected error for accessing field on non-object");
    }
    test:assertEquals(result.message(), "Cannot access field 'field' on non-object");
}

@test:Config
function testAccessJsonFieldMixedNotationInvalidBracket() {
    json payload = {data: {items: [1, 2, 3]}};
    json|error result = accessJsonField(payload, "data.items[");

    if result is json {
        test:assertFail("Expected error for invalid bracket notation");
    }
}

@test:Config
function testAccessJsonFieldMixedNotationFieldNotFound() {
    json payload = {data: {value: 123}};
    json|error result = accessJsonField(payload, "data.missing[0]");

    if result is json {
        test:assertFail("Expected error for field not found in mixed notation");
    }
    test:assertEquals(result.message(), "Field 'missing' not found");
}

@test:Config
function testAccessJsonFieldMixedNotationNonObject() {
    json payload = {data: "string"};
    json|error result = accessJsonField(payload, "data.field[0]");

    if result is json {
        test:assertFail("Expected error for accessing field on non-object in mixed notation");
    }
    // Tries to access 'field' on the string value "string"
    test:assertEquals(result.message(), "Cannot access field 'field' on non-object");
}

@test:Config
function testAccessJsonFieldBracketContinuationWithDot() returns error? {
    json payload = {
        "data": {
            "items": [
                {"name": "first"},
                {"name": "second"}
            ]
        }
    };

    json result = check accessJsonField(payload, "['data'].items[1].name");
    test:assertEquals(result, "second");
}

@test:Config
function testAccessJsonFieldNegativeArrayIndex() {
    json payload = {items: [1, 2, 3]};
    json|error result = accessJsonField(payload, "items[-1]");

    if result is json {
        test:assertFail("Expected error for negative array index");
    }
    test:assertEquals(result.message(), "Array index out of bounds: -1");
}

@test:Config
function testAccessJsonFieldDoubleQuotedKey() returns error? {
    json payload = {"field.name": "value"};
    json result = check accessJsonField(payload, "[\"field.name\"]");
    test:assertEquals(result, "value");
}

// ============================================
// Helper Function Tests
// ============================================

@test:Config
function testHandlePayloadVariableString() returns error? {
    string[] parts = [];
    PayloadVariable segment = {kind: "payload", path: "name"};
    json payload = {name: "Alice"};

    handlePayloadVariable(payload, parts, segment);

    test:assertEquals(parts.length(), 1);
    test:assertEquals(parts[0], "Alice");
}

@test:Config
function testHandlePayloadVariableEntirePayload() returns error? {
    string[] parts = [];
    PayloadVariable segment = {kind: "payload", path: ""};
    json payload = {name: "Bob", age: 25};

    handlePayloadVariable(payload, parts, segment);

    test:assertEquals(parts.length(), 1);
    // Ballerina adds spaces after colons in JSON output
    test:assertEquals(parts[0], "{\"name\":\"Bob\", \"age\":25}");
}

@test:Config
function testHandlePayloadVariableMissingField() returns error? {
    string[] parts = [];
    PayloadVariable segment = {kind: "payload", path: "nonexistent"};
    json payload = {name: "Charlie"};

    handlePayloadVariable(payload, parts, segment);

    // Should add empty string for missing field
    test:assertEquals(parts.length(), 1);
    test:assertEquals(parts[0], "");
}

@test:Config
function testHandlePayloadVariableNonStringValue() returns error? {
    string[] parts = [];
    PayloadVariable segment = {kind: "payload", path: "age"};
    json payload = {age: 30};

    handlePayloadVariable(payload, parts, segment);

    test:assertEquals(parts.length(), 1);
    test:assertEquals(parts[0], "30");
}

// ============================================
// Authentication Mapping Tests
// ============================================

@test:Config
function testMapToHttpClientAuthNoAuth() returns error? {
    http:ClientAuthConfig? result = check mapToHttpClientAuth(());
    test:assertTrue(result is ());
}

@test:Config
function testMapToHttpClientAuthBasic() returns error? {
    ClientAuthentication auth = {
        'type: "Basic",
        "username": "user",
        "password": "pass"
    };

    http:ClientAuthConfig? result = check mapToHttpClientAuth(auth);
    test:assertTrue(result is http:CredentialsConfig);
}

@test:Config
function testMapToHttpClientAuthBearer() returns error? {
    ClientAuthentication auth = {
        'type: "Bearer",
        "token": "test-token"
    };

    http:ClientAuthConfig? result = check mapToHttpClientAuth(auth);
    test:assertTrue(result is http:BearerTokenConfig);
}

@test:Config
function testMapToHttpClientAuthOAuth2NotSupported() {
    ClientAuthentication auth = {
        'type: "oauth2"
    };

    http:ClientAuthConfig|error? result = mapToHttpClientAuth(auth);
    if result is http:ClientAuthConfig? {
        test:assertFail("Expected error for OAuth2 authentication");
    }
    test:assertEquals(result.message(), "OAuth2 authentication not yet supported");
}

@test:Config
function testMapToHttpClientAuthJWTNotSupported() {
    ClientAuthentication auth = {
        'type: "jwt"
    };

    http:ClientAuthConfig|error? result = mapToHttpClientAuth(auth);
    if result is http:ClientAuthConfig? {
        test:assertFail("Expected error for JWT authentication");
    }
    test:assertEquals(result.message(), "JWT authentication not yet supported");
}

@test:Config
function testMapToHttpClientAuthUnsupportedType() {
    ClientAuthentication auth = {
        'type: "custom-auth"
    };

    http:ClientAuthConfig|error? result = mapToHttpClientAuth(auth);
    if result is http:ClientAuthConfig? {
        test:assertFail("Expected error for unsupported authentication type");
    }
    test:assertEquals(result.message(), "Unsupported authentication type: custom-auth");
}
