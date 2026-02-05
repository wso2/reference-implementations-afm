# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Tests for LLM provider factory."""

from unittest.mock import MagicMock, patch

import pytest

from langchain_interpreter.exceptions import ProviderError
from langchain_interpreter.models import ClientAuthentication, Model
from langchain_interpreter.providers import (
    ANTHROPIC_API_KEY_ENV,
    DEFAULT_ANTHROPIC_MODEL,
    DEFAULT_OPENAI_MODEL,
    OPENAI_API_KEY_ENV,
    _get_api_key,
    create_model_provider,
    get_supported_providers,
)


# =============================================================================
# create_model_provider Tests
# =============================================================================


class TestCreateModelProvider:
    """Tests for create_model_provider function."""

    @patch.dict("os.environ", {OPENAI_API_KEY_ENV: "test-openai-key"}, clear=True)
    @patch("langchain_openai.ChatOpenAI")
    def test_default_to_openai_when_no_model(self, mock_chat_openai: MagicMock) -> None:
        """Test that None model defaults to OpenAI."""
        mock_chat_openai.return_value = MagicMock()

        result = create_model_provider(None)

        mock_chat_openai.assert_called_once()
        call_kwargs = mock_chat_openai.call_args[1]
        assert call_kwargs["api_key"] == "test-openai-key"
        assert call_kwargs["model"] == DEFAULT_OPENAI_MODEL

    @patch.dict("os.environ", {OPENAI_API_KEY_ENV: "test-openai-key"}, clear=True)
    @patch("langchain_openai.ChatOpenAI")
    def test_openai_provider_explicit(self, mock_chat_openai: MagicMock) -> None:
        """Test explicit OpenAI provider."""
        mock_chat_openai.return_value = MagicMock()
        model = Model(provider="openai", name="gpt-4-turbo")

        result = create_model_provider(model)

        mock_chat_openai.assert_called_once()
        call_kwargs = mock_chat_openai.call_args[1]
        assert call_kwargs["model"] == "gpt-4-turbo"

    @patch.dict("os.environ", {ANTHROPIC_API_KEY_ENV: "test-anthropic-key"}, clear=True)
    @patch("langchain_anthropic.ChatAnthropic")
    def test_anthropic_provider(self, mock_chat_anthropic: MagicMock) -> None:
        """Test Anthropic provider."""
        mock_chat_anthropic.return_value = MagicMock()
        model = Model(provider="anthropic", name="claude-3-opus-20240229")

        result = create_model_provider(model)

        mock_chat_anthropic.assert_called_once()
        call_kwargs = mock_chat_anthropic.call_args[1]
        assert call_kwargs["api_key"] == "test-anthropic-key"
        assert call_kwargs["model"] == "claude-3-opus-20240229"

    @patch.dict("os.environ", {ANTHROPIC_API_KEY_ENV: "test-key"}, clear=True)
    @patch("langchain_anthropic.ChatAnthropic")
    def test_anthropic_default_model(self, mock_chat_anthropic: MagicMock) -> None:
        """Test Anthropic provider with default model."""
        mock_chat_anthropic.return_value = MagicMock()
        model = Model(provider="anthropic")

        result = create_model_provider(model)

        call_kwargs = mock_chat_anthropic.call_args[1]
        assert call_kwargs["model"] == DEFAULT_ANTHROPIC_MODEL

    @patch.dict("os.environ", {OPENAI_API_KEY_ENV: "test-key"}, clear=True)
    @patch("langchain_openai.ChatOpenAI")
    def test_openai_with_custom_url(self, mock_chat_openai: MagicMock) -> None:
        """Test OpenAI provider with custom base URL."""
        mock_chat_openai.return_value = MagicMock()
        model = Model(
            provider="openai",
            name="gpt-4",
            url="https://custom-api.example.com/v1",
        )

        result = create_model_provider(model)

        call_kwargs = mock_chat_openai.call_args[1]
        assert call_kwargs["base_url"] == "https://custom-api.example.com/v1"

    @patch.dict("os.environ", {OPENAI_API_KEY_ENV: "env-key"}, clear=True)
    @patch("langchain_openai.ChatOpenAI")
    def test_api_key_from_bearer_auth(self, mock_chat_openai: MagicMock) -> None:
        """Test API key extraction from bearer authentication."""
        mock_chat_openai.return_value = MagicMock()
        model = Model(
            provider="openai",
            authentication=ClientAuthentication(type="bearer", token="bearer-token"),
        )

        result = create_model_provider(model)

        call_kwargs = mock_chat_openai.call_args[1]
        assert call_kwargs["api_key"] == "bearer-token"

    @patch.dict("os.environ", {OPENAI_API_KEY_ENV: "env-key"}, clear=True)
    @patch("langchain_openai.ChatOpenAI")
    def test_api_key_from_api_key_auth(self, mock_chat_openai: MagicMock) -> None:
        """Test API key extraction from api-key authentication."""
        mock_chat_openai.return_value = MagicMock()
        model = Model(
            provider="openai",
            authentication=ClientAuthentication(
                type="api-key", api_key="explicit-api-key"
            ),
        )

        result = create_model_provider(model)

        call_kwargs = mock_chat_openai.call_args[1]
        assert call_kwargs["api_key"] == "explicit-api-key"

    def test_unsupported_provider_raises_error(self) -> None:
        """Test that unsupported provider raises ProviderError."""
        model = Model(provider="unsupported-provider")

        with pytest.raises(ProviderError) as exc_info:
            create_model_provider(model)

        assert "Unsupported provider" in str(exc_info.value)
        assert exc_info.value.provider == "unsupported-provider"

    @patch.dict("os.environ", {}, clear=True)
    def test_missing_api_key_raises_error(self) -> None:
        """Test that missing API key raises ProviderError."""
        model = Model(provider="openai")

        with pytest.raises(ProviderError) as exc_info:
            create_model_provider(model)

        assert "No API key found" in str(exc_info.value)
        assert OPENAI_API_KEY_ENV in str(exc_info.value)

    @patch.dict("os.environ", {OPENAI_API_KEY_ENV: "test-key"}, clear=True)
    @patch("langchain_openai.ChatOpenAI")
    def test_provider_case_insensitive(self, mock_chat_openai: MagicMock) -> None:
        """Test that provider name is case-insensitive."""
        mock_chat_openai.return_value = MagicMock()
        model = Model(provider="OpenAI")  # Mixed case

        result = create_model_provider(model)

        mock_chat_openai.assert_called_once()


