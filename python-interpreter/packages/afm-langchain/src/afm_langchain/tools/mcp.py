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
import time
from pathlib import Path

import httpx
import jwt
from afm.exceptions import (
    MCPAuthenticationError,
    MCPConnectionError,
    MCPError,
)
from afm.models import (
    AFMRecord,
    ClientAuthentication,
    HttpTransport,
    MCPServer,
    StdioTransport,
    ToolFilter,
)
from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.sessions import StdioConnection, StreamableHttpConnection

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


_HMAC_JWT_ALGORITHMS = {"HS256", "HS384", "HS512"}


class JwtAuth(httpx.Auth):

    def __init__(
        self,
        *,
        issuer: str,
        audience: str | list[str],
        signing_key: str,
        algorithm: str = "RS256",
        key_id: str | None = None,
        subject: str | None = None,
        custom_claims: dict | None = None,
        expiry_seconds: int = 300,
    ) -> None:
        self.issuer = issuer
        self.audience = audience
        self.signing_key = signing_key
        self.algorithm = algorithm
        self.key_id = key_id
        self.subject = subject
        self.custom_claims = custom_claims or {}
        self.expiry_seconds = expiry_seconds

    def _resolve_key(self) -> str:
        if self.algorithm.upper() in _HMAC_JWT_ALGORITHMS:
            return self.signing_key
        try:
            return Path(self.signing_key).read_text()
        except OSError as e:
            raise MCPAuthenticationError(
                f"Could not read JWT signing key file '{self.signing_key}': {e}"
            ) from e

    def sign(self) -> str:
        now = int(time.time())
        claims: dict = {
            "iss": self.issuer,
            "aud": self.audience,
            "iat": now,
            "nbf": now,
            "exp": now + self.expiry_seconds,
        }
        if self.subject is not None:
            claims["sub"] = self.subject
        claims.update(self.custom_claims)
        headers = {"kid": self.key_id} if self.key_id else None
        try:
            return jwt.encode(
                claims, self._resolve_key(), algorithm=self.algorithm, headers=headers
            )
        except MCPAuthenticationError:
            raise
        except Exception as e:
            raise MCPAuthenticationError(f"Failed to sign JWT: {e}") from e

    def auth_flow(self, request: httpx.Request):
        request.headers["Authorization"] = f"Bearer {self.sign()}"
        yield request


_JWT_BEARER_GRANT_URN = "urn:ietf:params:oauth:grant-type:jwt-bearer"


