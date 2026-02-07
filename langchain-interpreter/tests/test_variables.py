# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Tests for the variable substitution module."""

import pytest

from langchain_interpreter import (
    AFMValidationError,
    VariableResolutionError,
    WebhookInterface,
    contains_http_variable,
    parse_afm,
    resolve_variables,
)


class TestResolveVariables:
    """Tests for the resolve_variables function."""

    def test_resolve_env_prefix(self, env_vars) -> None:
        """Test resolving variables with env: prefix."""
        env_vars.set("TEST_VAR_1", "test_value")
        content = "Config: ${env:TEST_VAR_1}"
        result = resolve_variables(content)
        assert result == "Config: test_value"

    def test_resolve_without_prefix(self, env_vars) -> None:
        """Test resolving variables without prefix (bare env vars)."""
        env_vars.set("TEST_VAR_2", "another_value")
        content = "Value: ${TEST_VAR_2}"
        result = resolve_variables(content)
        assert result == "Value: another_value"

    def test_missing_env_var_error(self) -> None:
        """Test that missing environment variables raise an error."""
        content = "Config: ${NONEXISTENT_VAR_XYZ}"
        with pytest.raises(VariableResolutionError) as exc_info:
            resolve_variables(content)
        assert "NONEXISTENT_VAR_XYZ" in str(exc_info.value)
        assert "not found" in str(exc_info.value)

    def test_skip_http_variables(self) -> None:
        """Test that http: variables are NOT resolved (preserved for runtime)."""
        content = "Webhook: ${http:payload.field}"
        result = resolve_variables(content)
        assert result == "Webhook: ${http:payload.field}"

    def test_resolve_multiple_variables(self, env_vars) -> None:
        """Test resolving multiple variables in one string."""
        env_vars.set("VAR_A", "valueA")
        env_vars.set("VAR_B", "valueB")
        content = "${VAR_A} and ${env:VAR_B}"
        result = resolve_variables(content)
        assert result == "valueA and valueB"

    def test_skip_variables_in_comments(self, env_vars) -> None:
        """Test that variables in YAML comments are not resolved."""
        env_vars.set("COMMENT_VAR", "should_not_replace")
        content = "# This is a comment with ${COMMENT_VAR}"
        result = resolve_variables(content)
        assert result == "# This is a comment with ${COMMENT_VAR}"

    def test_unsupported_prefix_error(self) -> None:
        """Test that unsupported prefixes raise an error."""
        content = "Secret: ${secret:MY_SECRET}"
        with pytest.raises(VariableResolutionError) as exc_info:
            resolve_variables(content)
        assert "Unsupported variable prefix" in str(exc_info.value)
        assert "secret:" in str(exc_info.value)

    def test_empty_content(self) -> None:
        """Test resolving empty content."""
        result = resolve_variables("")
        assert result == ""

    def test_no_variables(self) -> None:
        """Test content with no variables."""
        content = "Just plain text"
        result = resolve_variables(content)
        assert result == "Just plain text"

    def test_unclosed_variable(self) -> None:
        """Test handling unclosed variable syntax."""
        content = "Unclosed: ${VAR"
        result = resolve_variables(content)
        assert result == "Unclosed: ${VAR"

    def test_adjacent_variables(self, env_vars) -> None:
        """Test variables directly adjacent to each other."""
        env_vars.set("A", "1")
        env_vars.set("B", "2")
        content = "${A}${B}"
        result = resolve_variables(content)
        assert result == "12"

    def test_variable_in_multiline(self, env_vars) -> None:
        """Test variable resolution across multiline content."""
        env_vars.set("MULTI_VAR", "value")
        content = "Line 1\nLine 2 with ${MULTI_VAR}\nLine 3"
        result = resolve_variables(content)
        assert result == "Line 1\nLine 2 with value\nLine 3"


class TestContainsHttpVariable:
    """Tests for the contains_http_variable function."""

    def test_contains_payload_variable(self) -> None:
        """Test detecting payload variables."""
        assert contains_http_variable("${http:payload.field}")
        assert contains_http_variable("text ${http:payload.field} more")

    def test_contains_header_variable(self) -> None:
        """Test detecting header variables."""
        assert contains_http_variable("${http:header.Authorization}")

    def test_no_http_variable(self) -> None:
        """Test strings without http: variables."""
        assert not contains_http_variable("${env:VAR}")
        assert not contains_http_variable("no variables here")
        assert not contains_http_variable("http: in plain text")

    def test_empty_string(self) -> None:
        """Test empty string."""
        assert not contains_http_variable("")


class TestValidateHttpVariables:
    """Tests for http: variable validation in AFM parsing."""

    def test_http_in_role_fails(self) -> None:
        """Test that http: variables in role section fail validation."""
        content = """---
spec_version: "0.3.0"
---

# Role
Role with ${http:payload.field}.

# Instructions
Valid instructions.
"""
        with pytest.raises(AFMValidationError) as exc_info:
            parse_afm(content)
        assert "role" in str(exc_info.value)

    def test_http_in_instructions_fails(self) -> None:
        """Test that http: variables in instructions section fail validation."""
        content = """---
spec_version: "0.3.0"
---

# Role
Valid role.

# Instructions
Instructions with ${http:payload.data}.
"""
        with pytest.raises(AFMValidationError) as exc_info:
            parse_afm(content)
        assert "instructions" in str(exc_info.value)

    def test_http_in_metadata_fields_fails(self) -> None:
        """Test that http: variables in metadata fields fail validation."""
        content = """---
spec_version: "0.3.0"
name: "Agent ${http:payload.name}"
---

# Role
Valid role.

# Instructions
Valid instructions.
"""
        with pytest.raises(AFMValidationError) as exc_info:
            parse_afm(content)
        assert "name" in str(exc_info.value)

    def test_http_in_webhook_prompt_allowed(self) -> None:
        """Test that http: variables in webhook prompt are allowed."""
        content = """---
spec_version: "0.3.0"
interfaces:
  - type: webhook
    prompt: "Event: ${http:payload.event}"
    subscription:
      protocol: "websub"
---

# Role
Valid role.

# Instructions
Valid instructions.
"""
        # Should not raise
        result = parse_afm(content)
        assert result.metadata.interfaces is not None
        webhook = result.metadata.interfaces[0]
        assert isinstance(webhook, WebhookInterface)
        assert webhook.prompt is not None
        assert "${http:payload.event}" in webhook.prompt

    def test_http_in_schema_extra_fields_fails(self):
        """Test that http: variables in JSONSchema extra fields are rejected."""
        # Test with 'default' extra field
        content = """---
spec_version: "0.3.0"
interfaces:
  - type: webchat
    signature:
      input:
        type: object
        properties:
          status:
            type: string
            default: "${http:payload.status}"
---

# Role
Valid role.

# Instructions
Valid instructions.
"""
        with pytest.raises(AFMValidationError) as exc_info:
            parse_afm(content)
        assert "http: variables are only supported in webhook prompt fields" in str(
            exc_info.value
        )
        assert "interfaces.webchat.signature" in str(exc_info.value)

        # Test with 'enum' extra field
        content2 = """---
spec_version: "0.3.0"
interfaces:
  - type: webchat
    signature:
      output:
        type: object
        properties:
          category:
            type: string
            enum:
              - "${http:payload.category}"
              - "other"
---

# Role
Valid role.

# Instructions
Valid instructions.
"""
        with pytest.raises(AFMValidationError) as exc_info:
            parse_afm(content2)
        assert "interfaces.webchat.signature" in str(exc_info.value)
