# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Tests for MCP (Model Context Protocol) integration."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from langchain_core.tools import BaseTool

from afm_cli import (
    AFMRecord,
    AgentMetadata,
    ClientAuthentication,
    MCPAuthenticationError,
    MCPClient,
    MCPConnectionError,
    MCPError,
    MCPManager,
    MCPServer,
    ToolFilter,
    Tools,
    Transport,
    filter_tools,
)
from afm_cli.tools.mcp import (
    ApiKeyAuth,
    BearerAuth,
    build_httpx_auth,
)

# =============================================================================
# Test Fixtures
# =============================================================================


def make_mcp_server(
    name: str = "test-server",
    url: str = "http://localhost:8080/mcp",
    auth_type: str | None = None,
    tool_filter: ToolFilter | None = None,
) -> MCPServer:
    """Helper to create MCPServer configs for testing."""
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
    """Helper to create AFMRecord with MCP servers."""
    return AFMRecord(
        metadata=AgentMetadata(
            name="Test Agent",
            tools=Tools(mcp=servers),
        ),
        role="You are a helpful assistant.",
        instructions="Help the user.",
    )


def make_mock_tool(name: str, description: str = "A test tool") -> MagicMock:
    """Create a mock LangChain tool."""
    tool = MagicMock(spec=BaseTool)
    tool.name = name
    tool.description = description
    # Set args_schema to a Pydantic model (like real LangChain tools have)
    # This is needed because Agent._fix_tools_for_openai() accesses this attribute
    from pydantic import BaseModel

    class MockArgsSchema(BaseModel):
        """Mock args schema for testing."""

        pass

    tool.args_schema = MockArgsSchema
    return tool


# =============================================================================
# Authentication Header Tests
# =============================================================================


class TestBuildHttpxAuth:
    """Tests for build_httpx_auth function."""

    def test_none_auth_returns_none(self):
        """No auth returns None."""
        result = build_httpx_auth(None)
        assert result is None

    def test_bearer_auth_returns_bearer_auth_instance(self):
        """Bearer auth returns BearerAuth instance."""
        auth = ClientAuthentication(type="bearer", token="my-token")
        result = build_httpx_auth(auth)
        assert isinstance(result, BearerAuth)
        assert result.token == "my-token"

    def test_basic_auth_returns_httpx_basic_auth(self):
        """Basic auth returns httpx.BasicAuth instance."""
        auth = ClientAuthentication(type="basic", username="user", password="pass")
        result = build_httpx_auth(auth)
        assert isinstance(result, httpx.BasicAuth)

    def test_api_key_auth_returns_api_key_auth_instance(self):
        """API key auth returns ApiKeyAuth instance."""
        auth = ClientAuthentication(type="api-key", api_key="my-api-key")
        result = build_httpx_auth(auth)
        assert isinstance(result, ApiKeyAuth)
        assert result.api_key == "my-api-key"


# =============================================================================
# Tool Filtering Tests
# =============================================================================


