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

import ballerina/data.yaml;
import ballerina/os;

const HTTP_VARIABLE_ALLOWED_PROMPT_FIELDS = "webhook and platformchat prompt fields";

function parseAfm(string content) returns AFMRecord|error {
    string resolvedContent = check resolveVariables(content);

    string[] resolvedLines = splitLines(resolvedContent);
    int firstNonBlank = 0;
    while firstNonBlank < resolvedLines.length() && resolvedLines[firstNonBlank].trim() == "" {
        firstNonBlank += 1;
    }
    if firstNonBlank > 0 {
        resolvedContent = string:'join("\n", ...resolvedLines.slice(firstNonBlank));
        resolvedLines = splitLines(resolvedContent);
    }

    AgentMetadata? metadata = ();
    string body;
    if resolvedLines.length() > 0 && resolvedLines[0].trim() == FRONTMATTER_DELIMITER {
        map<json> frontmatterMap;
        [frontmatterMap, body] = check extractFrontMatter(resolvedContent);
        metadata = check frontmatterMap.fromJsonWithType();
    } else {
        body = resolvedContent;
    }

    // Extract Role and Instructions sections
    string[] bodyLines = splitLines(body);
    string role = "";
    string instructions = "";
    boolean inRole = false;
    boolean inInstructions = false;

    foreach string line in bodyLines {
        string trimmed = line.trim();
        
        if trimmed.startsWith("# ") {
            string heading = trimmed.substring(2).toLowerAscii();
            inRole = heading.startsWith("role");
            inInstructions = heading.startsWith("instructions");
            continue;
        }
        
        if inRole {
            role = role == "" ? line : role + "\n" + line;
        } else if inInstructions {
            instructions = instructions == "" ? line : instructions + "\n" + line;
        }
    }
    
    AFMRecord afmRecord = {
        metadata,
        role: role.trim(),
        instructions: instructions.trim()
    };

    // Validate that http: variables only appear in webhook prompts
    check validateHttpVariables(afmRecord);

    return afmRecord;
}

function resolveVariables(string content) returns string|error {
    string result = content;

    // Simple iterative approach to find and replace ${VAR} patterns
    int startPos = 0;
    while true {
        int? dollarPos = result.indexOf("${", startPos);
        if dollarPos is () {
            break;
        }

        int? closeBracePos = result.indexOf("}", dollarPos);
        if closeBracePos is () {
            break;
        }

        // Check if this variable is in a commented line (YAML comment: #)
        // Find the start of the line containing this variable
        int lineStart = dollarPos;
        while lineStart > 0 && result[lineStart - 1] != "\n" {
            lineStart -= 1;
        }

        // Check if the line starts with # (after whitespace)
        string linePrefix = result.substring(lineStart, dollarPos).trim();
        if linePrefix.startsWith("#") {
            // Skip variables in commented lines
            startPos = closeBracePos + 1;
            continue;
        }

        // Extract variable expression (e.g., "VAR", "env:VAR", "file:path")
        string varExpr = result.substring(dollarPos + 2, closeBracePos);

        // Parse prefix and value
        string prefix = "";
        string varName = varExpr;
        int? colonPos = varExpr.indexOf(":");
        if colonPos is int {
            prefix = varExpr.substring(0, colonPos);
            varName = varExpr.substring(colonPos + 1);
        }

        if prefix == "http" {
            // Skip http: variables - they will be handled by webhook template compilation
            // and validated later to ensure they only appear in webhook prompts
            startPos = closeBracePos + 1;
            continue;
        }

        string resolvedValue;
        if prefix == "" || prefix == "env" {
            // No prefix or env: prefix -> environment variable
            string? envValue = os:getEnv(varName);
            if envValue is () || envValue == "" {
                return error(string `Environment variable '${varName}' not found`);
            }
            resolvedValue = envValue;
        } else {
            return error(string `Unsupported variable prefix '${prefix}:' in '${varExpr}'. Only 'env:' and 'http:' are supported.`);
        }

        string before = result.substring(0, dollarPos);
        string after = result.substring(closeBracePos + 1);
        result = before + resolvedValue + after;
        startPos = before.length() + resolvedValue.length();
    }

    return result;
}

function validateHttpVariables(AFMRecord afmRecord) returns error? {
    check validateRoleAndInstructions(afmRecord);

    AgentMetadata? metadata = afmRecord?.metadata;
    if metadata is () {
        return;
    }

    string[] erroredKeys = collectMetadataFieldErrors(metadata);

    Interface[]? interfaces = metadata?.interfaces;
    if interfaces is Interface[] {
        erroredKeys.push(...collectInterfaceErrors(interfaces));
    }

    Tools? tools = metadata?.tools;
    if tools is Tools {
        erroredKeys.push(...collectToolsErrors(tools));
    }

    SkillSource[]? skills = metadata?.skills;
    if skills is SkillSource[] {
        erroredKeys.push(...collectSkillsErrors(skills));
    }

    if erroredKeys.length() > 0 {
        return error(string `http: variables are only supported in ${HTTP_VARIABLE_ALLOWED_PROMPT_FIELDS}, ` +
                string `found in metadata fields: ${string:'join(", ", ...erroredKeys)}`);
    }
}

