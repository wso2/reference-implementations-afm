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

from typing import cast
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from afm.authentication import (
    ApiKeyAuthentication,
    BasicAuthentication,
    BearerAuthentication,
    ClientAuthentication,
    JwtAuthentication,
    OAuth2Authentication,
)
from afm.exceptions import MCPAuthenticationError, MCPConnectionError, MCPError
from afm.http_auth import HeaderAuth, JwtAuth, OAuth2Auth
from afm.models import (
    AFMRecord,
    AgentMetadata,
    HttpTransport,
    MCPServer,
    StdioTransport,
    ToolFilter,
    Tools,
)
from afm_langchain.tools.mcp import (
    MCPClient,
    MCPManager,
    filter_tools,
)
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from langchain_core.tools import BaseTool
from langchain_mcp_adapters.sessions import StdioConnection
from pydantic import TypeAdapter


def make_mcp_server(
    name: str = "test-server",
    url: str = "http://localhost:8080/mcp",
    auth_type: str | None = None,
    tool_filter: ToolFilter | None = None,
) -> MCPServer:
    auth = None
    if auth_type == "bearer":
        auth = BearerAuthentication(token="test-token")
    elif auth_type == "basic":
        auth = BasicAuthentication(username="user", password="pass")
    elif auth_type == "api-key":
        auth = ApiKeyAuthentication(api_key="test-api-key")
    elif auth_type == "oauth2":
        auth = OAuth2Authentication(
            grant_type="client_credentials",
            token_url="https://idp.example.com/token",
            client_id="client",
            client_secret="secret",
        )
    elif auth_type == "jwt":
        auth = JwtAuthentication(
            issuer="issuer",
            audience="audience",
            signing_key="k" * 32,
            algorithm="HS256",
        )

    return MCPServer(
        name=name,
        transport=HttpTransport(type="http", url=url, authentication=auth),
        tool_filter=tool_filter,
    )