class OAuth2Auth(httpx.Auth):

    def __init__(
        self,
        *,
        grant_type: str,
        token_url: str | None = None,
        refresh_url: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        username: str | None = None,
        password: str | None = None,
        refresh_token: str | None = None,
        assertion: str | None = None,
        scopes: list[str] | None = None,
    ) -> None:
        self.grant_type = grant_type.lower()
        self.token_url = token_url
        self.refresh_url = refresh_url
        self.client_id = client_id
        self.client_secret = client_secret
        self.username = username
        self.password = password
        self.refresh_token = refresh_token
        self.assertion = assertion
        self.scopes = scopes
        self._token: str | None = None
        self._expires_at: float = 0.0

    def _token_request(self) -> tuple[str, dict[str, str], tuple[str, str] | None]:
        url: str | None
        data: dict[str, str]
        if self.grant_type == "client_credentials":
            url = self.token_url
            data = {"grant_type": "client_credentials"}
        elif self.grant_type == "password":
            url = self.token_url
            data = {
                "grant_type": "password",
                "username": self.username or "",
                "password": self.password or "",
            }
        elif self.grant_type == "refresh_token":
            url = self.refresh_url
            data = {
                "grant_type": "refresh_token",
                "refresh_token": self.refresh_token or "",
            }
        elif self.grant_type == "jwt_bearer":
            url = self.token_url
            data = {
                "grant_type": _JWT_BEARER_GRANT_URN,
                "assertion": self.assertion or "",
            }
        else:
            raise MCPAuthenticationError(
                f"Unsupported oauth2 grant_type: {self.grant_type}"
            )

        if url is None:
            raise MCPAuthenticationError(
                f"oauth2 grant_type '{self.grant_type}' is missing its token URL"
            )
        if self.scopes:
            data["scope"] = " ".join(self.scopes)

        basic = (
            (self.client_id, self.client_secret)
            if self.client_id is not None and self.client_secret is not None
            else None
        )
        return url, data, basic

    def _store_token(self, payload: dict) -> str:
        token = payload.get("access_token")
        if not token:
            raise MCPAuthenticationError(
                "OAuth2 token response did not contain 'access_token'"
            )
        expires_in = float(payload.get("expires_in", 3600))
        self._expires_at = time.time() + expires_in - 30
        self._token = token
        return token

    def _cached_token(self) -> str | None:
        if self._token is not None and time.time() < self._expires_at:
            return self._token
        return None

    def _fetch_token_sync(self) -> str:
        url, data, basic = self._token_request()
        try:
            resp = httpx.post(
                url,
                data=data,
                auth=basic,
                headers={"Accept": "application/json"},
                timeout=30.0,
            )
            resp.raise_for_status()
            payload = resp.json()
        except Exception as e:
            raise MCPAuthenticationError(f"OAuth2 token request failed: {e}") from e
        return self._store_token(payload)

    async def _fetch_token_async(self) -> str:
        url, data, basic = self._token_request()
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(
                    url,
                    data=data,
                    auth=basic,
                    headers={"Accept": "application/json"},
                )
                resp.raise_for_status()
                payload = resp.json()
        except Exception as e:
            raise MCPAuthenticationError(f"OAuth2 token request failed: {e}") from e
        return self._store_token(payload)

    def sync_auth_flow(self, request: httpx.Request):
        token = self._cached_token() or self._fetch_token_sync()
        request.headers["Authorization"] = f"Bearer {token}"
        yield request

    async def async_auth_flow(self, request: httpx.Request):
        token = self._cached_token() or await self._fetch_token_async()
        request.headers["Authorization"] = f"Bearer {token}"
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
        return ApiKeyAuth(auth.api_key, header_name=auth.header_name or "Authorization")

    elif auth_type == "jwt":
        if auth.issuer is None or auth.audience is None or auth.signing_key is None:
            raise MCPAuthenticationError(
                "JWT auth requires 'issuer', 'audience', and 'signing_key' fields"
            )
        return JwtAuth(
            issuer=auth.issuer,
            audience=auth.audience,
            signing_key=auth.signing_key,
            algorithm=auth.algorithm or "RS256",
            key_id=auth.key_id,
            subject=auth.subject,
            custom_claims=auth.custom_claims,
            expiry_seconds=(
                auth.expiry_seconds if auth.expiry_seconds is not None else 300
            ),
        )

    elif auth_type == "oauth2":
        if auth.grant_type is None:
            raise MCPAuthenticationError("OAuth2 auth requires 'grant_type' field")
        return OAuth2Auth(
            grant_type=auth.grant_type,
            token_url=auth.token_url,
            refresh_url=auth.refresh_url,
            client_id=auth.client_id,
            client_secret=auth.client_secret,
            username=auth.username,
            password=auth.password,
            refresh_token=auth.refresh_token,
            assertion=auth.assertion,
            scopes=auth.scopes,
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
        transport: HttpTransport | StdioTransport,
        tool_filter: ToolFilter | None = None,
    ) -> None:
        """Initialize an MCP client."""
        self.name = name
        self.transport = transport
        self.tool_filter = tool_filter
        self._tools: list[BaseTool] | None = None

    @classmethod
    def from_mcp_server(cls, server: MCPServer) -> "MCPClient":
        transport = server.transport

        if not isinstance(transport, (HttpTransport, StdioTransport)):
            raise MCPError(
                f"Unsupported transport type: {transport.type}",
                server_name=server.name,
            )

        return cls(
            name=server.name,
            transport=transport,
            tool_filter=server.tool_filter,
        )

    def _build_connection_config(self) -> StreamableHttpConnection | StdioConnection:
        if isinstance(self.transport, HttpTransport):
            config: StreamableHttpConnection = {
                "transport": "streamable_http",
                "url": self.transport.url,
            }
            auth = build_httpx_auth(self.transport.authentication)
            if auth is not None:
                config["auth"] = auth
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
