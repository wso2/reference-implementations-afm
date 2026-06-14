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

from pathlib import Path

import pytest
from pydantic import ValidationError

from afm.exceptions import AFMParseError, AFMValidationError, VariableResolutionError
from afm.models import (
    ClientAuthentication,
    ConsoleChatInterface,
    HttpTransport,
    StdioTransport,
    WebChatInterface,
    WebhookInterface,
)
from afm.parser import parse_afm, parse_afm_file


class TestParseAfm:
    def test_parse_full_agent(self, sample_agent_path: Path) -> None:
        content = sample_agent_path.read_text()
        result = parse_afm(content)

        assert result.metadata.spec_version == "0.3.0"
        assert result.metadata.name == "TestAgent"
        assert result.metadata.description == "A test agent for AFM parsing."
        assert result.metadata.authors == ["Maryam", "Copilot"]
        assert result.metadata.version == "0.1.0"
        assert result.metadata.icon_url == "https://example.com/icon.png"
        assert result.metadata.license == "Apache-2.0"
        assert result.metadata.max_iterations == 5

        # Check interfaces
        assert result.metadata.interfaces is not None
        assert len(result.metadata.interfaces) == 1
        interface = result.metadata.interfaces[0]
        assert isinstance(interface, WebChatInterface)
        assert interface.type == "webchat"

        # Check signature
        assert interface.signature.input.type == "object"
        assert interface.signature.input.properties is not None
        assert "user_prompt" in interface.signature.input.properties
        assert interface.signature.input.required == ["user_prompt"]

        # Check tools
        assert result.metadata.tools is not None
        assert result.metadata.tools.mcp is not None
        assert len(result.metadata.tools.mcp) == 1
        mcp_server = result.metadata.tools.mcp[0]
        assert mcp_server.name == "TestServer"
        assert isinstance(mcp_server.transport, HttpTransport)
        assert mcp_server.transport.url == "https://test-server.com/api"
        assert mcp_server.transport.authentication is not None
        assert mcp_server.transport.authentication.type == "bearer"
        assert mcp_server.tool_filter is not None
        assert mcp_server.tool_filter.allow == ["tool1", "tool2"]

        # Check role and instructions
        assert (
            result.role
            == "This is a test role for the agent. It should be parsed correctly."
        )
        assert (
            result.instructions
            == "These are the instructions for the agent. They should also be parsed correctly."
        )

    def test_parse_consolechat_agent(self, sample_consolechat_path: Path) -> None:
        content = sample_consolechat_path.read_text()
        result = parse_afm(content)

        assert result.metadata.name == "TestAgent"
        assert result.metadata.author == "Copilot"

        # Check interfaces
        assert result.metadata.interfaces is not None
        assert len(result.metadata.interfaces) == 1
        interface = result.metadata.interfaces[0]
        assert isinstance(interface, ConsoleChatInterface)
        assert interface.type == "consolechat"

        # Check model
        assert result.metadata.model is not None
        assert result.metadata.model.provider == "openai"
        assert result.metadata.model.name == "gpt-4"
        assert result.metadata.model.authentication is not None
        assert result.metadata.model.authentication.type == "bearer"
        assert result.metadata.model.authentication.token == "mock-token"

    def test_parse_webhook_agent(self, sample_webhook_path: Path) -> None:
        content = sample_webhook_path.read_text()
        result = parse_afm(content)

        assert result.metadata.name == "WebhookTestAgent"

        # Check interfaces
        assert result.metadata.interfaces is not None
        assert len(result.metadata.interfaces) == 1
        interface = result.metadata.interfaces[0]
        assert isinstance(interface, WebhookInterface)
        assert interface.type == "webhook"
        assert interface.prompt is not None
        assert "${http:payload.event}" in interface.prompt
        assert "${http:payload}" in interface.prompt

        # Check subscription
        assert interface.subscription.protocol == "websub"
        assert interface.subscription.hub == "http://localhost:9193/websub/hub"

    def test_parse_minimal_agent(self, sample_minimal_path: Path) -> None:
        content = sample_minimal_path.read_text()
        result = parse_afm(content)

        assert result.metadata.spec_version == "0.3.0"
        assert result.role == "Agent role here."
        assert result.instructions == "Agent instructions here."

    def test_parse_no_frontmatter(self, sample_no_frontmatter_path: Path) -> None:
        content = sample_no_frontmatter_path.read_text()
        result = parse_afm(content)

        # Should have empty metadata
        assert result.metadata.spec_version is None
        assert result.metadata.name is None

        # Should have role and instructions
        assert result.role == "This is the role without frontmatter."
        assert result.instructions == "These are instructions without frontmatter."

    def test_parse_unclosed_frontmatter(self) -> None:
        content = """---
spec_version: "0.3.0"

# Role
The role.
"""
        with pytest.raises(AFMParseError) as exc_info:
            parse_afm(content)
        assert "Unclosed frontmatter" in str(exc_info.value)

    def test_parse_invalid_yaml(self) -> None:
        content = """---
spec_version: "0.3.0"
invalid: [unclosed
---

# Role
Role.

# Instructions
Instructions.
"""
        with pytest.raises(AFMParseError) as exc_info:
            parse_afm(content)
        assert "Invalid YAML" in str(exc_info.value)

    def test_parse_invalid_field_type(self) -> None:
        content = """---
spec_version: "0.3.0"
max_iterations: "not a number"
---

# Role
Role.

# Instructions
Instructions.
"""
        with pytest.raises(AFMValidationError):
            parse_afm(content)

    def test_parse_multiline_role_and_instructions(self) -> None:
        content = """---
spec_version: "0.3.0"
---

# Role
Line 1 of role.
Line 2 of role.
Line 3 of role.

# Instructions
Line 1 of instructions.
Line 2 of instructions.
"""
        result = parse_afm(content)
        assert "Line 1 of role." in result.role
        assert "Line 2 of role." in result.role
        assert "Line 3 of role." in result.role
        assert "Line 1 of instructions." in result.instructions
        assert "Line 2 of instructions." in result.instructions

    def test_role_heading_exact_match_only(self) -> None:
        content = """---
spec_version: "0.3.0"
---

# Roleplay
This should NOT be parsed as role.

# Role
This is the actual role.

# Instructions
These are instructions.
"""
        result = parse_afm(content)
        assert "Roleplay" not in result.role
        assert "This should NOT be parsed as role." not in result.role
        assert result.role == "This is the actual role."

    def test_instructions_heading_exact_match_only(self) -> None:
        content = """---
spec_version: "0.3.0"
---

# Role
This is the role.

# Instructions for developers
This should NOT be parsed as instructions.

# Instructions
These are the actual instructions.
"""
        result = parse_afm(content)
        assert "for developers" not in result.instructions
        assert "This should NOT be parsed as instructions." not in result.instructions
        assert result.instructions == "These are the actual instructions."

    def test_case_insensitive_headings(self) -> None:
        content = """---
spec_version: "0.3.0"
---

# ROLE
This is the role.

# INSTRUCTIONS
These are the instructions.
"""
        result = parse_afm(content)
        assert result.role == "This is the role."
        assert result.instructions == "These are the instructions."


