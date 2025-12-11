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

function attachChatService(http:Listener httpListener, ai:Agent agent, 
                           WebChatInterface webChatInterface, HTTPExposure httpExposure) returns error? {
    http:Service httpService = check new ChatHttpService(agent, webChatInterface);
    return httpListener.attach(httpService, httpExposure.path);
}

service class ChatHttpService {
    *http:Service;

    private final readonly & map<json> inputSchema;
    private final readonly & map<json> outputSchema;
    private final ai:Agent agent;

    function init(ai:Agent agent, WebChatInterface webChatInterface) returns error? {
        self.inputSchema = webChatInterface.signature.input.cloneReadOnly();
        self.outputSchema = webChatInterface.signature.output.cloneReadOnly();
        self.agent = agent;
    }

    resource function post .(@http:Payload json payload) returns json|http:BadRequest|http:InternalServerError {
        json|InputError|AgentError runAgentResult = runAgent(self.agent, payload, self.inputSchema, self.outputSchema);
        if runAgentResult is json {
            return runAgentResult;
        }

        if runAgentResult is InputError {
            return <http:BadRequest> {body: runAgentResult.message()};
        }
        return <http:InternalServerError> {body: runAgentResult.message()};
    }
}
