# Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
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

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

from afm.exceptions import ProviderError
from afm.models import ClientAuthentication, Model
from afm_langchain.providers import create_model_provider


class TestOpenAIProvider:
    @patch("langchain_openai.ChatOpenAI")
    def test_create_openai_with_explicit_credentials(
        self, mock_chat_openai: MagicMock
    ) -> None:
        """Verify OpenAI client creation with credentials passed in AFM metadata."""
        afm_model = Model(
            provider="openai",
            name="gpt-4o",
            authentication=ClientAuthentication(
                type="api-key", api_key="explicit-openai-token-123"
            ),
        )
        create_model_provider(afm_model)

        mock_chat_openai.assert_called_once()
        kwargs = mock_chat_openai.call_args[1]
        assert kwargs["model"] == "gpt-4o"
        assert kwargs["api_key"] == "explicit-openai-token-123"

    @patch("langchain_openai.ChatOpenAI")
    def test_create_openai_with_env_fallback(self, mock_chat_openai: MagicMock) -> None:
        """Verify OpenAI client successfully falls back to environment variables."""
        afm_model = Model(provider="openai", name="gpt-4o")

        with patch.dict(os.environ, {"OPENAI_API_KEY": "env-openai-token-456"}):
            create_model_provider(afm_model)

        mock_chat_openai.assert_called_once()
        kwargs = mock_chat_openai.call_args[1]
        assert kwargs["api_key"] == "env-openai-token-456"

    def test_create_openai_missing_credentials_fails(self) -> None:
        """Verify ProviderError is raised when no API key can be resolved."""
        afm_model = Model(provider="openai", name="gpt-4o")

        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ProviderError) as exc_info:
                create_model_provider(afm_model)
            assert "No API key found" in str(exc_info.value)
            assert exc_info.value.provider == "openai"

    def test_openai_import_error(self) -> None:
        """Verify clean package warning when the underlying langchain library is missing."""
        afm_model = Model(
            provider="openai",
            name="gpt-4o",
            authentication=ClientAuthentication(type="api-key", api_key="dummy"),
        )
        with patch.dict(sys.modules, {"langchain_openai": None}):
            with pytest.raises(ProviderError) as exc_info:
                create_model_provider(afm_model)
            assert "langchain-openai package is required" in str(exc_info.value)


class TestAnthropicProvider:
    @patch("langchain_anthropic.ChatAnthropic")
    def test_create_anthropic_with_explicit_credentials(
        self, mock_chat_anthropic: MagicMock
    ) -> None:
        """Verify Anthropic client initialization with explicit credentials."""
        afm_model = Model(
            provider="anthropic",
            name="claude-sonnet-4-5",
            authentication=ClientAuthentication(
                type="api-key", api_key="explicit-anthropic-token-123"
            ),
        )
        create_model_provider(afm_model)

        mock_chat_anthropic.assert_called_once()
        kwargs = mock_chat_anthropic.call_args[1]
        assert kwargs["model"] == "claude-sonnet-4-5"
        assert kwargs["api_key"] == "explicit-anthropic-token-123"

    @patch("langchain_anthropic.ChatAnthropic")
    def test_create_anthropic_with_env_fallback(
        self, mock_chat_anthropic: MagicMock
    ) -> None:
        """Verify Anthropic client falls back onto system environment variables."""
        afm_model = Model(provider="anthropic", name="claude-sonnet-4-5")

        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "env-anthropic-token-456"}):
            create_model_provider(afm_model)

        mock_chat_anthropic.assert_called_once()
        kwargs = mock_chat_anthropic.call_args[1]
        assert kwargs["api_key"] == "env-anthropic-token-456"

    def test_create_anthropic_missing_credentials_fails(self) -> None:
        """Verify ProviderError is raised when no API key can be resolved."""
        afm_model = Model(provider="anthropic", name="claude-sonnet-4-5")

        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ProviderError) as exc_info:
                create_model_provider(afm_model)
            assert "No API key found" in str(exc_info.value)
            assert exc_info.value.provider == "anthropic"

    def test_anthropic_import_error(self) -> None:
        """Verify clean package warning when langchain-anthropic is missing."""
        afm_model = Model(
            provider="anthropic",
            name="claude-sonnet-4-5",
            authentication=ClientAuthentication(type="api-key", api_key="dummy"),
        )
        with patch.dict(sys.modules, {"langchain_anthropic": None}):
            with pytest.raises(ProviderError) as exc_info:
                create_model_provider(afm_model)
            assert "langchain-anthropic package is required" in str(exc_info.value)


