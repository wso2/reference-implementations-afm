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

import ballerina/ai;
import ballerina/http;
import ballerina/lang.regexp;
import ballerina/log;
import ballerina/websub;

function attachWebhookService(websub:Listener websubListener, ai:Agent agent, WebhookInterface webhookInterface,
                              HTTPExposure httpExposure) returns error? {
    Subscription subscription = webhookInterface.subscription;
    log:printInfo(string `Webhook subscription configured: ${subscription.protocol} protocol`);

    // Compile the prompt template once if provided
    string? promptTemplate = webhookInterface.prompt;
    final readonly & CompiledTemplate? compiledPrompt = promptTemplate is string
        ? check compileTemplate(promptTemplate)
        : ();

    // Doesn't work due to a bug.
    // Subscription {hub, topic, callback, secret, authentication} = subscription;

    // Can't specify inline due to a bug.
    http:ClientAuthConfig? auth = check mapToHttpClientAuth(subscription.authentication);

    websub:SubscriberService webhookService =
        @websub:SubscriberServiceConfig {
            target: [subscription.hub, subscription.topic],
            secret: subscription.secret,
            httpConfig: {
                auth
            },
            callback: subscription.callback
        }
        isolated service object {
            remote function onEventNotification(readonly & websub:ContentDistributionMessage msg)
                    returns websub:Acknowledgement|error {
                json payload = msg.content.toJson();

                json agentInput = compiledPrompt is CompiledTemplate ?
                    check evaluateTemplate(<CompiledTemplate> compiledPrompt, payload, msg.headers) :
                    payload;

                // TODO: revisit the result handling
                json result = check runAgent(agent, agentInput);
                log:printInfo("Webhook payload handled: " + result.toJsonString());
                return websub:ACKNOWLEDGEMENT;
            }
        };

    return websubListener.attach(webhookService, httpExposure.path);
}

function compileTemplate(string template) returns CompiledTemplate|error {
    TemplateSegment[] segments = [];
    int startPos = 0;

    while true {
        int? dollarPos = template.indexOf("${", startPos);
        if dollarPos is () {
            // No more variables, add remaining text as literal
            if startPos < template.length() {
                segments.push({kind: "literal", text: template.substring(startPos)});
            }
            break;
        }

        // Add literal text before the variable
        if dollarPos > startPos {
            segments.push({kind: "literal", text: template.substring(startPos, dollarPos)});
        }

        int? closeBracePos = template.indexOf("}", dollarPos);
        if closeBracePos is () {
            // Malformed template, treat remaining as literal
            segments.push({kind: "literal", text: template.substring(startPos)});
            break;
        }

        // Extract and parse variable expression
        string varExpr = template.substring(dollarPos + 2, closeBracePos);
        int? colonPos = varExpr.indexOf(":");

        if colonPos !is int || varExpr.substring(0, colonPos) != "http" {
            // Not an http: variable, keep as literal (may be static variable)
            segments.push({kind: "literal", text: template.substring(dollarPos, closeBracePos + 1)});
            continue;
        }

        string path = varExpr.substring(colonPos + 1);
        int? subColonPos = path.indexOf(".");

        if subColonPos is int {
            string subPrefix = path.substring(0, subColonPos);
            string subPath = path.substring(subColonPos + 1);

            if subPrefix == "payload" {
                segments.push({kind: "payload", path: subPath});
            } else if subPrefix == "header" {
                segments.push({kind: "header", name: subPath});
            } else {
                // Unknown subprefix, treat as literal
                segments.push({kind: "literal", text: template.substring(dollarPos, closeBracePos + 1)});
            }
        } else {
            // Invalid format, treat as literal
            segments.push({kind: "literal", text: template.substring(dollarPos, closeBracePos + 1)});
        }

        
        startPos = closeBracePos + 1;
    }

    return {segments: segments.cloneReadOnly()};
}

