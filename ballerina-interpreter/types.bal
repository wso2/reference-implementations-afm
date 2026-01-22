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

type Provider record {|
    string name?;
    string url?;
|};

type Model record {|
    string name?;
    string provider?;
    string url?;
    ClientAuthentication authentication?;
|};

enum TransportType {
    http
}

type Transport record {|
    http 'type = http;
    string url;
    ClientAuthentication authentication?;
|};

type ClientAuthentication record {
    string 'type;
};

type ToolFilter record {|
    string[] allow?;
    string[] deny?;
|};

type MCPServer record {|
    string name;
    Transport transport;
    ToolFilter tool_filter?;
|};

type Tools record {|
    MCPServer[] mcp?;
|};

type Parameter record {| 
    string name;
    string 'type;
    string description?;
    boolean required?;
|};

type JSONSchema record {| 
    string 'type;
    map<JSONSchema>? properties?;
    string[]? required?;
    JSONSchema? items?;
    string? description?;
|};

type Signature record {| 
    JSONSchema input = { 'type: "string" };
    JSONSchema output = { 'type: "string" };
|};

type HTTPExposure record {|
    string path;
|};

// type AgentCard record {|
//     string name?;
//     string description?;
//     string icon?;
// |};

// type A2AExposure record {|
//     boolean discoverable?;
//     AgentCard agent_card?;
// |};

type Exposure record {|
    HTTPExposure http?;
    // A2AExposure a2a?;
|};

enum InterfaceType {
    CONSOLE_CHAT = "consolechat",
    WEB_CHAT = "webchat",
    WEBHOOK = "webhook"
}

type Subscription record {|
    string protocol;
    string hub?;
    string topic?;
    string callback?;
    string secret?;
    ClientAuthentication authentication?;
|};

type WebChatInterface record {|
    WEB_CHAT 'type = WEB_CHAT;
    Signature signature = {};
    Exposure exposure = {http: {path: "/chat"}};
|};

type ConsoleChatInterface record {|
    CONSOLE_CHAT 'type = CONSOLE_CHAT;
    Signature signature = {};
|};

type WebhookInterface record {|
    WEBHOOK 'type = WEBHOOK;
    string prompt?;
    Signature signature = {};
    Exposure exposure = {http: {path: "/webhook"}};
    Subscription subscription;
|};

type Interface WebChatInterface|ConsoleChatInterface|WebhookInterface;

type AgentMetadata record {|
    string spec_version?;
    string name?;
    string description?;
    string 'version?;
    string author?;
    string[] authors?;
    string icon_url?;
    Provider provider?;
    string license?;
    Model model?;
    Interface[] interfaces?;
    Tools tools?;
    int max_iterations?;
|};

type AFMRecord record {|
    AgentMetadata metadata;
    string role;
    string instructions;
|};

type LiteralSegment readonly & record {|
    "literal" kind;
    string text;
|};

type PayloadVariable readonly & record {|
    "payload" kind;
    string path;  // Empty string means entire payload
|};

type HeaderVariable readonly & record {|
    "header" kind;
    string name;
|};

type TemplateSegment LiteralSegment|PayloadVariable|HeaderVariable;

type CompiledTemplate readonly & record {|
    TemplateSegment[] segments;
|};
