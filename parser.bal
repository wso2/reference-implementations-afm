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

import ballerina/data.yaml;
import ballerina/os;

function parseAfm(string content) returns AFMRecord|error {
    string resolvedContent = check resolveVariables(content);
    
    string[] lines = splitLines(resolvedContent);
    int length = lines.length();
    
    AgentMetadata? metadata = ();
    int bodyStart = 0;
    
    // Extract and parse YAML frontmatter
    if length > 0 && lines[0].trim() == FRONTMATTER_DELIMITER {
        int i = 1;
        while i < length && lines[i].trim() != FRONTMATTER_DELIMITER {
            i += 1;
        }
        
        if i < length {
            string[] fmLines = [];
            foreach int j in 1 ..< i {
                fmLines.push(lines[j]);
            }
            string yamlContent = string:'join("\n", ...fmLines);
            map<json> intermediate = check yaml:parseString(yamlContent);
            metadata = check intermediate.fromJsonWithType();
            bodyStart = i + 1;
        }
    }
    
    // Extract Role and Instructions sections
    string role = "";
    string instructions = "";
    boolean inRole = false;
    boolean inInstructions = false;
    
    foreach int k in bodyStart ..< length {
        string line = lines[k];
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
        metadata: check metadata.ensureType(),
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
    if containsHttpVariable(afmRecord.role) {
        return error("http: variables are only supported in webhook prompt fields, found in role section");
    }

    if containsHttpVariable(afmRecord.instructions) {
        return error("http: variables are only supported in webhook prompt fields, found in instructions section");
    }

    AgentMetadata {authors, provider, model, interfaces, tools, max_iterations: _, ...rest} = afmRecord.metadata;

    string[] erroredKeys = [];

    foreach [string, string] [k, v] in rest.entries() {
        if containsHttpVariable(<string> v) {
            erroredKeys.push(k);
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
        foreach [string, string] [k, v] in provider.entries() {
            if containsHttpVariable(v) {
                erroredKeys.push("provider." + k);
            }
        }
    }

    if model is Model {
        Model {authentication, ...modelRest} = model;
        foreach [string, string] [k, v] in modelRest.entries() {
            if containsHttpVariable(<string> v) {
                erroredKeys.push("model." + k); 
            }
        }

        if authenticationContainsHttpVariable(authentication) {
            erroredKeys.push("model.authentication");
        }
    }

    if interfaces is Interface[] {
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
    }

    if tools !is () {
        MCPServer[]? mcp = tools.mcp;

        if mcp is MCPServer[] {
            foreach MCPServer server in mcp {
                if containsHttpVariable(server.name) {
                    erroredKeys.push("tools.mcp.name");
                }

                Transport transport = server.transport;
                if containsHttpVariable(transport.url) {
                    erroredKeys.push("tools.mcp.transport.url");
                }

                if authenticationContainsHttpVariable(transport.authentication) {
                    erroredKeys.push("tools.mcp.transport.authentication");
                }

                if toolFilterContainsHttpVariable(server.tool_filter) {
                    erroredKeys.push("tools.mcp.filter");
                }
            }
        }
    }

    if erroredKeys.length() > 0 {
        return error(string `http: variables are only supported in webhook prompt fields, found in metadata fields: ${string:'join(", ", ...erroredKeys)}`);
    }
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
    let HTTPExposure? httpExposure = exposure.http in
        httpExposure is HTTPExposure && 
            containsHttpVariable(httpExposure.path);

function subscriptionContainsHttpVariable(Subscription subscription) returns boolean {
    if containsHttpVariable(subscription.protocol) || 
            containsHttpVariable(subscription.hub) || 
            containsHttpVariable(subscription.topic) {
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

function splitLines(string content) returns string[] {
    string[] result = [];
    string remaining = content;

    while true {
        int? idx = remaining.indexOf("\n");
        if idx is int {
            result.push(remaining.substring(0, idx));
            remaining = remaining.substring(idx + 1);
        } else {
            if remaining.length() > 0 {
                result.push(remaining);
            }
            break;
        }
    }

    return result;
}