function evaluateTemplate(CompiledTemplate compiled, json payload, map<string|string[]>? headers) returns string|error {
    string[] parts = [];

    foreach TemplateSegment segment in compiled.segments {
        if segment is LiteralSegment {
            parts.push(segment.text);
            continue;
        } 
        
        if segment is PayloadVariable {
            handlePayloadVariable(payload, parts, segment);
            continue;
        } 
  
        if headers is () {
            log:printWarn("No HTTP headers available in the webhook message");
            parts.push("");
            continue;
        }

        string headerName = segment.name;
        string|string[]? headerValue = headers[headerName];

        // Try case-insensitive lookup if not found
        if headerValue is () {
            foreach var [key, value] in headers.entries() {
                if key.toLowerAscii() == headerName.toLowerAscii() {
                    headerValue = value;
                    break;
                }
            }
        }

        if headerValue is () {
            log:printWarn(string `Header '${headerName}' not found`);
            parts.push("");
        } else if headerValue is string {
            parts.push(headerValue);
        } else {
            parts.push(string:'join(", ", ...headerValue));
        }
    }

    return string:'join("", ...parts);
}

function handlePayloadVariable(json payload, string[] parts, PayloadVariable segment) {
    if segment.path == "" {
        // ${http:payload} - return entire payload
        parts.push(payload.toJsonString());
        return;
    } 

    // ${http:payload.field} or ${http:payload['field']}
    json|error fieldValue = accessJsonField(payload, segment.path);
    if fieldValue is error {
        log:printWarn(string `Field '${segment.path}' not found in payload`);
        parts.push("");
    } else if fieldValue is string {
        parts.push(fieldValue);
    } else {
        parts.push(fieldValue.toJsonString());
    }
}

// Access a JSON field using dot notation or bracket notation
// Supports: field.nested, field['key'], field[0], etc.
function accessJsonField(json payload, string path) returns json|error {
    // Handle bracket notation like ['field.with.dots'] or [0]
    if path.startsWith("[") {
        return handleBracketNotation(payload, path);
    }

    // Handle dot notation: field.nested.value
    return handleDotNotation(payload, path);
}

function handleBracketNotation(json payload, string path) returns json|error {
    int? closeBracket = path.indexOf("]");
    if closeBracket is () {
        return error(string `Invalid bracket notation in path: ${path}`);
    }

    string bracketContent = path.substring(1, closeBracket);
    string remainingPath = closeBracket + 1 < path.length() ? path.substring(closeBracket + 1) : "";

    // Check if it's an array index or a quoted key
    json nextValue;
    if bracketContent.startsWith("'") || bracketContent.startsWith("\"") {
        nextValue = check handleQuotedKey(payload, bracketContent);
    } else {
        nextValue = check handleArrayIndex(payload, bracketContent);
    }

    // Continue with remaining path if any
    if remainingPath.length() == 0 {
        return nextValue;
    }

    if remainingPath.startsWith(".") {
        remainingPath = remainingPath.substring(1);
    }

    if remainingPath.length() == 0 {
        return nextValue;
    }

    return accessJsonField(nextValue, remainingPath);
}

function handleQuotedKey(json payload, string bracketContent) returns json|error {
    string key = bracketContent.substring(1, bracketContent.length() - 1);

    if !(payload is map<json>) {
        return error(string `Cannot access field '${key}' on non-object`);
    }

    json? value = payload[key];
    if value is () {
        return error(string `Field '${key}' not found`);
    }

    return value;
}

function handleArrayIndex(json payload, string bracketContent) returns json|error {
    int|error index = int:fromString(bracketContent);
    if index is error {
        return error(string `Invalid array index: ${bracketContent}`);
    }

    if payload !is json[] {
        return error(string `Cannot access index ${index} on non-array`);
    }

    if index < 0 || index >= payload.length() {
        return error(string `Array index out of bounds: ${index}`);
    }

    return payload[index];
}

function handleDotNotation(json payload, string path) returns json|error {
    string[] parts = regexp:split(re `\.`, path);
    json current = payload;

    foreach string part in parts {
        if part.length() == 0 {
            continue;
        }

        // Check if this part has bracket notation
        if part.includes("[") {
            current = check handleMixedNotation(current, part);
            continue;
        }

        // Simple field access
        if !(current is map<json>) {
            return error(string `Cannot access field '${part}' on non-object`);
        }

        json? value = current[part];
        if value is () {
            return error(string `Field '${part}' not found`);
        }

        current = value;
    }

    return current;
}

function handleMixedNotation(json current, string part) returns json|error {
    int? bracketPos = part.indexOf("[");
    if bracketPos is () {
        return error(string `Invalid mixed notation in part: ${part}`);
    }

    json nextValue = current;
    if bracketPos > 0 {
        // Access field first
        string fieldName = part.substring(0, bracketPos);

        if !(nextValue is map<json>) {
            return error(string `Cannot access field '${fieldName}' on non-object`);
        }

        json? value = nextValue[fieldName];
        if value is () {
            return error(string `Field '${fieldName}' not found`);
        }

        nextValue = value;
    }

    // Now handle bracket part
    string bracketPart = part.substring(bracketPos);
    return accessJsonField(nextValue, bracketPart);
}
