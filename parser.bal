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
import ballerina/log;
import ballerina/os;

function parseAfm(string content) returns AFMRecord|error {
    string resolvedContent = resolveVariables(content);
    
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
    
    return {
        metadata: check metadata.ensureType(),
        role: role.trim(),
        instructions: instructions.trim()
    };
}

function resolveVariables(string content) returns string {
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
        
        // Extract variable name
        string varName = result.substring(dollarPos + 2, closeBracePos);
        
        // Try to resolve from environment
        string? envValue = os:getEnv(varName);
        if envValue is string {
            // Replace the variable with its value
            string before = result.substring(0, dollarPos);
            string after = result.substring(closeBracePos + 1);
            result = before + envValue + after;
            startPos = before.length() + envValue.length();
        } else {
            log:printError(string `Variable ${varName} not found in environment`);
            startPos = closeBracePos + 1;
        }
    }
    
    return result;
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