def make_stdio_mcp_server(
    name: str = "stdio-server",
    command: str = "python",
    args: list[str] | None = None,
    env: dict[str, str] | None = None,
    tool_filter: ToolFilter | None = None,
) -> MCPServer:
    return MCPServer(
        name=name,
        transport=StdioTransport(
            type="stdio",
            command=command,
            args=args,
            env=env,
        ),
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
        assert isinstance(client.transport, HttpTransport)
        assert client.transport.url == "http://localhost:8080/mcp"
        assert client.transport.authentication is None
        assert client.tool_filter is None

    def test_from_mcp_server_with_auth(self):
        server = make_mcp_server(name="test", auth_type="bearer")
        client = MCPClient.from_mcp_server(server)

        assert isinstance(client.transport, HttpTransport)
        assert client.transport.authentication is not None
        assert client.transport.authentication.type == "bearer"
        assert client.transport.authentication.token == "test-token"

    def test_from_mcp_server_with_tool_filter(self):
        tool_filter = ToolFilter(allow=["tool1", "tool2"])
        server = make_mcp_server(name="test", tool_filter=tool_filter)
        client = MCPClient.from_mcp_server(server)

        assert client.tool_filter is not None
        assert client.tool_filter.allow == ["tool1", "tool2"]

    def test_from_mcp_server_creates_stdio_client(self):
        server = make_stdio_mcp_server(
            name="stdio-test",
            command="python",
            args=["server.py"],
        )
        client = MCPClient.from_mcp_server(server)

        assert client.name == "stdio-test"
        assert isinstance(client.transport, StdioTransport)
        assert client.transport.command == "python"
        assert client.transport.args == ["server.py"]
        assert client.tool_filter is None

    def test_build_connection_config_http(self):
        server = make_mcp_server(name="test", url="http://localhost:8080/mcp")
        client = MCPClient.from_mcp_server(server)
        config = client._build_connection_config()

        assert config["transport"] == "streamable_http"
        assert config["url"] == "http://localhost:8080/mcp"
        assert "auth" not in config

    def test_build_connection_config_http_with_auth(self):
        server = make_mcp_server(name="test", auth_type="bearer")
        client = MCPClient.from_mcp_server(server)
        config = client._build_connection_config()

        assert config["transport"] == "streamable_http"
        assert "auth" in config
        assert isinstance(config["auth"], HeaderAuth)

    def test_build_connection_config_stdio(self):
        server = make_stdio_mcp_server(
            name="stdio-test",
            command="npx",
            args=["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        )
        client = MCPClient.from_mcp_server(server)
        config = cast(StdioConnection, client._build_connection_config())

        assert config["transport"] == "stdio"
        assert config["command"] == "npx"
        assert config["args"] == [
            "-y",
            "@modelcontextprotocol/server-filesystem",
            "/tmp",
        ]
        assert "env" not in config

    def test_build_connection_config_stdio_with_env(self):
        server = make_stdio_mcp_server(
            name="stdio-test",
            command="python",
            args=["server.py"],
            env={"DB_PATH": "./data.db", "API_KEY": "secret"},
        )
        client = MCPClient.from_mcp_server(server)
        config = cast(StdioConnection, client._build_connection_config())

        assert config["transport"] == "stdio"
        assert config["env"] == {"DB_PATH": "./data.db", "API_KEY": "secret"}

    def test_build_connection_config_stdio_no_args_defaults_to_empty_list(self):
        server = make_stdio_mcp_server(name="stdio-test", command="python")
        client = MCPClient.from_mcp_server(server)
        config = cast(StdioConnection, client._build_connection_config())

        assert config["args"] == []

    @pytest.mark.asyncio
    async def test_get_tools_calls_mcp_client(self):
        server = make_mcp_server(name="test-server", url="http://localhost:8080/mcp")
        client = MCPClient.from_mcp_server(server)

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
        server = make_mcp_server(
            name="test-server",
            url="http://localhost:8080/mcp",
            tool_filter=tool_filter,
        )
        client = MCPClient.from_mcp_server(server)

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
        server = make_mcp_server(name="test-server", url="http://localhost:8080/mcp")
        client = MCPClient.from_mcp_server(server)

        with patch("afm_langchain.tools.mcp.MultiServerMCPClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.get_tools.side_effect = Exception("Connection refused")
            MockClient.return_value = mock_instance

            with pytest.raises(MCPConnectionError, match="Failed to connect"):
                await client.get_tools()

    @pytest.mark.asyncio
    async def test_get_tools_stdio_calls_mcp_client(self):
        server = make_stdio_mcp_server(
            name="stdio-server",
            command="python",
            args=["server.py"],
        )
        client = MCPClient.from_mcp_server(server)

        mock_tools = [make_mock_tool("stdio_tool")]

        with patch("afm_langchain.tools.mcp.MultiServerMCPClient") as MockClient:
            mock_instance = AsyncMock()
            mock_instance.get_tools.return_value = mock_tools
            MockClient.return_value = mock_instance

            result = await client.get_tools()

            assert len(result) == 1
            assert result[0].name == "stdio_tool"
            mock_instance.get_tools.assert_called_once_with(server_name="stdio-server")


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

    @pytest.mark.asyncio
    async def test_get_tools_mixed_http_and_stdio_servers(self):
        servers = [
            make_mcp_server(name="http-server", url="http://localhost:8080/mcp"),
            make_stdio_mcp_server(
                name="stdio-server",
                command="python",
                args=["server.py"],
            ),
        ]
        manager = MCPManager(servers)

        assert len(manager._clients) == 2
        assert isinstance(manager._clients[0].transport, HttpTransport)
        assert isinstance(manager._clients[1].transport, StdioTransport)

        with (
            patch.object(
                manager._clients[0],
                "get_tools",
                return_value=[make_mock_tool("http_tool")],
            ),
            patch.object(
                manager._clients[1],
                "get_tools",
                return_value=[make_mock_tool("stdio_tool")],
            ),
        ):
            tools = await manager.get_tools()

        assert len(tools) == 2
        assert tools[0].name == "http_tool"
        assert tools[1].name == "stdio_tool"


class TestMCPAuthentication:
    @pytest.mark.parametrize(
        ("auth_type", "expected"),
        [
            ("bearer", HeaderAuth),
            ("api-key", HeaderAuth),
            ("basic", httpx.BasicAuth),
            ("jwt", JwtAuth),
            ("oauth2", OAuth2Auth),
        ],
    )
    def test_every_type_is_applied_to_the_http_transport(self, auth_type, expected):
        client = MCPClient.from_mcp_server(make_mcp_server(auth_type=auth_type))

        assert isinstance(client._build_connection_config()["auth"], expected)

    def test_stdio_transports_have_no_authentication(self):
        client = MCPClient.from_mcp_server(make_stdio_mcp_server())
        assert client.auth is None

    def test_the_transport_url_is_the_default_oauth2_resource(self):
        server = make_mcp_server(
            url="HTTPS://MCP.Example.com/mcp#frag", auth_type="oauth2"
        )
        client = MCPClient.from_mcp_server(server)
        assert client.auth._resource == "https://mcp.example.com/mcp"

    def test_the_afm_directory_resolves_relative_signing_keys(self, tmp_path):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        (tmp_path / "signing.pem").write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        server = make_mcp_server()
        server.transport.authentication = TypeAdapter(
            ClientAuthentication
        ).validate_python(
            {
                "type": "jwt",
                "issuer": "i",
                "audience": "a",
                "signing_key": "signing.pem",
            }
        )
        afm = make_afm_with_mcp([server])
        afm.source_dir = tmp_path

        manager = MCPManager.from_afm(afm)

        assert isinstance(manager._clients[0].auth, JwtAuth)

    def test_an_unusable_key_fails_when_the_manager_is_created(self, tmp_path):
        server = make_mcp_server(name="secured")
        server.transport.authentication = TypeAdapter(
            ClientAuthentication
        ).validate_python(
            {
                "type": "jwt",
                "issuer": "i",
                "audience": "a",
                "signing_key": "missing.pem",
            }
        )
        afm = make_afm_with_mcp([server])
        afm.source_dir = tmp_path

        with pytest.raises(MCPAuthenticationError, match="MCP server 'secured'"):
            MCPManager.from_afm(afm)

    def test_other_mcp_errors_still_skip_the_server(self, caplog):
        good, bad = make_mcp_server(name="good"), make_mcp_server(name="bad")
        real = MCPClient.from_mcp_server

        def from_mcp_server(server, base_dir=None):
            if server.name == "bad":
                raise MCPError("Unsupported transport type", server_name=server.name)
            return real(server, base_dir)

        with patch.object(MCPClient, "from_mcp_server", side_effect=from_mcp_server):
            manager = MCPManager([good, bad])

        assert manager.server_names == ["good"]
        assert "Skipping MCP server" in caplog.text
