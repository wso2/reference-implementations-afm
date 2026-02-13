# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

import pytest
import os
from afm.variables import resolve_variables
from afm.exceptions import VariableResolutionError


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

    def test_skips_commented_variables(self) -> None:
        content = "# ${env:TEST_VAR}\nActual: ${env:TEST_VAR}"
        os.environ["TEST_VAR"] = "value"
        # The first one should remain as is if it's detected as a comment line
        # Note: Current implementation of resolve_variables has some basic comment skipping
        result = resolve_variables(content)
        assert "# ${env:TEST_VAR}" in result
        assert "Actual: value" in result

    def test_skips_http_variables(self) -> None:
        content = "Payload: ${http:payload.name}"
        assert resolve_variables(content) == content
