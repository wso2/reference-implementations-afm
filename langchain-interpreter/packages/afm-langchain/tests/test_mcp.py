# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from langchain_core.tools import BaseTool

from afm.exceptions import MCPConnectionError, MCPError
from afm.models import (
    AFMRecord,
    AgentMetadata,
    ClientAuthentication,
    MCPServer,
    ToolFilter,
    Tools,
    Transport,
)
from afm_langchain.tools.mcp import (
    ApiKeyAuth,
    BearerAuth,
    MCPClient,
    MCPManager,
    build_httpx_auth,
    filter_tools,
)


def make_mcp_server(
    name: str = "test-server",
    url: str = "http://localhost:8080/mcp",
    auth_type: str | None = None,
    tool_filter: ToolFilter | None = None,
) -> MCPServer:
    auth = None
    if auth_type == "bearer":
        auth = ClientAuthentication(type="bearer", token="test-token")
    elif auth_type == "basic":
        auth = ClientAuthentication(type="basic", username="user", password="pass")
    elif auth_type == "api-key":
        auth = ClientAuthentication(type="api-key", api_key="test-api-key")
    elif auth_type == "oauth2":
        auth = ClientAuthentication(type="oauth2")
    elif auth_type == "jwt":
        auth = ClientAuthentication(type="jwt")

    return MCPServer(
        name=name,
        transport=Transport(type="http", url=url, authentication=auth),
        tool_filter=tool_filter,
    )


def make_afm_with_mcp(servers: list[MCPServer]) -> AFMRecord:
    return AFMRecord(
        metadata=AgentMetadata(
            name="Test Agent",
            tools=Tools(mcp=servers),
        ),
        role="You are a helpful assistant.",
        instructions="Help the user.",
    )


def make_mock_tool(name: str, description: str = "A test tool") -> MagicMock:
    tool = MagicMock(spec=BaseTool)
    tool.name = name
    tool.description = description
    from pydantic import BaseModel

    class MockArgsSchema(BaseModel):
        pass

    tool.args_schema = MockArgsSchema
    return tool


class TestBuildHttpxAuth:
    def test_none_auth_returns_none(self):
        result = build_httpx_auth(None)
        assert result is None

    def test_bearer_auth_returns_bearer_auth_instance(self):
        auth = ClientAuthentication(type="bearer", token="my-token")
        result = build_httpx_auth(auth)
        assert isinstance(result, BearerAuth)
        assert result.token == "my-token"

    def test_basic_auth_returns_httpx_basic_auth(self):
        auth = ClientAuthentication(type="basic", username="user", password="pass")
        result = build_httpx_auth(auth)
        assert isinstance(result, httpx.BasicAuth)

    def test_api_key_auth_returns_api_key_auth_instance(self):
        auth = ClientAuthentication(type="api-key", api_key="my-api-key")
        result = build_httpx_auth(auth)
        assert isinstance(result, ApiKeyAuth)
        assert result.api_key == "my-api-key"


class TestFilterTools:
    def test_no_filter_returns_all_tools(self):
        tools = [make_mock_tool("tool1"), make_mock_tool("tool2")]
        result = filter_tools(tools, None)
        assert result == tools

    def test_empty_filter_returns_all_tools(self):
        tools = [make_mock_tool("tool1"), make_mock_tool("tool2")]
        tool_filter = ToolFilter()
        result = filter_tools(tools, tool_filter)
        assert result == tools

    def test_allow_only_returns_allowed_tools(self):
        tools = [
            make_mock_tool("tool1"),
            make_mock_tool("tool2"),
            make_mock_tool("tool3"),
        ]
        tool_filter = ToolFilter(allow=["tool1", "tool3"])
        result = filter_tools(tools, tool_filter)
        assert len(result) == 2
        assert result[0].name == "tool1"
        assert result[1].name == "tool3"

    def test_deny_only_returns_all_except_denied(self):
        tools = [
            make_mock_tool("tool1"),
            make_mock_tool("tool2"),
            make_mock_tool("tool3"),
        ]
        tool_filter = ToolFilter(deny=["tool2"])
        result = filter_tools(tools, tool_filter)
        assert len(result) == 2
        assert result[0].name == "tool1"
        assert result[1].name == "tool3"

    def test_allow_and_deny_returns_allowed_minus_denied(self):
        tools = [
            make_mock_tool("tool1"),
            make_mock_tool("tool2"),
            make_mock_tool("tool3"),
            make_mock_tool("tool4"),
        ]
        tool_filter = ToolFilter(allow=["tool1", "tool2", "tool3"], deny=["tool2"])
        result = filter_tools(tools, tool_filter)
        assert len(result) == 2
        assert result[0].name == "tool1"
        assert result[1].name == "tool3"