function validateRoleAndInstructions(AFMRecord afmRecord) returns error? {
    if containsHttpVariable(afmRecord.role) {
        return error(string `http: variables are only supported in ` +
                string `${HTTP_VARIABLE_ALLOWED_PROMPT_FIELDS}, found in role section`);
    }
    if containsHttpVariable(afmRecord.instructions) {
        return error(string `http: variables are only supported in ` +
                string `${HTTP_VARIABLE_ALLOWED_PROMPT_FIELDS}, found in instructions section`);
    }
}

function collectMetadataFieldErrors(AgentMetadata metadata) returns string[] {
    AgentMetadata {authors, provider, model, interfaces: _, tools: _, skills: _, max_iterations: _, ...rest} = metadata;

    string[] erroredKeys = [];

    foreach [string, json] [key, value] in rest.entries() {
        if jsonContainsHttpVariable(value) {
            erroredKeys.push(key);
        }
    }

    if authors is string[] {
        foreach string author in authors {
            if containsHttpVariable(author) {
                erroredKeys.push("authors");
                break;
            }
        }
    }

    if provider is Provider {
        foreach [string, string] [key, value] in provider.entries() {
            if containsHttpVariable(value) {
                erroredKeys.push("provider." + key);
            }
        }
    }

    if model is Model {
        Model {authentication, ...modelRest} = model;
        foreach [string, anydata] [key, value] in modelRest.entries() {
            if jsonContainsHttpVariable(value.toJson()) {
                erroredKeys.push("model." + key);
            }
        }

        if authenticationContainsHttpVariable(authentication) {
            erroredKeys.push("model.authentication");
        }
    }

    return erroredKeys;
}

function collectInterfaceErrors(Interface[] interfaces) returns string[] {
    string[] erroredKeys = [];

    foreach Interface interface in interfaces {
        if interface is ConsoleChatInterface {
            if signatureContainsHttpVariable(interface.signature) {
                erroredKeys.push("interfaces.consolechat.signature");
            }
            continue;
        }

        if interface is WebChatInterface {
            if signatureContainsHttpVariable(interface.signature) {
                erroredKeys.push("interfaces.webchat.signature");
            }
            if exposureContainsHttpVariable(interface.exposure) {
                erroredKeys.push("interfaces.webchat.exposure");
            }
            continue;
        }

        if interface is PlatformChatInterface {
            if containsHttpVariable(interface.platform) {
                erroredKeys.push("interfaces.platformchat.platform");
            }

            if interface is NonPollingPlatformChatInterface {
                if signatureContainsHttpVariable(interface.signature) {
                    erroredKeys.push("interfaces.platformchat.signature");
                }

                if exposureContainsHttpVariable(interface.exposure) {
                    erroredKeys.push("interfaces.platformchat.exposure");
                }
            } else if authenticationContainsHttpVariable(interface?.authentication) {
                erroredKeys.push("interfaces.platformchat.authentication");
            }

            SlackConfig|GChatConfig|TelegramConfig? platformConfig = interface?.platform_config;
            if platformConfig !is () && jsonContainsHttpVariable(platformConfig.toJson()) {
                erroredKeys.push("interfaces.platformchat.platform_config");
            }
            continue;
        }

        if signatureContainsHttpVariable(interface.signature) {
            erroredKeys.push("interfaces.webhook.signature");
        }
        if exposureContainsHttpVariable(interface.exposure) {
            erroredKeys.push("interfaces.webhook.exposure");
        }
        if subscriptionContainsHttpVariable(interface.subscription) {
            erroredKeys.push("interfaces.webhook.subscription");
        }
    }

    return erroredKeys;
}

function collectToolsErrors(Tools tools) returns string[] {
    string[] erroredKeys = [];

    MCPServer[]? mcp = tools.mcp;
    if mcp !is MCPServer[] {
        return erroredKeys;
    }

    foreach MCPServer server in mcp {
        if containsHttpVariable(server.name) {
            erroredKeys.push("tools.mcp.name");
        }

        Transport transport = server.transport;
        if transport is HttpTransport {
            if containsHttpVariable(transport.url) {
                erroredKeys.push("tools.mcp.transport.url");
            }
            if authenticationContainsHttpVariable(transport.authentication) {
                erroredKeys.push("tools.mcp.transport.authentication");
            }
        } else {
            if containsHttpVariable(transport.command) {
                erroredKeys.push("tools.mcp.transport.command");
            }

            string[]? args = transport.args;
            if args is string[] {
                foreach int idx in 0 ..< args.length() {
                    if containsHttpVariable(args[idx]) {
                        erroredKeys.push(string `tools.mcp.transport.args[${idx}]`);
                    }
                }
            }

            map<string>? env = transport.env;
            if env is map<string> {
                foreach [string, string] [key, value] in env.entries() {
                    if containsHttpVariable(value) {
                        erroredKeys.push("tools.mcp.transport.env." + key);
                    }
                }
            }
        }

        if toolFilterContainsHttpVariable(server.tool_filter) {
            erroredKeys.push("tools.mcp.filter");
        }
    }

    return erroredKeys;
}

