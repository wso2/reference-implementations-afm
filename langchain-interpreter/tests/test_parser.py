# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Tests for the AFM parser module."""

from pathlib import Path

import pytest

from langchain_interpreter import (
    AFMParseError,
    AFMValidationError,
    ConsoleChatInterface,
    WebChatInterface,
    WebhookInterface,
    parse_afm,
    parse_afm_file,
    validate_and_extract_interfaces,
)


class TestParseAfm:
    """Tests for the parse_afm function."""

    def test_parse_full_agent(self, sample_agent_path: Path) -> None:
        """Test parsing a full AFM file with all fields."""
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
        """Test parsing a console chat agent."""
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

    def test_parse_webhook_agent(self, sample_webhook_path: Path) -> None:
        """Test parsing a webhook agent."""
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
        """Test parsing a minimal AFM file."""
        content = sample_minimal_path.read_text()
        result = parse_afm(content)

        assert result.metadata.spec_version == "0.3.0"
        assert result.role == "Agent role here."
        assert result.instructions == "Agent instructions here."

    def test_parse_no_frontmatter(self, sample_no_frontmatter_path: Path) -> None:
        """Test parsing AFM without frontmatter (allowed in Python impl)."""
        content = sample_no_frontmatter_path.read_text()
        result = parse_afm(content)

        # Should have empty metadata
        assert result.metadata.spec_version is None
        assert result.metadata.name is None

        # Should have role and instructions
        assert result.role == "This is the role without frontmatter."
        assert result.instructions == "These are instructions without frontmatter."

    def test_parse_empty_frontmatter(self) -> None:
        """Test parsing AFM with empty frontmatter."""
        content = """---
---

# Role
The role.

# Instructions
The instructions.
"""
        result = parse_afm(content)
        assert result.metadata.spec_version is None
        assert result.role == "The role."
        assert result.instructions == "The instructions."

    def test_parse_unclosed_frontmatter(self) -> None:
        """Test that unclosed frontmatter raises an error."""
        content = """---
spec_version: "0.3.0"

# Role
The role.
"""
        with pytest.raises(AFMParseError) as exc_info:
            parse_afm(content)
        assert "Unclosed frontmatter" in str(exc_info.value)

    def test_parse_invalid_yaml(self) -> None:
        """Test that invalid YAML raises an error."""
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
        """Test that invalid field types raise validation error."""
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
        """Test parsing multiline role and instructions."""
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


class TestParseAfmFile:
    """Tests for the parse_afm_file function."""

    def test_parse_file(self, sample_agent_path: Path) -> None:
        """Test parsing from a file path."""
        result = parse_afm_file(sample_agent_path)
        assert result.metadata.name == "TestAgent"

    def test_parse_file_string_path(self, sample_agent_path: Path) -> None:
        """Test parsing from a string file path."""
        result = parse_afm_file(str(sample_agent_path))
        assert result.metadata.name == "TestAgent"

    def test_parse_nonexistent_file(self) -> None:
        """Test that parsing a nonexistent file raises an error."""
        with pytest.raises(FileNotFoundError):
            parse_afm_file("/nonexistent/path/agent.afm.md")


class TestValidateAndExtractInterfaces:
    """Tests for the validate_and_extract_interfaces function."""

    def test_single_consolechat(self) -> None:
        """Test extracting a single console chat interface."""
        interfaces = [ConsoleChatInterface()]
        console, web, webhook = validate_and_extract_interfaces(interfaces)

        assert console is not None
        assert isinstance(console, ConsoleChatInterface)
        assert web is None
        assert webhook is None

    def test_single_webchat(self) -> None:
        """Test extracting a single web chat interface."""
        interfaces = [WebChatInterface()]
        console, web, webhook = validate_and_extract_interfaces(interfaces)

        assert console is None
        assert web is not None
        assert isinstance(web, WebChatInterface)
        assert webhook is None

    def test_mixed_interfaces(self) -> None:
        """Test extracting mixed interface types."""
        interfaces = [ConsoleChatInterface(), WebChatInterface()]
        console, web, webhook = validate_and_extract_interfaces(interfaces)

        assert console is not None
        assert web is not None
        assert webhook is None

    def test_duplicate_consolechat_error(self) -> None:
        """Test that duplicate console chat interfaces raise an error."""
        interfaces = [ConsoleChatInterface(), ConsoleChatInterface()]

        with pytest.raises(AFMValidationError) as exc_info:
            validate_and_extract_interfaces(interfaces)
        assert "Multiple interfaces" in str(exc_info.value)

    def test_duplicate_webchat_error(self) -> None:
        """Test that duplicate web chat interfaces raise an error."""
        interfaces = [WebChatInterface(), WebChatInterface()]

        with pytest.raises(AFMValidationError) as exc_info:
            validate_and_extract_interfaces(interfaces)
        assert "Multiple interfaces" in str(exc_info.value)

    def test_empty_interfaces(self) -> None:
        """Test extracting from empty interface list."""
        interfaces: list = []
        console, web, webhook = validate_and_extract_interfaces(interfaces)

        assert console is None
        assert web is None
        assert webhook is None