class TestMCPClient:
    def test_from_mcp_server_creates_client(self):
        server = make_mcp_server(name="test", url="http://localhost:8080/mcp")
        client = MCPClient.from_mcp_server(server)

        assert client.name == "test"
        assert client.url == "http://localhost:8080/mcp"
        assert client.authentication is None
        assert client.tool_filter is None

    def test_from_mcp_server_with_auth(self):
        server = make_mcp_server(name="test", auth_type="bearer")
        client = MCPClient.from_mcp_server(server)

        assert client.authentication is not None
        assert client.authentication.type == "bearer"
        assert client.authentication.token == "test-token"

    def test_from_mcp_server_with_tool_filter(self):
        tool_filter = ToolFilter(allow=["tool1", "tool2"])
        server = make_mcp_server(name="test", tool_filter=tool_filter)
        client = MCPClient.from_mcp_server(server)

        assert client.tool_filter is not None
        assert client.tool_filter.allow == ["tool1", "tool2"]

    def test_from_mcp_server_unsupported_transport_raises_error(self):
        server = MCPServer(
            name="test",
            transport=Transport(type="http", url="http://localhost:8080"),
        )
        # Manually override the type to simulate invalid transport
        object.__setattr__(server.transport, "type", "stdio")

        with pytest.raises(MCPError, match="Unsupported transport type"):
            MCPClient.from_mcp_server(server)

    @pytest.mark.asyncio
    async def test_get_tools_calls_mcp_client(self):
        client = MCPClient(
            name="test-server",
            url="http://localhost:8080/mcp",
        )

        mock_tools = [make_mock_tool("tool1"), make_mock_tool("tool2")]

        with patch("afm_langchain.tools.mcp.MultiServerMCPClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.get_tools.return_value = mock_tools
            MockClient.return_value = mock_instance

            result = await client.get_tools()

            assert len(result) == 2
            mock_instance.get_tools.assert_called_once_with(server_name="test-server")

    @pytest.mark.asyncio
    async def test_get_tools_applies_filtering(self):
        tool_filter = ToolFilter(allow=["tool1"])
        client = MCPClient(
            name="test-server",
            url="http://localhost:8080/mcp",
            tool_filter=tool_filter,
        )

        mock_tools = [make_mock_tool("tool1"), make_mock_tool("tool2")]

        with patch("afm_langchain.tools.mcp.MultiServerMCPClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.get_tools.return_value = mock_tools
            MockClient.return_value = mock_instance

            result = await client.get_tools()

            assert len(result) == 1
            assert result[0].name == "tool1"

    @pytest.mark.asyncio
    async def test_get_tools_connection_error_raises_mcp_error(self):
        client = MCPClient(
            name="test-server",
            url="http://localhost:8080/mcp",
        )

        with patch("afm_langchain.tools.mcp.MultiServerMCPClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.get_tools.side_effect = Exception("Connection refused")
            MockClient.return_value = mock_instance

            with pytest.raises(MCPConnectionError, match="Failed to connect"):
                await client.get_tools()


class TestMCPManager:
    def test_from_afm_with_no_tools_returns_none(self):
        afm = AFMRecord(
            metadata=AgentMetadata(name="Test"),
            role="Role",
            instructions="Instructions",
        )
        manager = MCPManager.from_afm(afm)
        assert manager is None

    def test_from_afm_with_empty_mcp_returns_none(self):
        afm = AFMRecord(
            metadata=AgentMetadata(name="Test", tools=Tools(mcp=[])),
            role="Role",
            instructions="Instructions",
        )
        manager = MCPManager.from_afm(afm)
        assert manager is None

    def test_from_afm_with_mcp_servers_creates_manager(self):
        servers = [
            make_mcp_server(name="server1", url="http://localhost:8081/mcp"),
            make_mcp_server(name="server2", url="http://localhost:8082/mcp"),
        ]
        afm = make_afm_with_mcp(servers)

        manager = MCPManager.from_afm(afm)

        assert manager is not None
        assert len(manager._clients) == 2
        assert manager.server_names == ["server1", "server2"]

    def test_server_names_property(self):
        servers = [
            make_mcp_server(name="alpha"),
            make_mcp_server(name="beta"),
        ]
        manager = MCPManager(servers)

        assert manager.server_names == ["alpha", "beta"]

    @pytest.mark.asyncio
    async def test_get_tools_aggregates_from_all_clients(self):
        servers = [
            make_mcp_server(name="server1"),
            make_mcp_server(name="server2"),
        ]
        manager = MCPManager(servers)

        # Mock each client's get_tools
        with (
            patch.object(
                manager._clients[0], "get_tools", return_value=[make_mock_tool("tool1")]
            ),
            patch.object(
                manager._clients[1], "get_tools", return_value=[make_mock_tool("tool2")]
            ),
        ):
            tools = await manager.get_tools()

        assert len(tools) == 2
        assert tools[0].name == "tool1"
        assert tools[1].name == "tool2"

    @pytest.mark.asyncio
    async def test_get_tools_caches_result(self):
        servers = [make_mcp_server(name="server1")]
        manager = MCPManager(servers)

        with patch.object(
            manager._clients[0], "get_tools", return_value=[make_mock_tool("tool1")]
        ) as mock_get:
            # First call
            tools1 = await manager.get_tools()
            # Second call
            tools2 = await manager.get_tools()

            assert tools1 is tools2
            mock_get.assert_called_once()

    @pytest.mark.asyncio
    async def test_get_tools_continues_on_single_server_failure(self):
        servers = [
            make_mcp_server(name="server1"),
            make_mcp_server(name="server2"),
        ]
        manager = MCPManager(servers)

        with (
            patch.object(
                manager._clients[0],
                "get_tools",
                side_effect=MCPConnectionError(
                    "Connection failed", server_name="server1"
                ),
            ),
            patch.object(
                manager._clients[1], "get_tools", return_value=[make_mock_tool("tool2")]
            ),
        ):
            tools = await manager.get_tools()

        assert len(tools) == 1
        assert tools[0].name == "tool2"

    @pytest.mark.asyncio
    async def test_get_tools_raises_if_all_servers_fail(self):
        servers = [
            make_mcp_server(name="server1"),
            make_mcp_server(name="server2"),
        ]
        manager = MCPManager(servers)

        with (
            patch.object(
                manager._clients[0],
                "get_tools",
                side_effect=MCPConnectionError("Failed 1", server_name="server1"),
            ),
            patch.object(
                manager._clients[1],
                "get_tools",
                side_effect=MCPConnectionError("Failed 2", server_name="server2"),
            ),
        ):
            with pytest.raises(
                MCPConnectionError, match="Failed to connect to any MCP server"
            ):
                await manager.get_tools()

    def test_clear_cache_resets_tools(self):
        manager = MCPManager([make_mcp_server(name="server1")])
        manager._tools = [make_mock_tool("cached")]

        manager.clear_cache()

        assert manager._tools is None

    @pytest.mark.asyncio
    async def test_get_tools_partial_failure_not_cached(self):
        servers = [
            make_mcp_server(name="server1"),
            make_mcp_server(name="server2"),
        ]
        manager = MCPManager(servers)

        # First call: server1 succeeds, server2 fails
        with (
            patch.object(
                manager._clients[0], "get_tools", return_value=[make_mock_tool("tool1")]
            ),
            patch.object(
                manager._clients[1],
                "get_tools",
                side_effect=MCPConnectionError(
                    "Connection failed", server_name="server2"
                ),
            ),
        ):
            tools = await manager.get_tools()
            assert len(tools) == 1
            assert tools[0].name == "tool1"

        # Second call: both succeed (server2 recovered)
        with (
            patch.object(
                manager._clients[0], "get_tools", return_value=[make_mock_tool("tool1")]
            ) as mock_get1_retry,
            patch.object(
                manager._clients[1], "get_tools", return_value=[make_mock_tool("tool2")]
            ) as mock_get2_retry,
        ):
            tools = await manager.get_tools()
            assert len(tools) == 2
            assert tools[0].name == "tool1"
            assert tools[1].name == "tool2"
            mock_get1_retry.assert_called_once()
            mock_get2_retry.assert_called_once()
