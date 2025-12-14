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

import ballerina/http;
import ballerina/io;
import ballerina/test;

// Mock counter to track which response to return
int mockInputCounter = 0;
string[] mockInputs = [];

isolated string[] capturedOutput = [];

// Mock HTTP service to simulate WSO2 Model Provider
service /ballerina\-copilot/v2\.0 on new http:Listener(9191) {

    resource function post chat/completions(@http:Payload json payload) returns json|http:InternalServerError {
        // Extract the messages from the request
        json|error messages = payload.messages;
        if messages is error {
            return <http:InternalServerError>{
                body: {"error": "Invalid request format"}
            };
        }

        // Get the last user message
        json[] messageArray = <json[]>messages;
        string userMessage = "";
        foreach json msg in messageArray {
            map<json> msgMap = <map<json>>msg;
            json|error roleValue = msgMap.role;
            if roleValue is string && roleValue == "user" {
                json|error contentValue = msgMap.content;
                if contentValue is string {
                    userMessage = contentValue;
                }
            }
        }

        string mockResponse = getMockLLMResponse(userMessage);

        return {
            "id": "chatcmpl-mock-123",
            "object": "chat.completion",
            "created": 1234567890,
            "model": "test-model",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": mockResponse
                    },
                    "finish_reason": "stop"
                }
            ],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 20,
                "total_tokens": 30
            }
        };
    }
}

// Counter for mock LLM responses
int mockResponseCounter = 0;

// Predefined mock LLM responses
final string[] & readonly mockResponses = [
    "Hello! I'm doing great, thank you for asking. How can I assist you today?",
    "I can help you with a variety of tasks including answering questions, providing information, and having natural conversations. Feel free to ask me anything!"
];

// Generate mock LLM responses by index
function getMockLLMResponse(string userMessage) returns string {
    if mockResponseCounter < mockResponses.length() {
        string response = mockResponses[mockResponseCounter];
        mockResponseCounter += 1;
        return response;
    }
    // Fallback response if we run out of predefined responses
    return string `I received your message: "${userMessage}". I'm here to help you with any questions or tasks you might have.`;
}

@test:Mock {
    functionName: "readUserInput"
}
function mockReadUserInput() returns string {
    if mockInputCounter < mockInputs.length() {
        string input = mockInputs[mockInputCounter];
        mockInputCounter += 1;
        return input;
    }
    return "exit"; // Default to exit if we run out of inputs
}

@test:Mock {
    moduleName: "ballerina/io",
    functionName: "println"
}
isolated function mockPrintln(io:Printable... values) {
    final string output = from var val in values select <string> checkpanic val;
    lock {
        capturedOutput[capturedOutput.length()] = output;
    }
}

@test:Mock {
    moduleName: "ballerina/io",
    functionName: "print"
}
isolated function mockPrint(io:Printable... values) {
    final string output = from var val in values select <string> checkpanic val;
    lock {
        capturedOutput[capturedOutput.length()] = output;
    }
}

@test:Config
function testConsoleChatEndToEnd() returns error? {
    // Reset captured output and counters
    lock {
        capturedOutput = [];
    }
    mockInputCounter = 0;
    mockResponseCounter = 0;

    // Set up mock inputs for the interactive chat
    // Simulate a conversation: greeting -> question -> exit
    mockInputs = [
        "Hello! How are you?",
        "What can you help me with?",
        "exit"
    ];

    // Call the main function with the sample AFM file
    // This will use the mock HTTP service for LLM calls and mocked user input
    error? result = main("tests/sample_consolechat_agent.afm.md");
    test:assertTrue(result is (), "Main function should complete without errors");

    // Verify all mock inputs were consumed
    test:assertEquals(mockInputCounter, mockInputs.length(),
        "All mock inputs should have been processed");

    // Get captured output
    string[] outputs;
    lock {
        outputs = capturedOutput.clone();
    }

    // Assert we have expected number of output calls
    // Output structure: banner lines (4) + prompt + thinking + clear + response (repeated 2x) + prompt + goodbye + count
    test:assertTrue(outputs.length() >= 10,
        string `Should have at least 10 output lines, got ${outputs.length()}`);

    // Verify output by exact array indices
    // Welcome banner lines
    test:assertEquals(outputs[0], "╔════════════════════════════════════════╗");
    test:assertEquals(outputs[1], "║     Interactive Console Chat           ║");
    test:assertEquals(outputs[2], "╚════════════════════════════════════════╝");
    test:assertTrue(outputs[3].includes("help"));

    // First message interaction
    test:assertEquals(outputs[4], "\n> ");
    test:assertEquals(outputs[5], "[Thinking...]");
    test:assertEquals(outputs[6], "\r             \r");
    test:assertEquals(outputs[7], "Agent: Hello! I'm doing great, thank you for asking. How can I assist you today?");

    // Second message interaction
    test:assertEquals(outputs[8], "\n> ");
    test:assertEquals(outputs[9], "[Thinking...]");
    test:assertEquals(outputs[10], "\r             \r");
    test:assertEquals(outputs[11], "Agent: I can help you with a variety of tasks including answering questions, providing information, and having natural conversations. Feel free to ask me anything!");

    // Exit and goodbye
    test:assertEquals(outputs[12], "\n> ");
    test:assertTrue(outputs[13].includes("Goodbye"));
    test:assertTrue(outputs[14].includes("You exchanged 2 message"));
}