function collectSkillsErrors(SkillSource[] skills) returns string[] {
    string[] erroredKeys = [];
    foreach SkillSource skillSource in skills {
        if containsHttpVariable(skillSource.path) {
            erroredKeys.push("skills.path");
        }
    }
    return erroredKeys;
}

function containsHttpVariable(string content) returns boolean =>
    content.indexOf("${http:") != ();

function authenticationContainsHttpVariable(ClientAuthentication? authentication) returns boolean {
    if authentication is () {
        return false;
    }

    foreach anydata value in authentication {
        if value is string && containsHttpVariable(value) {
            return true;
        }
    }
    return false;
}

function signatureContainsHttpVariable(Signature signature) returns boolean =>
    jsonSchemaContainsHttpVariable(signature.input) || jsonSchemaContainsHttpVariable(signature.output);

function jsonSchemaContainsHttpVariable(JSONSchema schema) returns boolean {
    if containsHttpVariable(schema.'type) {
        return true;
    }

    map<JSONSchema>? properties = schema?.properties;
    if properties is map<JSONSchema> {
        foreach JSONSchema propSchema in properties {
            if jsonSchemaContainsHttpVariable(propSchema) {
                return true;
            }
        }
    }

    string[]? required = schema?.required;
    if required is string[] {
        foreach string reqField in required {
            if containsHttpVariable(reqField) {
                return true;
            }
        }
    }

    JSONSchema? items = schema?.items;
    if items is JSONSchema {
        if jsonSchemaContainsHttpVariable(items) {
            return true;
        }
    }

    string? description = schema?.description;
    if description is string {
        if containsHttpVariable(description) {
            return true;
        }
    }
    return false;
}

function exposureContainsHttpVariable(Exposure exposure) returns boolean =>
    containsHttpVariable(exposure.http.path);

function subscriptionContainsHttpVariable(Subscription subscription) returns boolean {
    if containsHttpVariable(subscription.protocol) {
        return true;
    }

    string? hub = subscription.hub;
    if hub is string && containsHttpVariable(hub) {
        return true;
    }

    string? topic = subscription.topic;
    if topic is string && containsHttpVariable(topic) {
        return true;
    }

    string? callback = subscription.callback;
    if callback is string && containsHttpVariable(callback) {
        return true;
    }

    string? secret = subscription.secret;
    if secret is string && containsHttpVariable(secret) {
        return true;
    }

    if authenticationContainsHttpVariable(subscription.authentication) {
        return true;
    }

    return false;
}

function toolFilterContainsHttpVariable(ToolFilter? filter) returns boolean {
    if filter is () {
        return false;
    }

    foreach string value in [...filter.allow ?: [], ...filter.deny ?: []] {
        if containsHttpVariable(value) {
            return true;
        }
    }
    return false;
}

function jsonContainsHttpVariable(json value) returns boolean {
    if value is string {
        return containsHttpVariable(value);
    }
    if value is map<json> {
        foreach json v in value {
            if jsonContainsHttpVariable(v) {
                return true;
            }
        }
        return false;
    }
    if value is json[] {
        foreach json v in value {
            if jsonContainsHttpVariable(v) {
                return true;
            }
        }
        return false;
    }
    return false;
}

// Extracts YAML frontmatter and the remaining body from a document delimited by `---`.
// Returns the parsed YAML as a map and the body text after the closing delimiter.
function extractFrontMatter(string content) returns [map<json>, string]|error {
    string[] lines = splitLines(content);
    int length = lines.length();

    if length == 0 || lines[0].trim() != FRONTMATTER_DELIMITER {
        return error("Document must start with YAML frontmatter (---)");
    }

    int i = 1;
    while i < length && lines[i].trim() != FRONTMATTER_DELIMITER {
        i += 1;
    }

    if i >= length {
        return error("Frontmatter is not closed (missing ---)");
    }

    string yamlContent = string:'join("\n", ...lines.slice(1, i));
    map<json> frontmatter = check yaml:parseString(yamlContent);
    string body = string:'join("\n", ...lines.slice(i + 1));
    return [frontmatter, body];
}

function splitLines(string content) returns string[] {
    string[] result = [];
    int length = content.length();
    int 'start = 0;

    while 'start < length {
        int? idx = content.indexOf("\n", 'start);
        if idx is int {
            result.push(content.substring('start, idx));
            'start = idx + 1;
        } else {
            result.push(content.substring('start));
            break;
        }
    }

    return result;
}
