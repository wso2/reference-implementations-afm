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

import ballerina/ai;
import ballerina/io;

// Wrapper function for io:readln to enable mocking in tests
function readUserInput() returns string {
    return io:readln();
}

function runInteractiveChat(ai:Agent agent) returns error? {
    printWelcomeBanner();

    int messageCount = 0;
    while true {
        // Read user input with enhanced prompt
        io:print("\n> ");
        string userInput = readUserInput();

        // Check for special commands
        string trimmedInput = userInput.trim();
        if trimmedInput == "" {
            continue;
        }

        // Handle special commands
        if trimmedInput.toLowerAscii() == "exit" || trimmedInput.toLowerAscii() == "quit" {
            printGoodbyeMessage(messageCount);
            break;
        }

        if trimmedInput.toLowerAscii() == "help" || trimmedInput == "?" {
            printHelpMessage();
            continue;
        }

        if trimmedInput.toLowerAscii() == "clear" || trimmedInput.toLowerAscii() == "cls" {
            clearScreen();
            printWelcomeBanner();
            continue;
        }

        // Show thinking indicator
        io:print("[Thinking...]");

        // Run the agent
        string|ai:Error response = agent.run(userInput);

        // Clear the thinking indicator line
        io:print("\r             \r");

        if response is ai:Error {
            io:println(string `[ERROR] ${response.message()}`);
            continue;
        }

        // Print agent response with formatting
        io:println(string `Agent: ${response}`);
        messageCount += 1;
    }
}

function printWelcomeBanner() {
    io:println("╔════════════════════════════════════════╗");
    io:println("║     Interactive Console Chat           ║");
    io:println("╚════════════════════════════════════════╝");
    io:println("Type 'help' for commands, 'exit' to quit\n");
}

function printHelpMessage() {
    io:println("\nAvailable Commands:");
    io:println("  help, ?       - Show this help message");
    io:println("  clear, cls    - Clear the screen");
    io:println("  exit, quit    - Exit the chat");
    io:println("\nJust type your message to chat with the agent.");
}

function printGoodbyeMessage(int messageCount) {
    io:println("\n👋 Goodbye!");
    if messageCount > 0 {
        io:println(string `You exchanged ${messageCount} message${messageCount == 1 ? "" : "s"} in this session.`);
    }
}

function clearScreen() {
    // Print multiple newlines to simulate clearing
    foreach int i in 0...50 {
        io:println("");
    }
}
