import ballerina/io;
import ballerina/test;
import ballerina/os;

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