class TestGeminiProvider:
    @patch("langchain_google_genai.ChatGoogleGenerativeAI")
    def test_create_gemini_studio_explicit_credentials(
        self, mock_chat_gemini: MagicMock
    ) -> None:
        """Verify standard AI Studio pathway accepts and passes API keys cleanly."""
        afm_model = Model(
            provider="gemini",
            name="gemini-2.5-flash",
            authentication=ClientAuthentication(
                type="api-key", api_key="explicit-gemini-token-789"
            ),
        )
        create_model_provider(afm_model)

        mock_chat_gemini.assert_called_once()
        kwargs = mock_chat_gemini.call_args[1]
        assert kwargs["model"] == "gemini-2.5-flash"
        assert kwargs["api_key"] == "explicit-gemini-token-789"
        assert "vertexai" not in kwargs

    @patch("langchain_google_genai.ChatGoogleGenerativeAI")
    def test_create_gemini_studio_env_fallback(
        self, mock_chat_gemini: MagicMock
    ) -> None:
        """Verify standard AI Studio pathway falls back onto GOOGLE_API_KEY environment variables."""
        afm_model = Model(provider="gemini", name="gemini-2.5-flash")

        with patch.dict(os.environ, {"GOOGLE_API_KEY": "env-gemini-token-101"}):
            create_model_provider(afm_model)

        mock_chat_gemini.assert_called_once()
        kwargs = mock_chat_gemini.call_args[1]
        assert kwargs["api_key"] == "env-gemini-token-101"

    @patch("langchain_google_genai.ChatGoogleGenerativeAI")
    def test_create_gemini_vertex_adc_fallback(
        self, mock_chat_gemini: MagicMock
    ) -> None:
        """Verify enterprise Vertex AI path bypasses API key lookups to allow Application Default Credentials (ADC)."""
        afm_model = Model(
            provider="gemini",
            name="gemini-2.5-flash",
            provider_options={
                "project": "wso2-gcp-enterprise-sandbox",
                "location": "us-central1",
            },
        )
        create_model_provider(afm_model)

        mock_chat_gemini.assert_called_once()
        kwargs = mock_chat_gemini.call_args[1]
        assert kwargs["project"] == "wso2-gcp-enterprise-sandbox"
        assert kwargs["location"] == "us-central1"
        assert kwargs["vertexai"] is True
        assert "api_key" not in kwargs

    def test_gemini_studio_missing_credentials_fails(self) -> None:
        """Verify ProviderError is raised when the AI Studio path has no API key."""
        afm_model = Model(provider="gemini", name="gemini-2.5-flash")

        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ProviderError) as exc_info:
                create_model_provider(afm_model)
            assert "No API key found" in str(exc_info.value)
            assert exc_info.value.provider == "gemini"

    def test_gemini_vertex_rejects_authentication(self) -> None:
        """Verify Vertex AI rejects an authentication block instead of ignoring it."""
        afm_model = Model(
            provider="gemini",
            name="gemini-2.5-flash",
            provider_options={"project": "wso2-gcp-enterprise-sandbox"},
            authentication=ClientAuthentication(type="api-key", api_key="dummy"),
        )
        with pytest.raises(ProviderError) as exc_info:
            create_model_provider(afm_model)
        assert "'authentication' field is not supported" in str(exc_info.value)

    def test_gemini_location_requires_project(self) -> None:
        """Verify a location without a project is rejected instead of ignored."""
        afm_model = Model(
            provider="gemini",
            name="gemini-2.5-flash",
            provider_options={"location": "us-central1"},
        )
        with pytest.raises(ProviderError) as exc_info:
            create_model_provider(afm_model)
        assert "requires 'provider_options.project'" in str(exc_info.value)

    def test_gemini_unsupported_provider_option(self) -> None:
        """Verify a misspelled provider option is rejected instead of ignored."""
        afm_model = Model(
            provider="gemini",
            name="gemini-2.5-flash",
            provider_options={"projet": "wso2-gcp-enterprise-sandbox"},
        )
        with pytest.raises(ProviderError) as exc_info:
            create_model_provider(afm_model)
        assert "Unsupported provider_options key(s): projet" in str(exc_info.value)
        assert "Supported keys: location, project" in str(exc_info.value)

    def test_gemini_blank_provider_option(self) -> None:
        """Verify blank provider option values are rejected."""
        afm_model = Model(
            provider="gemini",
            name="gemini-2.5-flash",
            provider_options={"project": " "},
        )
        with pytest.raises(ProviderError) as exc_info:
            create_model_provider(afm_model)
        assert "must not be blank: project" in str(exc_info.value)

    def test_gemini_import_error(self) -> None:
        """Verify clean package warning when langchain-google-genai is missing."""
        afm_model = Model(
            provider="gemini",
            name="gemini-2.5-flash",
            authentication=ClientAuthentication(type="api-key", api_key="dummy"),
        )
        with patch.dict(sys.modules, {"langchain_google_genai": None}):
            with pytest.raises(ProviderError) as exc_info:
                create_model_provider(afm_model)
            assert "langchain-google-genai package is required" in str(exc_info.value)


