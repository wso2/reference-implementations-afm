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

from afm.exceptions import AFMParseError, AFMValidationError, VariableResolutionError
from afm.models import ConsoleChatInterface, WebChatInterface, WebhookInterface
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