class TestFilterTools:
    """Tests for filter_tools function."""

    def test_no_filter_returns_all_tools(self):
        """No filter returns all tools unchanged."""
        tools = [make_mock_tool("tool1"), make_mock_tool("tool2")]
        result = filter_tools(tools, None)
        assert result == tools

    def test_empty_filter_returns_all_tools(self):
        """Empty filter (no allow/deny) returns all tools."""
        tools = [make_mock_tool("tool1"), make_mock_tool("tool2")]
        tool_filter = ToolFilter()
        result = filter_tools(tools, tool_filter)
        assert result == tools

    def test_allow_only_returns_allowed_tools(self):
        """Allow-only filter returns only allowed tools."""
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
        """Deny-only filter returns all tools except denied ones."""
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
        """Allow + deny filter returns allowed tools minus denied ones."""
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

    def test_allow_with_nonexistent_tool_ignores_it(self):
        """Allow list with nonexistent tool only returns existing allowed tools."""
        tools = [make_mock_tool("tool1"), make_mock_tool("tool2")]
        tool_filter = ToolFilter(allow=["tool1", "nonexistent"])
        result = filter_tools(tools, tool_filter)
        assert len(result) == 1
        assert result[0].name == "tool1"

    def test_deny_with_nonexistent_tool_ignores_it(self):
        """Deny list with nonexistent tool works normally."""
        tools = [make_mock_tool("tool1"), make_mock_tool("tool2")]
        tool_filter = ToolFilter(deny=["nonexistent"])
        result = filter_tools(tools, tool_filter)
        assert len(result) == 2

    def test_preserves_tool_order(self):
        """Filtering preserves the original tool order."""
        tools = [
            make_mock_tool("z_tool"),
            make_mock_tool("a_tool"),
            make_mock_tool("m_tool"),
        ]
        tool_filter = ToolFilter(allow=["z_tool", "m_tool"])
        result = filter_tools(tools, tool_filter)
        assert len(result) == 2
        assert result[0].name == "z_tool"
        assert result[1].name == "m_tool"

    def test_empty_allow_list_returns_no_tools(self):
        """Empty allow list returns no tools."""
        tools = [make_mock_tool("tool1"), make_mock_tool("tool2")]
        tool_filter = ToolFilter(allow=[])
        result = filter_tools(tools, tool_filter)
        assert len(result) == 0

    def test_empty_deny_list_returns_all_tools(self):
        """Empty deny list returns all tools."""
        tools = [make_mock_tool("tool1"), make_mock_tool("tool2")]
        tool_filter = ToolFilter(deny=[])
        result = filter_tools(tools, tool_filter)
        assert len(result) == 2


# =============================================================================
# MCPClient Tests
# =============================================================================