class TestOllamaProvider:
    @patch("langchain_ollama.ChatOllama")
    def test_create_ollama_local_loopback_default(
        self, mock_chat_ollama: MagicMock
    ) -> None:
        """Verify Ollama initialization functions completely unauthenticated with loopback defaults."""
        afm_model = Model(provider="ollama", name="llama3.1")
        create_model_provider(afm_model)

        mock_chat_ollama.assert_called_once()
        kwargs = mock_chat_ollama.call_args[1]
        assert kwargs["model"] == "llama3.1"
        assert kwargs["base_url"] == "http://localhost:11434"
        assert "api_key" not in kwargs

    @patch("langchain_ollama.ChatOllama")
    def test_create_ollama_with_custom_endpoint(
        self, mock_chat_ollama: MagicMock
    ) -> None:
        """Verify Ollama correctly respects and binds custom URL parameters (useful for container network links)."""
        afm_model = Model(
            provider="ollama", name="mistral", url="http://host.docker.internal:11434"
        )
        create_model_provider(afm_model)

        mock_chat_ollama.assert_called_once()
        kwargs = mock_chat_ollama.call_args[1]
        assert kwargs["model"] == "mistral"
        assert kwargs["base_url"] == "http://host.docker.internal:11434"

    @patch("langchain_ollama.ChatOllama")
    def test_create_ollama_default_model(self, mock_chat_ollama: MagicMock) -> None:
        """Verify Ollama falls back to a tool-capable default model."""
        afm_model = Model(provider="ollama")
        create_model_provider(afm_model)

        kwargs = mock_chat_ollama.call_args[1]
        assert kwargs["model"] == "llama3.1"

    def test_ollama_rejects_authentication(self) -> None:
        """Verify Ollama rejects an authentication block instead of ignoring it."""
        afm_model = Model(
            provider="ollama",
            name="llama3.1",
            authentication=ClientAuthentication(type="bearer", token="dummy"),
        )
        with pytest.raises(ProviderError) as exc_info:
            create_model_provider(afm_model)
        assert "'authentication' field is not supported" in str(exc_info.value)

    def test_ollama_import_error(self) -> None:
        """Verify clean package warning when langchain-ollama is missing."""
        afm_model = Model(provider="ollama", name="llama3.1")
        with patch.dict(sys.modules, {"langchain_ollama": None}):
            with pytest.raises(ProviderError) as exc_info:
                create_model_provider(afm_model)
            assert "langchain-ollama package is required" in str(exc_info.value)


class TestGeneralProviderErrors:
    def test_unsupported_provider_raises_error(self) -> None:
        """Verify ProviderError triggers upon encountering an unknown provider name."""
        afm_model = Model(provider="unsupported-model-ecosystem", name="test-model")
        with pytest.raises(ProviderError) as exc_info:
            create_model_provider(afm_model)
        assert "Unsupported provider: unsupported-model-ecosystem" in str(
            exc_info.value
        )

    def test_provider_options_rejected_for_provider_without_options(self) -> None:
        """Verify providers that define no options reject provider_options."""
        afm_model = Model(
            provider="openai",
            name="gpt-4o",
            provider_options={"project": "wso2-gcp-enterprise-sandbox"},
        )
        with pytest.raises(ProviderError) as exc_info:
            create_model_provider(afm_model)
        assert "does not accept provider_options" in str(exc_info.value)