class TestParseAfmFile:
    def test_parse_file(self, sample_agent_path: Path) -> None:
        result = parse_afm_file(sample_agent_path)
        assert result.metadata.name == "TestAgent"

    def test_parse_nonexistent_file(self) -> None:
        with pytest.raises(FileNotFoundError):
            parse_afm_file("/nonexistent/path/agent.afm.md")


class TestParseStdioMcpTransport:
    def test_parse_stdio_mcp_agent(self, sample_stdio_mcp_path: Path) -> None:
        content = sample_stdio_mcp_path.read_text()
        result = parse_afm(content)

        assert result.metadata.name == "StdioMcpAgent"
        assert result.metadata.tools is not None
        assert result.metadata.tools.mcp is not None
        assert len(result.metadata.tools.mcp) == 2

        # First server: no args env, no tool_filter
        server1 = result.metadata.tools.mcp[0]
        assert server1.name == "filesystem_server"
        assert isinstance(server1.transport, StdioTransport)
        assert server1.transport.type == "stdio"
        assert server1.transport.command == "npx"
        assert server1.transport.args == [
            "-y",
            "@modelcontextprotocol/server-filesystem",
            "/tmp",
        ]
        assert server1.transport.env is None
        assert server1.tool_filter is None

        # Second server: has env and tool_filter
        server2 = result.metadata.tools.mcp[1]
        assert server2.name == "local_db_tool"
        assert isinstance(server2.transport, StdioTransport)
        assert server2.transport.type == "stdio"
        assert server2.transport.command == "python"
        assert server2.transport.args == ["server.py"]
        assert server2.transport.env == {"DB_PATH": "./data.db", "API_KEY": "dummy-key"}
        assert server2.tool_filter is not None
        assert server2.tool_filter.allow == ["query", "search"]
        assert server2.tool_filter.deny == ["delete"]

    def test_parse_stdio_transport_inline(self) -> None:
        content = """---
spec_version: "0.3.0"
tools:
  mcp:
    - name: "local_tool"
      transport:
        type: stdio
        command: "python"
        args:
          - "server.py"
---

# Role
Test role.

# Instructions
Test instructions.
"""
        result = parse_afm(content)

        assert result.metadata.tools is not None
        assert result.metadata.tools.mcp is not None
        mcp_server = result.metadata.tools.mcp[0]
        assert isinstance(mcp_server.transport, StdioTransport)
        assert mcp_server.transport.command == "python"
        assert mcp_server.transport.args == ["server.py"]
        assert mcp_server.transport.env is None

    def test_parse_http_transport_produces_http_transport_instance(self) -> None:
        content = """---
spec_version: "0.3.0"
tools:
  mcp:
    - name: "remote_tool"
      transport:
        type: http
        url: "https://example.com/mcp"
---

# Role
Test role.

# Instructions
Test instructions.
"""
        result = parse_afm(content)

        assert result.metadata.tools is not None
        assert result.metadata.tools.mcp is not None
        mcp_server = result.metadata.tools.mcp[0]
        assert isinstance(mcp_server.transport, HttpTransport)
        assert mcp_server.transport.url == "https://example.com/mcp"

    def test_parse_stdio_transport_missing_command_raises_error(self) -> None:
        content = """---
spec_version: "0.3.0"
tools:
  mcp:
    - name: "broken_tool"
      transport:
        type: stdio
---

# Role
Test role.

# Instructions
Test instructions.
"""
        with pytest.raises(AFMValidationError):
            parse_afm(content)

    def test_parse_mixed_http_and_stdio_transports(self) -> None:
        content = """---
spec_version: "0.3.0"
tools:
  mcp:
    - name: "remote_server"
      transport:
        type: http
        url: "https://api.example.com/mcp"
    - name: "local_server"
      transport:
        type: stdio
        command: "npx"
        args:
          - "-y"
          - "@modelcontextprotocol/server-filesystem"
          - "/tmp"
---

# Role
Test role.

# Instructions
Test instructions.
"""
        result = parse_afm(content)

        assert result.metadata.tools is not None
        assert result.metadata.tools.mcp is not None
        assert len(result.metadata.tools.mcp) == 2
        assert isinstance(result.metadata.tools.mcp[0].transport, HttpTransport)
        assert isinstance(result.metadata.tools.mcp[1].transport, StdioTransport)