# =============================================================================
# _get_api_key Tests
# =============================================================================


class TestGetApiKey:
    """Tests for _get_api_key function."""

    @patch.dict("os.environ", {}, clear=True)
    def test_get_from_bearer_token(self) -> None:
        """Test getting API key from bearer token."""
        auth = ClientAuthentication(type="bearer", token="my-bearer-token")
        result = _get_api_key(auth, "UNUSED_ENV", "test")
        assert result == "my-bearer-token"

    @patch.dict("os.environ", {}, clear=True)
    def test_get_from_api_key(self) -> None:
        """Test getting API key from api-key auth."""
        auth = ClientAuthentication(type="api-key", api_key="my-api-key")
        result = _get_api_key(auth, "UNUSED_ENV", "test")
        assert result == "my-api-key"

    @patch.dict("os.environ", {"TEST_API_KEY": "env-api-key"}, clear=True)
    def test_fallback_to_env_var(self) -> None:
        """Test falling back to environment variable."""
        result = _get_api_key(None, "TEST_API_KEY", "test")
        assert result == "env-api-key"

    @patch.dict("os.environ", {"TEST_API_KEY": "env-api-key"}, clear=True)
    def test_auth_takes_precedence_over_env(self) -> None:
        """Test that auth config takes precedence over env var."""
        auth = ClientAuthentication(type="bearer", token="auth-token")
        result = _get_api_key(auth, "TEST_API_KEY", "test")
        assert result == "auth-token"

    @patch.dict("os.environ", {}, clear=True)
    def test_missing_key_raises_error(self) -> None:
        """Test that missing key raises ProviderError."""
        with pytest.raises(ProviderError) as exc_info:
            _get_api_key(None, "MISSING_ENV", "test")
        assert "No API key found" in str(exc_info.value)

    @patch.dict("os.environ", {}, clear=True)
    def test_basic_auth_raises_error(self) -> None:
        """Test that basic auth raises ProviderError."""
        auth = ClientAuthentication(
            type="basic",
            username="user",
            password="pass",
        )
        with pytest.raises(ProviderError) as exc_info:
            _get_api_key(auth, "UNUSED_ENV", "test")
        assert "Basic authentication is not supported" in str(exc_info.value)


# =============================================================================
# get_supported_providers Tests
# =============================================================================


class TestGetSupportedProviders:
    """Tests for get_supported_providers function."""

    def test_returns_list_of_providers(self) -> None:
        """Test that it returns a list of supported providers."""
        providers = get_supported_providers()
        assert isinstance(providers, list)
        assert "openai" in providers
        assert "anthropic" in providers

    def test_providers_are_lowercase(self) -> None:
        """Test that provider names are lowercase."""
        providers = get_supported_providers()
        for provider in providers:
            assert provider == provider.lower()
