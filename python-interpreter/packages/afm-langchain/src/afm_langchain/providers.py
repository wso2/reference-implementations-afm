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

import os
from typing import TYPE_CHECKING

from langchain_core.language_models import BaseChatModel

from afm.authentication import (
    ApiKeyAuthentication,
    BearerAuthentication,
    ClientAuthentication,
)
from afm.exceptions import ProviderError
from afm.models import Model

if TYPE_CHECKING:
    from langchain_anthropic import ChatAnthropic
    from langchain_openai import ChatOpenAI


DEFAULT_OPENAI_MODEL = "gpt-4o"
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5"

DEFAULT_OPENAI_URL = "https://api.openai.com/v1"
DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com"

# Environment variable names for API keys
OPENAI_API_KEY_ENV = "OPENAI_API_KEY"
ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY"


def create_model_provider(afm_model: Model | None = None) -> BaseChatModel:
    if afm_model is None:
        return _create_openai_model(None)

    provider = (afm_model.provider or "openai").lower()

    match provider:
        case "openai":
            return _create_openai_model(afm_model)
        case "anthropic":
            return _create_anthropic_model(afm_model)
        case _:
            raise ProviderError(f"Unsupported provider: {provider}", provider=provider)


def _create_openai_model(afm_model: Model | None) -> ChatOpenAI:
    try:
        from langchain_openai import ChatOpenAI
    except ImportError as e:
        raise ProviderError(
            "langchain-openai package is required for OpenAI models. "
            "Install it with: pip install langchain-openai",
            provider="openai",
        ) from e

    api_key = _get_api_key(
        afm_model.authentication if afm_model else None,
        OPENAI_API_KEY_ENV,
        "openai",
    )
    model_name = (
        afm_model.name if afm_model and afm_model.name else DEFAULT_OPENAI_MODEL
    )
    base_url = afm_model.url if afm_model and afm_model.url else None

    kwargs: dict = {
        "api_key": api_key,
        "model": model_name,
    }
    if base_url:
        kwargs["base_url"] = base_url

    return ChatOpenAI(**kwargs)


def _create_anthropic_model(afm_model: Model) -> ChatAnthropic:
    try:
        from langchain_anthropic import ChatAnthropic
    except ImportError as e:
        raise ProviderError(
            "langchain-anthropic package is required for Anthropic models. "
            "Install it with: pip install langchain-anthropic",
            provider="anthropic",
        ) from e

    api_key = _get_api_key(
        afm_model.authentication,
        ANTHROPIC_API_KEY_ENV,
        "anthropic",
    )
    model_name = afm_model.name if afm_model.name else DEFAULT_ANTHROPIC_MODEL
    base_url = afm_model.url if afm_model.url else None

    kwargs: dict = {
        "api_key": api_key,
        "model": model_name,
    }
    if base_url:
        kwargs["base_url"] = base_url

    return ChatAnthropic(**kwargs)


def _get_api_key(
    auth: ClientAuthentication | None,
    env_var: str,
    provider: str,
) -> str:
    match auth:
        case BearerAuthentication():
            return auth.token
        case ApiKeyAuthentication():
            return auth.api_key
        case None:
            api_key = os.environ.get(env_var)
            if api_key:
                return api_key
            raise ProviderError(
                f"No API key found. Provide authentication in the model config "
                f"or set the {env_var} environment variable.",
                provider=provider,
            )
        case _:
            raise ProviderError(
                "Model authentication must be of type 'bearer' or 'api-key'.",
                provider=provider,
            )