class TestResolveEnvParameter:
    def test_parse_afm_without_resolve_env_preserves_variables(self) -> None:
        """Test that resolve_env=False preserves ${env:VAR} syntax in string fields."""
        content = """---
spec_version: "0.3.0"
name: "TestAgent"
model:
  provider: "openai"
  name: "gpt-4"
  authentication:
    type: "bearer"
    token: "${env:UNSET_API_TOKEN}"
---

# Role
Test role

# Instructions
Test instructions
"""
        # Should parse successfully without resolving env variables
        result = parse_afm(content, resolve_env=False)

        assert result.metadata.name == "TestAgent"
        assert result.metadata.model is not None
        assert result.metadata.model.authentication is not None
        # Variable should be preserved as-is
        assert result.metadata.model.authentication.token == "${env:UNSET_API_TOKEN}"

    def test_parse_afm_with_resolve_env_fails_on_missing_var(self) -> None:
        """Test that resolve_env=True (default) raises error for unset env variables."""
        content = """---
spec_version: "0.3.0"
name: "TestAgent"
model:
  provider: "openai"
  name: "gpt-4"
  authentication:
    type: "bearer"
    token: "${env:UNSET_API_TOKEN_XYZ123}"
---

# Role
Test role

# Instructions
Test instructions
"""
        # Should fail when trying to resolve missing env variable
        with pytest.raises(VariableResolutionError) as exc_info:
            parse_afm(content, resolve_env=True)

        assert "UNSET_API_TOKEN_XYZ123" in str(exc_info.value)

    def test_parse_afm_default_behavior_resolves_env(self, monkeypatch) -> None:
        """Test that default behavior (no resolve_env parameter) resolves env variables."""
        # Set an environment variable
        monkeypatch.setenv("TEST_TOKEN_VALUE", "secret-token-123")

        content = """---
spec_version: "0.3.0"
name: "TestAgent"
model:
  provider: "openai"
  name: "gpt-4"
  authentication:
    type: "bearer"
    token: "${env:TEST_TOKEN_VALUE}"
---

# Role
Test role

# Instructions
Test instructions
"""
        # Default behavior should resolve variables
        result = parse_afm(content)

        assert result.metadata.model is not None
        assert result.metadata.model.authentication is not None
        assert result.metadata.model.authentication.token == "secret-token-123"


