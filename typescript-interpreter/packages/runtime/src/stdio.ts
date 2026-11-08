// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
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


import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import { CONNECT_TIMEOUT_MS, type HttpMcpServer, type McpConnection, toolsFromClient } from "./mcp";

export interface StdioMcpServer {
  transport: { command: string; args?: string[]; env?: Record<string, string> };
  tool_filter?: HttpMcpServer["tool_filter"];
}

export function stdioTools({ transport, tool_filter }: StdioMcpServer): Promise<McpConnection> {
  const connect = () =>
    createMCPClient({
      transport: new StdioMCPTransport(transport),
      initializationOptions: { timeout: CONNECT_TIMEOUT_MS },
      clientName: "afm",
    });
  return toolsFromClient(connect, tool_filter);
}
