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

from afm.authentication import ApiKeyAuthentication, BearerAuthentication
from afm.exceptions import ProviderError
from afm.models import Model
from afm_langchain.providers import _get_api_key, create_model_provider


class TestGetApiKey:
    def test_bearer_supplies_the_token(self):
        auth = BearerAuthentication(token="bearer-token")
        assert _get_api_key(auth, "OPENAI_API_KEY", "openai") == "bearer-token"

    def test_api_key_supplies_the_key(self):
        auth = ApiKeyAuthentication(api_key="the-key")
        assert _get_api_key(auth, "OPENAI_API_KEY", "openai") == "the-key"

    def test_the_configured_authentication_wins_over_the_environment(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("OPENAI_API_KEY", "from-env")
        auth = ApiKeyAuthentication(api_key="the-key")
        assert _get_api_key(auth, "OPENAI_API_KEY", "openai") == "the-key"

    def test_an_absent_authentication_uses_the_environment(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("OPENAI_API_KEY", "from-env")
        assert _get_api_key(None, "OPENAI_API_KEY", "openai") == "from-env"

    def test_an_absent_authentication_without_environment_is_an_error(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        with pytest.raises(ProviderError, match="No API key found"):
            _get_api_key(None, "OPENAI_API_KEY", "openai")


class TestModelAuthentication:
    @pytest.mark.parametrize("provider", ["openai", "anthropic"])
    @pytest.mark.parametrize(
        "authentication",
        [
            {"type": "bearer", "token": "configured-key"},
            {"type": "api-key", "api_key": "configured-key"},
        ],
    )
    def test_both_types_supply_the_credential_to_every_provider(
        self, monkeypatch: pytest.MonkeyPatch, provider: str, authentication: dict
    ):
        monkeypatch.setenv("OPENAI_API_KEY", "from-env")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "from-env")
        model = Model(provider=provider, name="m", authentication=authentication)

        chat_model = create_model_provider(model)

        secret = getattr(chat_model, f"{provider}_api_key")
        assert secret.get_secret_value() == "configured-key"

    @pytest.mark.parametrize(
        "authentication",
        [
            {"type": "basic", "username": "u", "password": "p"},
            {"type": "api-key", "api_key": "k", "header_name": "X-Key"},
            {
                "type": "oauth2",
                "grant_type": "client_credentials",
                "token_url": "https://x/t",
                "client_id": "c",
                "client_secret": "s",
            },
        ],
    )
    def test_other_types_and_header_name_are_rejected_when_the_model_is_loaded(
        self, authentication: dict
    ):
        with pytest.raises(ValueError):
            Model(provider="openai", authentication=authentication)
