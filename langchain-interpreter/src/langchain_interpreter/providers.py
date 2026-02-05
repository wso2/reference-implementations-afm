# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""LLM provider factory for AFM agents.

This module provides factory functions to create LangChain chat models
based on AFM model configuration.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from langchain_core.language_models import BaseChatModel

from .exceptions import ProviderError
from .models import ClientAuthentication, Model

if TYPE_CHECKING:
    from langchain_anthropic import ChatAnthropic
    from langchain_openai import ChatOpenAI


# Default model names when not specified
DEFAULT_OPENAI_MODEL = "gpt-4o"
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514"

# Default API URLs
DEFAULT_OPENAI_URL = "https://api.openai.com/v1"
DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com"

# Environment variable names for API keys
OPENAI_API_KEY_ENV = "OPENAI_API_KEY"
ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY"


def create_model_provider(model: Model | None = None) -> BaseChatModel:
    """Create a LangChain chat model from AFM model configuration.

    Args:
        model: The AFM model configuration. If None, defaults to OpenAI
               using the OPENAI_API_KEY environment variable.

    Returns:
        A LangChain BaseChatModel instance.

    Raises:
        ProviderError: If the provider is not supported or configuration is invalid.
    """
    # Default to OpenAI if no model specified
    if model is None:
        return _create_openai_model(None)

    provider = (model.provider or "openai").lower()

    match provider:
        case "openai":
            return _create_openai_model(model)
        case "anthropic":
            return _create_anthropic_model(model)
        case _:
            raise ProviderError(f"Unsupported provider: {provider}", provider=provider)


def _create_openai_model(model: Model | None) -> ChatOpenAI:
    """Create an OpenAI chat model.

    Args:
        model: The AFM model configuration, or None for defaults.

    Returns:
        A ChatOpenAI instance.

    Raises:
        ProviderError: If API key cannot be found.
    """
    try:
        from langchain_openai import ChatOpenAI
    except ImportError as e:
        raise ProviderError(
            "langchain-openai package is required for OpenAI models. "
            "Install it with: pip install langchain-openai",
            provider="openai",
        ) from e

    # Get configuration values
    api_key = _get_api_key(
        model.authentication if model else None,
        OPENAI_API_KEY_ENV,
        "openai",
    )
    model_name = model.name if model and model.name else DEFAULT_OPENAI_MODEL
    base_url = model.url if model and model.url else None

    kwargs: dict = {
        "api_key": api_key,
        "model": model_name,
    }
    if base_url:
        kwargs["base_url"] = base_url

    return ChatOpenAI(**kwargs)


def _create_anthropic_model(model: Model) -> ChatAnthropic:
    """Create an Anthropic chat model.

    Args:
        model: The AFM model configuration.

    Returns:
        A ChatAnthropic instance.

    Raises:
        ProviderError: If API key cannot be found.
    """
    try:
        from langchain_anthropic import ChatAnthropic
    except ImportError as e:
        raise ProviderError(
            "langchain-anthropic package is required for Anthropic models. "
            "Install it with: pip install langchain-anthropic",
            provider="anthropic",
        ) from e

    api_key = _get_api_key(
        model.authentication,
        ANTHROPIC_API_KEY_ENV,
        "anthropic",
    )
    model_name = model.name if model.name else DEFAULT_ANTHROPIC_MODEL
    base_url = model.url if model.url else None

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
    """Extract API key from authentication config or environment variable.

    Args:
        auth: The authentication configuration, or None.
        env_var: The environment variable name to check as fallback.
        provider: The provider name for error messages.

    Returns:
        The API key string.

    Raises:
        ProviderError: If API key cannot be found in auth config or env var.
    """
    # Try to get from authentication config
    if auth is not None:
        auth_type = auth.type.lower()

        if auth_type == "bearer" and auth.token:
            return auth.token
        elif auth_type == "api-key" and auth.api_key:
            return auth.api_key
        elif auth_type == "basic":
            raise ProviderError(
                "Basic authentication is not supported for LLM providers. "
                "Use 'bearer' or 'api-key' authentication type.",
                provider=provider,
            )
        else:
            # Try to get the key from extra fields if present
            # (auth config allows extra fields)
            auth_dict = auth.model_dump(exclude_none=True)
            for key in ["token", "api_key", "key", "apiKey"]:
                if key in auth_dict and auth_dict[key]:
                    return auth_dict[key]

    # Fall back to environment variable
    api_key = os.environ.get(env_var)
    if api_key:
        return api_key

    raise ProviderError(
        f"No API key found. Provide authentication in the model config "
        f"or set the {env_var} environment variable.",
        provider=provider,
    )


def get_supported_providers() -> list[str]:
    """Get list of supported provider names.

    Returns:
        List of provider names that can be used in AFM model configuration.
    """
    return ["openai", "anthropic"]
