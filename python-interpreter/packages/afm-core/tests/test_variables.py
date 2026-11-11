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

import pytest

from afm.exceptions import AFMValidationError, VariableResolutionError
from afm.models import (
    AFMRecord,
    AgentMetadata,
    MCPServer,
    Model,
    StdioTransport,
    Tools,
)
from afm.variables import resolve_variables, validate_http_variables


class TestResolveVariables:
    def test_returns_plain_string(self) -> None:
        content = "This is a plain string"
        assert resolve_variables(content) == content

    def test_resolves_env_variable(self, monkeypatch) -> None:
        monkeypatch.setenv("TEST_VAR", "resolved-value")
        assert resolve_variables("Value: ${env:TEST_VAR}") == "Value: resolved-value"

    def test_resolves_env_variable_without_prefix(self, monkeypatch) -> None:
        monkeypatch.setenv("TEST_VAR", "resolved-value")
        assert resolve_variables("Value: ${TEST_VAR}") == "Value: resolved-value"

    def test_raises_error_for_missing_env_variable(self) -> None:
        with pytest.raises(VariableResolutionError) as exc_info:
            resolve_variables("${env:NONEXISTENT_VAR_12345}")
        assert "NONEXISTENT_VAR_12345" in str(exc_info.value)

    def test_raises_error_for_unsupported_prefix(self) -> None:
        with pytest.raises(VariableResolutionError) as exc_info:
            resolve_variables("${unsupported:VAR}")
        assert "unsupported" in str(exc_info.value)

    def test_skips_commented_variables(self, monkeypatch) -> None:
        monkeypatch.setenv("TEST_VAR", "value")
        content = "# ${env:TEST_VAR}\nActual: ${env:TEST_VAR}"
        # The first one should remain as is if it's detected as a comment line
        # Note: Current implementation of resolve_variables has some basic comment skipping
        result = resolve_variables(content)
        assert "# ${env:TEST_VAR}" in result
        assert "Actual: value" in result

    def test_skips_http_variables(self) -> None:
        content = "Payload: ${http:payload.name}"
        assert resolve_variables(content) == content


def _make_afm_record_with_stdio_transport(
    args: list[str] | None = None,
    env: dict[str, str] | None = None,
    command: str = "npx",
) -> AFMRecord:
    """Helper to create a minimal AFMRecord with a StdioTransport MCP server."""
    return AFMRecord(
        metadata=AgentMetadata(
            tools=Tools(
                mcp=[
                    MCPServer(
                        name="test-server",
                        transport=StdioTransport(
                            command=command,
                            args=args,
                            env=env,
                        ),
                    )
                ]
            )
        ),
        role="Test role",
        instructions="Test instructions",
    )


class TestValidateHttpVariablesStdioTransport:
    def test_args_reports_individual_indices(self) -> None:
        record = _make_afm_record_with_stdio_transport(
            args=[
                "${http:payload.url}",
                "clean-arg",
                "${http:header.auth}",
            ]
        )
        with pytest.raises(AFMValidationError) as exc_info:
            validate_http_variables(record)
        msg = str(exc_info.value)
        assert "tools.mcp.transport.args[0]" in msg
        assert "tools.mcp.transport.args[1]" not in msg
        assert "tools.mcp.transport.args[2]" in msg

    def test_env_reports_individual_keys(self) -> None:
        record = _make_afm_record_with_stdio_transport(
            env={
                "SECRET_KEY": "${http:payload.secret}",
                "CLEAN_VAR": "plain-value",
                "API_URL": "${http:payload.api}",
            }
        )
        with pytest.raises(AFMValidationError) as exc_info:
            validate_http_variables(record)
        msg = str(exc_info.value)
        assert "tools.mcp.transport.env.SECRET_KEY" in msg
        assert "tools.mcp.transport.env.CLEAN_VAR" not in msg
        assert "tools.mcp.transport.env.API_URL" in msg

    def test_command_reports_violation(self) -> None:
        record = _make_afm_record_with_stdio_transport(command="${http:payload.cmd}")
        with pytest.raises(AFMValidationError) as exc_info:
            validate_http_variables(record)
        assert "tools.mcp.transport.command" in str(exc_info.value)

    def test_no_error_when_no_http_variables(self) -> None:
        record = _make_afm_record_with_stdio_transport(
            command="npx",
            args=["--port", "3000"],
            env={"HOME": "/home/user"},
        )
        # Should not raise
        validate_http_variables(record)


class TestValidateHttpVariablesModelProviderOptions:
    def test_reports_individual_keys(self) -> None:
        record = AFMRecord(
            metadata=AgentMetadata(
                model=Model(
                    provider="gemini",
                    provider_options={
                        "project": "${http:payload.project}",
                        "location": "us-central1",
                    },
                )
            ),
            role="Role",
            instructions="Instructions",
        )
        with pytest.raises(AFMValidationError) as exc_info:
            validate_http_variables(record)
        msg = str(exc_info.value)
        assert "model.provider_options.project" in msg
        assert "model.provider_options.location" not in msg
