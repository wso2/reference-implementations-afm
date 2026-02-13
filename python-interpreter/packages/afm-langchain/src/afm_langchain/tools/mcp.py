# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from __future__ import annotations

import logging

import httpx
from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.sessions import StreamableHttpConnection

from afm.exceptions import (
    MCPAuthenticationError,
    MCPConnectionError,
    MCPError,
)
from afm.models import (
    AFMRecord,
    ClientAuthentication,
    MCPServer,
    ToolFilter,
)

logger = logging.getLogger(__name__)


class BearerAuth(httpx.Auth):
    def __init__(self, token: str) -> None:
        self.token = token

    def auth_flow(self, request: httpx.Request):
        request.headers["Authorization"] = f"Bearer {self.token}"
        yield request


class ApiKeyAuth(httpx.Auth):
    def __init__(self, api_key: str, header_name: str = "Authorization") -> None:
        self.api_key = api_key
        self.header_name = header_name

    def auth_flow(self, request: httpx.Request):
        request.headers[self.header_name] = self.api_key
        yield request


def build_httpx_auth(auth: ClientAuthentication | None) -> httpx.Auth | None:
    if auth is None:
        return None

    auth_type = auth.type.lower()

    if auth_type == "bearer":
        if auth.token is None:
            raise MCPAuthenticationError("Bearer auth requires 'token' field")
        return BearerAuth(auth.token)

    elif auth_type == "basic":
        if auth.username is None or auth.password is None:
            raise MCPAuthenticationError(
                "Basic auth requires 'username' and 'password' fields"
            )
        return httpx.BasicAuth(auth.username, auth.password)

    elif auth_type == "api-key":
        if auth.api_key is None:
            raise MCPAuthenticationError("API key auth requires 'api_key' field")
        return ApiKeyAuth(auth.api_key)

    elif auth_type in ("oauth2", "jwt"):
        raise MCPAuthenticationError(
            f"Authentication type '{auth_type}' not yet supported"
        )

    else:
        raise MCPAuthenticationError(f"Unsupported authentication type: {auth_type}")


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
        url: str,
        authentication: ClientAuthentication | None = None,
        tool_filter: ToolFilter | None = None,
    ) -> None:
        """Initialize an MCP client."""
        self.name = name
        self.url = url
        self.authentication = authentication
        self.tool_filter = tool_filter
        self._tools: list[BaseTool] | None = None

    @classmethod
    def from_mcp_server(cls, server: MCPServer) -> "MCPClient":
        transport = server.transport

        if transport.type != "http":
            raise MCPError(
                f"Unsupported transport type: {transport.type}. Only 'http' is supported for now.",
                server_name=server.name,
            )

        return cls(
            name=server.name,
            url=transport.url,
            authentication=transport.authentication,
            tool_filter=server.tool_filter,
        )

    def _build_connection_config(self) -> StreamableHttpConnection:
        config: StreamableHttpConnection = {
            "transport": "streamable_http",
            "url": self.url,
        }

        # Add authentication if configured
        auth = build_httpx_auth(self.authentication)
        if auth is not None:
            config["auth"] = auth

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
    def __init__(self, servers: list[MCPServer]) -> None:
        """Initialize the MCP manager."""
        self._servers = servers
        self._clients: list[MCPClient] = []
        self._tools: list[BaseTool] | None = None

        # Create clients for each server
        for server in servers:
            try:
                client = MCPClient.from_mcp_server(server)
                self._clients.append(client)
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

        return cls(mcp_servers)

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
