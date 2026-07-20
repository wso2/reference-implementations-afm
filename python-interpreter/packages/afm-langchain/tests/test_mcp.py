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

import time
from typing import cast
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import jwt
import pytest
from langchain_core.tools import BaseTool
from langchain_mcp_adapters.sessions import StdioConnection

from afm.exceptions import MCPAuthenticationError, MCPConnectionError
from afm.models import (
    AFMRecord,
    AgentMetadata,
    ClientAuthentication,
    HttpTransport,
    MCPServer,
    StdioTransport,
    ToolFilter,
    Tools,
)
from afm_langchain.tools.mcp import (
    ApiKeyAuth,
    BearerAuth,
    JwtAuth,
    MCPClient,
    MCPManager,
    OAuth2Auth,
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
        auth = ClientAuthentication(
            type="oauth2",
            grant_type="client_credentials",
            token_url="https://auth.example.com/token",
            client_id="id",
            client_secret="secret",
        )
    elif auth_type == "jwt":
        auth = ClientAuthentication(
            type="jwt",
            issuer="afm-agent",
            audience="https://api.example.com",
            signing_key="secret",
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

    def test_api_key_auth_defaults_to_authorization_header(self):
        auth = ClientAuthentication(type="api-key", api_key="my-api-key")
        result = build_httpx_auth(auth)
        assert isinstance(result, ApiKeyAuth)
        assert result.header_name == "Authorization"

    def test_api_key_auth_uses_custom_header_name(self):
        auth = ClientAuthentication(
            type="api-key", api_key="my-api-key", header_name="X-API-Key"
        )
        result = build_httpx_auth(auth)
        assert isinstance(result, ApiKeyAuth)
        assert result.api_key == "my-api-key"
        assert result.header_name == "X-API-Key"

    def test_jwt_auth_returns_jwt_auth_instance(self):
        auth = ClientAuthentication(
            type="jwt",
            issuer="afm-agent",
            audience="https://api.example.com",
            signing_key="secret",
            algorithm="HS256",
        )
        result = build_httpx_auth(auth)
        assert isinstance(result, JwtAuth)
        assert result.issuer == "afm-agent"
        assert result.algorithm == "HS256"

    def test_jwt_auth_defaults_to_rs256(self):
        auth = ClientAuthentication(
            type="jwt", issuer="i", audience="a", signing_key="s"
        )
        result = build_httpx_auth(auth)
        assert isinstance(result, JwtAuth)
        assert result.algorithm == "RS256"

    def test_jwt_auth_signs_valid_hmac_token(self):
        auth = ClientAuthentication(
            type="jwt",
            issuer="afm-agent",
            audience="https://api.example.com",
            signing_key="topsecret-key-that-is-32-bytes-or-more",
            algorithm="HS256",
            subject="agent-1",
            custom_claims={"scope": "read"},
            expiry_seconds=600,
        )
        jwt_auth = build_httpx_auth(auth)
        assert isinstance(jwt_auth, JwtAuth)
        token = jwt_auth.sign()
        decoded = jwt.decode(
            token,
            "topsecret-key-that-is-32-bytes-or-more",
            algorithms=["HS256"],
            audience="https://api.example.com",
        )
        assert decoded["iss"] == "afm-agent"
        assert decoded["sub"] == "agent-1"
        assert decoded["scope"] == "read"
        assert decoded["exp"] - decoded["iat"] == 600

    def test_jwt_auth_signs_rs256_with_key_file(self, tmp_path):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa

        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        key_file = tmp_path / "jwt_key.pem"
        key_file.write_bytes(
            private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )

        auth = ClientAuthentication(
            type="jwt",
            issuer="afm-agent",
            audience="https://api.example.com",
            signing_key=str(key_file),  # asymmetric: signing_key is a file path
            algorithm="RS256",
        )
        jwt_auth = build_httpx_auth(auth)
        assert isinstance(jwt_auth, JwtAuth)
        token = jwt_auth.sign()

        public_pem = private_key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        )
        decoded = jwt.decode(
            token,
            public_pem,
            algorithms=["RS256"],
            audience="https://api.example.com",
        )
        assert decoded["iss"] == "afm-agent"

    def test_jwt_signing_key_file_read_once_and_cached(self, tmp_path):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa

        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        key_file = tmp_path / "jwt_key.pem"
        key_file.write_bytes(
            private_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.PKCS8,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
        auth = ClientAuthentication(
            type="jwt", issuer="i", signing_key=str(key_file), algorithm="RS256"
        )
        jwt_auth = build_httpx_auth(auth)
        assert isinstance(jwt_auth, JwtAuth)
        jwt_auth.sign()
        # Key is cached after first sign; removing the file must not break a second sign.
        key_file.unlink()
        jwt_auth.sign()

    def test_oauth2_returns_oauth2_auth_instance(self):
        auth = ClientAuthentication(
            type="oauth2",
            grant_type="client_credentials",
            token_url="https://auth.example.com/token",
            client_id="id",
            client_secret="secret",
            scopes=["read"],
        )
        result = build_httpx_auth(auth)
        assert isinstance(result, OAuth2Auth)
        assert result.grant_type == "client_credentials"

    def test_oauth2_client_credentials_token_request(self):
        result = build_httpx_auth(
            ClientAuthentication(
                type="oauth2",
                grant_type="client_credentials",
                token_url="https://auth.example.com/token",
                client_id="id",
                client_secret="secret",
                scopes=["read", "write"],
            )
        )
        assert isinstance(result, OAuth2Auth)
        url, data, basic = result._token_request()
        assert url == "https://auth.example.com/token"
        assert data["grant_type"] == "client_credentials"
        assert data["scope"] == "read write"
        assert basic == ("id", "secret")

    def test_oauth2_refresh_token_uses_token_url(self):
        result = build_httpx_auth(
            ClientAuthentication(
                type="oauth2",
                grant_type="refresh_token",
                token_url="https://auth.example.com/token",
                refresh_token="rt",
                client_id="id",
                client_secret="secret",
            )
        )
        assert isinstance(result, OAuth2Auth)
        url, data, _basic = result._token_request()
        assert url == "https://auth.example.com/token"
        assert data["grant_type"] == "refresh_token"
        assert data["refresh_token"] == "rt"

    def test_oauth2_jwt_bearer_token_request(self):
        result = build_httpx_auth(
            ClientAuthentication(
                type="oauth2",
                grant_type="jwt_bearer",
                token_url="https://auth.example.com/token",
                assertion="signed.jwt",
            )
        )
        assert isinstance(result, OAuth2Auth)
        _url, data, basic = result._token_request()
        assert data["grant_type"] == "urn:ietf:params:oauth:grant-type:jwt-bearer"
        assert data["assertion"] == "signed.jwt"
        assert basic is None  # no client credentials provided

    def test_oauth2_uses_cached_token(self):
        result = build_httpx_auth(
            ClientAuthentication(
                type="oauth2",
                grant_type="client_credentials",
                token_url="u",
                client_id="id",
                client_secret="secret",
            )
        )
        assert isinstance(result, OAuth2Auth)
        result._token = "cached-token"
        result._expires_at = time.time() + 1000
        request = httpx.Request("GET", "https://api.example.com/resource")
        flow = result.sync_auth_flow(request)
        next(flow)
        assert request.headers["Authorization"] == "Bearer cached-token"

    def test_oauth2_credential_bearer_post_body(self):
        result = build_httpx_auth(
            ClientAuthentication(
                type="oauth2",
                grant_type="client_credentials",
                token_url="https://auth.example.com/token",
                client_id="id",
                client_secret="secret",
                credential_bearer="post_body",
            )
        )
        assert isinstance(result, OAuth2Auth)
        _url, data, basic = result._token_request()
        assert basic is None
        assert data["client_id"] == "id"
        assert data["client_secret"] == "secret"

    def test_oauth2_credential_bearer_defaults_to_auth_header(self):
        result = build_httpx_auth(
            ClientAuthentication(
                type="oauth2",
                grant_type="client_credentials",
                token_url="https://auth.example.com/token",
                client_id="id",
                client_secret="secret",
            )
        )
        assert isinstance(result, OAuth2Auth)
        _url, data, basic = result._token_request()
        assert basic == ("id", "secret")
        assert "client_secret" not in data

    def test_jwt_without_audience_omits_aud_claim(self):
        auth = ClientAuthentication(
            type="jwt",
            issuer="afm-agent",
            signing_key="topsecret-key-that-is-32-bytes-or-more",
            algorithm="HS256",
        )
        jwt_auth = build_httpx_auth(auth)
        assert isinstance(jwt_auth, JwtAuth)
        token = jwt_auth.sign()
        decoded = jwt.decode(
            token,
            "topsecret-key-that-is-32-bytes-or-more",
            algorithms=["HS256"],
        )
        assert decoded["iss"] == "afm-agent"
        assert "aud" not in decoded

    def test_extension_type_not_supported_by_runtime(self):
        auth = ClientAuthentication(type="x-aws-sigv4", region="us-east-1")
        with pytest.raises(MCPAuthenticationError, match="extension authentication type"):
            build_httpx_auth(auth)


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
        assert isinstance(config["auth"], BearerAuth)

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
