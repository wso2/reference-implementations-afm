# Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com).
#
# WSO2 LLC. licenses this file to you under the Apache License,
# Version 2.0 (the "License"); you may not use this file except
# in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

from __future__ import annotations

import logging
from pathlib import Path

import httpx
from afm.exceptions import (
    AuthenticationError,
    MCPAuthenticationError,
    MCPConnectionError,
    MCPError,
)
from afm.http_auth import build_httpx_auth
from afm.models import (
    AFMRecord,
    HttpTransport,
    MCPServer,
    StdioTransport,
    ToolFilter,
)
from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.sessions import StdioConnection, StreamableHttpConnection

logger = logging.getLogger(__name__)


def filter_tools(
    tools: list[BaseTool],
    tool_filter: ToolFilter | None,
) -> list[BaseTool]:
    if tool_filter is None:
        return tools

    allow = tool_filter.allow
    deny = tool_filter.deny

    # No filters specified
    if allow is None and deny is None:
        return tools

    # Build a set of tool names for efficient lookup
    tool_names = {tool.name for tool in tools}

    if allow is not None:
        # Start with allowed tools only
        allowed_set = set(allow) & tool_names
    else:
        # Start with all tools
        allowed_set = tool_names

    if deny is not None:
        # Remove denied tools
        allowed_set -= set(deny)

    # Filter the tools list maintaining order
    return [tool for tool in tools if tool.name in allowed_set]


class MCPClient:
    def __init__(
        self,
        name: str,
        transport: HttpTransport | StdioTransport,
        tool_filter: ToolFilter | None = None,
        auth: httpx.Auth | None = None,
    ) -> None:
        """Initialize an MCP client."""
        self.name = name
        self.transport = transport
        self.tool_filter = tool_filter
        self.auth = auth
        self._tools: list[BaseTool] | None = None

    @classmethod
    def from_mcp_server(
        cls, server: MCPServer, base_dir: Path | None = None
    ) -> "MCPClient":
        transport = server.transport

        if not isinstance(transport, (HttpTransport, StdioTransport)):
            raise MCPError(
                f"Unsupported transport type: {transport.type}",
                server_name=server.name,
            )

        auth = None
        if isinstance(transport, HttpTransport):
            try:
                auth = build_httpx_auth(
                    transport.authentication,
                    base_dir=base_dir,
                    mcp_url=transport.url,
                )
            except AuthenticationError as e:
                raise MCPAuthenticationError(str(e), server_name=server.name) from None

        return cls(
            name=server.name,
            transport=transport,
            tool_filter=server.tool_filter,
            auth=auth,
        )

    def _build_connection_config(self) -> StreamableHttpConnection | StdioConnection:
        if isinstance(self.transport, HttpTransport):
            config: StreamableHttpConnection = {
                "transport": "streamable_http",
                "url": self.transport.url,
            }
            if self.auth is not None:
                config["auth"] = self.auth
            return config

        else:
            config: StdioConnection = {
                "transport": "stdio",
                "command": self.transport.command,
                "args": self.transport.args or [],
            }
            if self.transport.env is not None:
                config["env"] = self.transport.env
            return config

    async def get_tools(self) -> list[BaseTool]:
        try:
            # Create a client for just this server
            client = MultiServerMCPClient({self.name: self._build_connection_config()})

            # Get tools from the server
            tools = await client.get_tools(server_name=self.name)

            # Apply filtering
            filtered_tools = filter_tools(tools, self.tool_filter)

            logger.info(
                f"MCP server '{self.name}': loaded {len(filtered_tools)} tools "
                f"(filtered from {len(tools)})"
            )

            return filtered_tools

        except MCPError:
            # Re-raise MCPError subclasses (like MCPAuthenticationError) to preserve diagnostics
            raise
        except Exception as e:
            raise MCPConnectionError(
                f"Failed to connect: {e}",
                server_name=self.name,
            ) from e


class MCPManager:
    def __init__(self, servers: list[MCPServer], base_dir: Path | None = None) -> None:
        """Initialize the MCP manager."""
        self._servers = servers
        self._clients: list[MCPClient] = []
        self._tools: list[BaseTool] | None = None

        # Create clients for each server
        for server in servers:
            try:
                client = MCPClient.from_mcp_server(server, base_dir)
                self._clients.append(client)
            except MCPAuthenticationError:
                raise
            except MCPError as e:
                logger.warning(f"Skipping MCP server: {e}")

    @classmethod
    def from_afm(cls, afm: AFMRecord) -> "MCPManager | None":
        tools_config = afm.metadata.tools
        if tools_config is None:
            return None

        mcp_servers = tools_config.mcp
        if mcp_servers is None or len(mcp_servers) == 0:
            return None

        return cls(mcp_servers, base_dir=afm.source_dir)

    @property
    def server_names(self) -> list[str]:
        return [client.name for client in self._clients]

    async def get_tools(self) -> list[BaseTool]:
        if self._tools is not None:
            return self._tools

        all_tools: list[BaseTool] = []
        errors: list[str] = []

        # Get tools from each client individually to handle per-server filtering
        for client in self._clients:
            try:
                tools = await client.get_tools()
                all_tools.extend(tools)
            except MCPConnectionError as e:
                errors.append(str(e))
                logger.error(f"Failed to get tools from server '{client.name}': {e}")

        if errors and not all_tools:
            raise MCPConnectionError(
                f"Failed to connect to any MCP server: {'; '.join(errors)}"
            )

        # Only cache if all servers succeeded; partial results are not
        # cached so that failed servers can be retried on the next call.
        if not errors:
            self._tools = all_tools

        return all_tools

    def clear_cache(self) -> None:
        self._tools = None