class TestMCPClient:
    """Tests for MCPClient class."""

    def test_from_mcp_server_creates_client(self):
        """from_mcp_server creates a properly configured client."""
        server = make_mcp_server(name="test", url="http://localhost:8080/mcp")
        client = MCPClient.from_mcp_server(server)

        assert client.name == "test"
        assert client.url == "http://localhost:8080/mcp"
        assert client.authentication is None
        assert client.tool_filter is None

    def test_from_mcp_server_with_auth(self):
        """from_mcp_server preserves authentication config."""
        server = make_mcp_server(name="test", auth_type="bearer")
        client = MCPClient.from_mcp_server(server)

        assert client.authentication is not None
        assert client.authentication.type == "bearer"
        assert client.authentication.token == "test-token"

    def test_from_mcp_server_with_tool_filter(self):
        """from_mcp_server preserves tool filter config."""
        tool_filter = ToolFilter(allow=["tool1", "tool2"])
        server = make_mcp_server(name="test", tool_filter=tool_filter)
        client = MCPClient.from_mcp_server(server)

        assert client.tool_filter is not None
        assert client.tool_filter.allow == ["tool1", "tool2"]

    def test_from_mcp_server_unsupported_transport_raises_error(self):
        """from_mcp_server with non-http transport raises MCPError."""
        # Create a server with invalid transport type (would need to bypass validation)
        server = MCPServer(
            name="test",
            transport=Transport(type="http", url="http://localhost:8080"),
        )
        # Manually override the type to simulate invalid transport
        object.__setattr__(server.transport, "type", "stdio")

        with pytest.raises(MCPError, match="Unsupported transport type"):
            MCPClient.from_mcp_server(server)

    def test_build_connection_config_basic(self):
        """_build_connection_config returns correct format."""
        client = MCPClient(
            name="test",
            url="http://localhost:8080/mcp",
        )
        config = client._build_connection_config()

        assert config["transport"] == "streamable_http"
        assert config["url"] == "http://localhost:8080/mcp"
        assert "auth" not in config

    def test_build_connection_config_with_auth(self):
        """_build_connection_config includes auth when configured."""
        auth = ClientAuthentication(type="bearer", token="my-token")
        client = MCPClient(
            name="test",
            url="http://localhost:8080/mcp",
            authentication=auth,
        )
        config = client._build_connection_config()

        assert "auth" in config
        assert isinstance(config.get("auth"), BearerAuth)

    @pytest.mark.asyncio
    async def test_get_tools_calls_mcp_client(self):
        """get_tools creates MultiServerMCPClient and gets tools."""
        client = MCPClient(
            name="test-server",
            url="http://localhost:8080/mcp",
        )

        mock_tools = [make_mock_tool("tool1"), make_mock_tool("tool2")]

        with patch("afm_cli.tools.mcp.MultiServerMCPClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.get_tools.return_value = mock_tools
            MockClient.return_value = mock_instance

            result = await client.get_tools()

            assert len(result) == 2
            mock_instance.get_tools.assert_called_once_with(server_name="test-server")

    @pytest.mark.asyncio
    async def test_get_tools_applies_filtering(self):
        """get_tools applies tool filtering."""
        tool_filter = ToolFilter(allow=["tool1"])
        client = MCPClient(
            name="test-server",
            url="http://localhost:8080/mcp",
            tool_filter=tool_filter,
        )

        mock_tools = [make_mock_tool("tool1"), make_mock_tool("tool2")]

        with patch("afm_cli.tools.mcp.MultiServerMCPClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.get_tools.return_value = mock_tools
            MockClient.return_value = mock_instance

            result = await client.get_tools()

            assert len(result) == 1
            assert result[0].name == "tool1"

    @pytest.mark.asyncio
    async def test_get_tools_connection_error_raises_mcp_error(self):
        """get_tools wraps connection errors in MCPConnectionError."""
        client = MCPClient(
            name="test-server",
            url="http://localhost:8080/mcp",
        )

        with patch("afm_cli.tools.mcp.MultiServerMCPClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.get_tools.side_effect = Exception("Connection refused")
            MockClient.return_value = mock_instance

            with pytest.raises(MCPConnectionError, match="Failed to connect"):
                await client.get_tools()


# =============================================================================
# MCPManager Tests
# =============================================================================


class TestMCPManager:
    """Tests for MCPManager class."""

    def test_from_afm_with_no_tools_returns_none(self):
        """from_afm with no tools config returns None."""
        afm = AFMRecord(
            metadata=AgentMetadata(name="Test"),
            role="Role",
            instructions="Instructions",
        )
        manager = MCPManager.from_afm(afm)
        assert manager is None

    def test_from_afm_with_empty_mcp_returns_none(self):
        """from_afm with empty MCP list returns None."""
        afm = AFMRecord(
            metadata=AgentMetadata(name="Test", tools=Tools(mcp=[])),
            role="Role",
            instructions="Instructions",
        )
        manager = MCPManager.from_afm(afm)
        assert manager is None

    def test_from_afm_with_mcp_servers_creates_manager(self):
        """from_afm with MCP servers creates manager with clients."""
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
        """server_names returns list of all server names."""
        servers = [
            make_mcp_server(name="alpha"),
            make_mcp_server(name="beta"),
        ]
        manager = MCPManager(servers)

        assert manager.server_names == ["alpha", "beta"]

    @pytest.mark.asyncio
    async def test_get_tools_aggregates_from_all_clients(self):
        """get_tools combines tools from all servers."""
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
        """get_tools caches the result after first call."""
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
        """get_tools continues if one server fails but others succeed."""
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
        """get_tools raises MCPConnectionError if all servers fail."""
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
        """clear_cache resets the tools cache."""
        servers = [make_mcp_server(name="server1")]
        manager = MCPManager(servers)
        manager._tools = [make_mock_tool("cached")]

        manager.clear_cache()

        assert manager._tools is None


# =============================================================================
# Exception Tests
# =============================================================================


class TestMCPExceptions:
    """Tests for MCP exception classes."""

    def test_mcp_error_with_server_name(self):
        """MCPError formats message with server name."""
        error = MCPError("Something failed", server_name="my-server")
        assert str(error) == "MCP server 'my-server': Something failed"
        assert error.server_name == "my-server"

    def test_mcp_error_without_server_name(self):
        """MCPError works without server name."""
        error = MCPError("Something failed")
        assert str(error) == "Something failed"
        assert error.server_name is None

    def test_mcp_connection_error(self):
        """MCPConnectionError inherits from MCPError."""
        error = MCPConnectionError("Connection refused", server_name="test")
        assert isinstance(error, MCPError)
        assert "Connection refused" in str(error)

    def test_mcp_authentication_error(self):
        """MCPAuthenticationError inherits from MCPError."""
        error = MCPAuthenticationError("Invalid token", server_name="test")
        assert isinstance(error, MCPError)
        assert "Invalid token" in str(error)


# =============================================================================
# Integration Tests with Agent
# =============================================================================


class TestAgentMCPIntegration:
    """Tests for Agent class MCP integration."""

    @pytest.mark.asyncio
    async def test_agent_context_manager_connects_and_disconnects(self):
        """Agent context manager calls connect and disconnect."""
        servers = [make_mcp_server(name="test")]
        afm = make_afm_with_mcp(servers)

        with patch("afm_cli.agent.create_model_provider") as mock_provider:
            mock_model = MagicMock()
            mock_model.bind_tools = MagicMock(return_value=mock_model)
            mock_provider.return_value = mock_model

            with patch("afm_cli.tools.mcp.MultiServerMCPClient") as MockClient:
                mock_instance = AsyncMock()
                mock_instance.get_tools.return_value = [make_mock_tool("tool1")]
                MockClient.return_value = mock_instance

                from afm_cli import Agent

                agent = Agent(afm)

                assert not agent.is_connected
                assert agent.has_mcp_config

                async with agent:
                    assert agent.is_connected
                    assert len(agent.tools) == 1

                assert not agent.is_connected

    @pytest.mark.asyncio
    async def test_agent_without_mcp_still_works_as_context_manager(self):
        """Agent without MCP config works as context manager (no-op)."""
        afm = AFMRecord(
            metadata=AgentMetadata(name="Test"),
            role="Role",
            instructions="Instructions",
        )

        with patch("afm_cli.agent.create_model_provider") as mock_provider:
            mock_model = MagicMock()
            mock_provider.return_value = mock_model

            from afm_cli import Agent

            agent = Agent(afm)

            assert not agent.has_mcp_config

            async with agent:
                assert agent.is_connected  # connect() was called
                assert len(agent.tools) == 0

    @pytest.mark.asyncio
    async def test_agent_connect_binds_tools_to_model(self):
        """Agent.connect() binds loaded tools to the model."""
        servers = [make_mcp_server(name="test")]
        afm = make_afm_with_mcp(servers)

        with patch("afm_cli.agent.create_model_provider") as mock_provider:
            mock_model = MagicMock()
            mock_bound_model = MagicMock()
            mock_model.bind_tools = MagicMock(return_value=mock_bound_model)
            mock_provider.return_value = mock_model

            mock_tools = [make_mock_tool("tool1")]

            with patch("afm_cli.tools.mcp.MultiServerMCPClient") as MockClient:
                mock_instance = AsyncMock()
                mock_instance.get_tools.return_value = mock_tools
                MockClient.return_value = mock_instance

                from afm_cli import Agent

                agent = Agent(afm)
                await agent.connect()

                mock_model.bind_tools.assert_called_once_with(mock_tools)
                assert agent._model is mock_bound_model

    def test_agent_with_external_tools(self):
        """Agent accepts external tools in constructor."""
        afm = AFMRecord(
            metadata=AgentMetadata(name="Test"),
            role="Role",
            instructions="Instructions",
        )

        with patch("afm_cli.agent.create_model_provider") as mock_provider:
            mock_model = MagicMock()
            mock_provider.return_value = mock_model

            from afm_cli import Agent

            external_tool = make_mock_tool("external_tool")
            agent = Agent(afm, tools=[external_tool])

            assert len(agent.tools) == 1
            assert agent.tools[0].name == "external_tool"