class TestClientAuthenticationValidation:

    def test_bearer_valid(self) -> None:
        auth = ClientAuthentication(type="bearer", token="t")
        assert auth.type == "bearer"
        assert auth.token == "t"

    def test_basic_valid(self) -> None:
        auth = ClientAuthentication(type="basic", username="u", password="p")
        assert auth.username == "u"
        assert auth.password == "p"

    def test_api_key_valid(self) -> None:
        auth = ClientAuthentication(type="api-key", api_key="k")
        assert auth.api_key == "k"
        assert auth.header_name is None

    def test_api_key_with_header_name(self) -> None:
        auth = ClientAuthentication(type="api-key", api_key="k", header_name="X-API-Key")
        assert auth.header_name == "X-API-Key"

    def test_type_is_case_insensitive(self) -> None:
        auth = ClientAuthentication(type="Bearer", token="t")
        assert auth.token == "t"

    def test_jwt_valid(self) -> None:
        auth = ClientAuthentication(
            type="jwt",
            issuer="afm-agent",
            audience="https://api.example.com",
            signing_key="secret",
        )
        assert auth.issuer == "afm-agent"
        assert auth.audience == "https://api.example.com"

    def test_jwt_audience_list(self) -> None:
        auth = ClientAuthentication(
            type="jwt", issuer="i", audience=["a", "b"], signing_key="s"
        )
        assert auth.audience == ["a", "b"]

    def test_jwt_missing_signing_key_rejected(self) -> None:
        with pytest.raises(
            ValidationError, match="type 'jwt' requires 'signing_key'"
        ):
            ClientAuthentication(type="jwt", issuer="i", audience="a")

    def test_jwt_unknown_field_rejected(self) -> None:
        with pytest.raises(ValidationError, match="does not support"):
            ClientAuthentication(
                type="jwt", issuer="i", audience="a", signing_key="s", token="x"
            )

    def test_oauth2_client_credentials_valid(self) -> None:
        auth = ClientAuthentication(
            type="oauth2",
            grant_type="client_credentials",
            token_url="https://auth.example.com/token",
            client_id="id",
            client_secret="secret",
            scopes=["read", "write"],
        )
        assert auth.grant_type == "client_credentials"
        assert auth.scopes == ["read", "write"]

    def test_oauth2_password_valid(self) -> None:
        auth = ClientAuthentication(
            type="oauth2",
            grant_type="password",
            token_url="https://auth.example.com/token",
            username="u",
            password="p",
            client_id="id",
            client_secret="secret",
        )
        assert auth.grant_type == "password"

    def test_oauth2_refresh_token_valid(self) -> None:
        auth = ClientAuthentication(
            type="oauth2",
            grant_type="refresh_token",
            refresh_url="https://auth.example.com/token",
            refresh_token="rt",
            client_id="id",
            client_secret="secret",
        )
        assert auth.grant_type == "refresh_token"

    def test_oauth2_jwt_bearer_valid(self) -> None:
        auth = ClientAuthentication(
            type="oauth2",
            grant_type="jwt_bearer",
            token_url="https://auth.example.com/token",
            assertion="signed.jwt.token",
        )
        assert auth.grant_type == "jwt_bearer"

    def test_oauth2_grant_type_case_insensitive(self) -> None:
        auth = ClientAuthentication(
            type="oauth2",
            grant_type="Client_Credentials",
            token_url="u",
            client_id="id",
            client_secret="secret",
        )
        assert auth.grant_type == "Client_Credentials"

    def test_oauth2_missing_grant_type_rejected(self) -> None:
        with pytest.raises(
            ValidationError, match="type 'oauth2' requires 'grant_type'"
        ):
            ClientAuthentication(type="oauth2", token_url="u")

    def test_oauth2_unknown_grant_type_rejected(self) -> None:
        with pytest.raises(
            ValidationError, match="grant_type 'device_code' is not supported"
        ):
            ClientAuthentication(
                type="oauth2", grant_type="device_code", token_url="u"
            )

    def test_oauth2_missing_required_field_rejected(self) -> None:
        with pytest.raises(
            ValidationError,
            match="grant_type 'client_credentials' requires 'client_secret'",
        ):
            ClientAuthentication(
                type="oauth2",
                grant_type="client_credentials",
                token_url="u",
                client_id="id",
            )

    def test_oauth2_field_not_allowed_for_grant_rejected(self) -> None:
        with pytest.raises(ValidationError, match="does not support 'refresh_token'"):
            ClientAuthentication(
                type="oauth2",
                grant_type="client_credentials",
                token_url="u",
                client_id="id",
                client_secret="secret",
                refresh_token="rt",
            )

    def test_unknown_type_rejected(self) -> None:
        with pytest.raises(ValidationError, match="unknown authentication type 'token'"):
            ClientAuthentication(type="token", token="t")

    def test_bearer_missing_token_rejected(self) -> None:
        with pytest.raises(ValidationError, match="type 'bearer' requires 'token'"):
            ClientAuthentication(type="bearer")

    def test_basic_missing_password_rejected(self) -> None:
        with pytest.raises(ValidationError, match="type 'basic' requires 'password'"):
            ClientAuthentication(type="basic", username="u")

    def test_api_key_missing_key_rejected(self) -> None:
        with pytest.raises(ValidationError, match="type 'api-key' requires 'api_key'"):
            ClientAuthentication(type="api-key")

    def test_unknown_field_rejected(self) -> None:
        with pytest.raises(
            ValidationError, match="type 'bearer' does not support 'username'"
        ):
            ClientAuthentication(type="bearer", token="t", username="u")

    def test_typo_field_rejected(self) -> None:
        with pytest.raises(ValidationError):
            ClientAuthentication(type="api-key", api_key="k", headername="X")

    def test_invalid_auth_fails_at_parse_time(self) -> None:
        content = """---
model:
  provider: openai
  name: gpt-4
  authentication:
    type: bearer
---

# Role
Role

# Instructions
Instructions
"""
        with pytest.raises(AFMValidationError):
            parse_afm(content)
