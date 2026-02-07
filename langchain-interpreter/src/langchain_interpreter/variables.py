# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Variable substitution for AFM files.

Supports the following variable prefixes:
- env: - Environment variables (resolved at load time)
- http: - HTTP context variables (preserved for runtime resolution)
- No prefix - Treated as environment variables
"""

from __future__ import annotations

import os
import re
from typing import TYPE_CHECKING

from .exceptions import AFMValidationError, VariableResolutionError
from .models import (
    ConsoleChatInterface,
    WebChatInterface,
    WebhookInterface,
)

if TYPE_CHECKING:
    from .models import (
        AFMRecord,
        ClientAuthentication,
        Exposure,
        JSONSchema,
        Signature,
        Subscription,
        ToolFilter,
    )

# Pattern to match ${...} variable syntax
VARIABLE_PATTERN = re.compile(r"\$\{([^}]+)\}")


def resolve_variables(content: str) -> str:
    """Resolve static variables in AFM content.

    Resolves:
    - ${env:VAR_NAME} - Environment variables
    - ${VAR_NAME} - Environment variables (no prefix)

    Preserves:
    - ${http:...} - Runtime variables for webhook templates

    Skips variables in YAML comments (lines starting with #).

    Args:
        content: The raw AFM content string.

    Returns:
        Content with static variables resolved.

    Raises:
        VariableResolutionError: If an environment variable is not found
            or an unsupported prefix is used.
    """
    result = content
    start_pos = 0

    while True:
        # Find next variable
        match = VARIABLE_PATTERN.search(result, start_pos)
        if match is None:
            break

        dollar_pos = match.start()
        close_brace_pos = match.end()
        var_expr = match.group(1)

        # Check if this variable is in a commented line
        line_start = result.rfind("\n", 0, dollar_pos) + 1
        line_prefix = result[line_start:dollar_pos].strip()

        if line_prefix.startswith("#"):
            # Skip variables in commented lines
            start_pos = close_brace_pos
            continue

        # Parse prefix and variable name
        if ":" in var_expr:
            prefix, var_name = var_expr.split(":", 1)
        else:
            prefix = ""
            var_name = var_expr

        # Skip http: variables - they're handled at runtime
        if prefix == "http":
            start_pos = close_brace_pos
            continue

        # Resolve the variable
        if prefix in ("", "env"):
            env_value = os.environ.get(var_name)
            if env_value is None or env_value == "":
                raise VariableResolutionError(
                    var_expr, f"Environment variable '{var_name}' not found"
                )
            resolved_value = env_value
        else:
            raise VariableResolutionError(
                var_expr,
                f"Unsupported variable prefix '{prefix}:'. "
                "Only 'env:' and 'http:' are supported.",
            )

        # Replace the variable with its value
        before = result[:dollar_pos]
        after = result[close_brace_pos:]
        result = before + resolved_value + after
        start_pos = len(before) + len(resolved_value)

    return result


def contains_http_variable(content: str) -> bool:
    """Check if content contains any http: variable references.

    Args:
        content: String to check.

    Returns:
        True if content contains ${http:...}, False otherwise.
    """
    return "${http:" in content


def validate_http_variables(afm_record: AFMRecord) -> None:
    """Validate that http: variables only appear in webhook prompts.

    http: variables are only valid in the 'prompt' field of webhook interfaces.
    This function checks all other fields and raises an error if http: variables
    are found in invalid locations.

    Args:
        afm_record: The parsed AFM record to validate.

    Raises:
        AFMValidationError: If http: variables are found in invalid locations.
    """
    errored_fields: list[str] = []

    # Check role and instructions
    if contains_http_variable(afm_record.role):
        errored_fields.append("role")

    if contains_http_variable(afm_record.instructions):
        errored_fields.append("instructions")

    metadata = afm_record.metadata

    # Check simple string fields
    simple_fields = [
        ("spec_version", metadata.spec_version),
        ("name", metadata.name),
        ("description", metadata.description),
        ("version", metadata.version),
        ("author", metadata.author),
        ("icon_url", metadata.icon_url),
        ("license", metadata.license),
    ]

    for field_name, value in simple_fields:
        if value is not None and contains_http_variable(value):
            errored_fields.append(field_name)

    # Check authors list
    if metadata.authors:
        for author in metadata.authors:
            if contains_http_variable(author):
                errored_fields.append("authors")
                break

    # Check provider
    if metadata.provider:
        if metadata.provider.name and contains_http_variable(metadata.provider.name):
            errored_fields.append("provider.name")
        if metadata.provider.url and contains_http_variable(metadata.provider.url):
            errored_fields.append("provider.url")

    # Check model
    if metadata.model:
        model = metadata.model
        if model.name and contains_http_variable(model.name):
            errored_fields.append("model.name")
        if model.provider and contains_http_variable(model.provider):
            errored_fields.append("model.provider")
        if model.url and contains_http_variable(model.url):
            errored_fields.append("model.url")
        if _authentication_contains_http_variable(model.authentication):
            errored_fields.append("model.authentication")

    # Check interfaces
    if metadata.interfaces:
        for interface in metadata.interfaces:
            match interface:
                case ConsoleChatInterface():
                    if _signature_contains_http_variable(interface.signature):
                        errored_fields.append("interfaces.consolechat.signature")
                case WebChatInterface():
                    if _signature_contains_http_variable(interface.signature):
                        errored_fields.append("interfaces.webchat.signature")
                    if _exposure_contains_http_variable(interface.exposure):
                        errored_fields.append("interfaces.webchat.exposure")
                case WebhookInterface():
                    # Note: webhook.prompt is allowed to contain http: variables
                    if _signature_contains_http_variable(interface.signature):
                        errored_fields.append("interfaces.webhook.signature")
                    if _exposure_contains_http_variable(interface.exposure):
                        errored_fields.append("interfaces.webhook.exposure")
                    if _subscription_contains_http_variable(interface.subscription):
                        errored_fields.append("interfaces.webhook.subscription")

    # Check tools
    if metadata.tools and metadata.tools.mcp:
        for server in metadata.tools.mcp:
            if contains_http_variable(server.name):
                errored_fields.append("tools.mcp.name")
            if contains_http_variable(server.transport.url):
                errored_fields.append("tools.mcp.transport.url")
            if _authentication_contains_http_variable(server.transport.authentication):
                errored_fields.append("tools.mcp.transport.authentication")
            if _tool_filter_contains_http_variable(server.tool_filter):
                errored_fields.append("tools.mcp.tool_filter")

    if errored_fields:
        fields_str = ", ".join(errored_fields)
        raise AFMValidationError(
            f"http: variables are only supported in webhook prompt fields, "
            f"found in: {fields_str}"
        )


def _authentication_contains_http_variable(
    auth: ClientAuthentication | None,
) -> bool:
    """Check if authentication config contains http: variables."""
    if auth is None:
        return False

    # Check all fields in the authentication object
    for value in auth.model_dump().values():
        if isinstance(value, str) and contains_http_variable(value):
            return True
    return False


def _signature_contains_http_variable(signature: Signature) -> bool:
    """Check if signature contains http: variables."""
    return _json_schema_contains_http_variable(
        signature.input
    ) or _json_schema_contains_http_variable(signature.output)


def _json_schema_contains_http_variable(schema: JSONSchema) -> bool:
    """Check if JSON schema contains http: variables.

    Checks all fields including extra fields (JSONSchema uses extra="allow").
    """
    # Dump all fields and recursively check them
    schema_dict = schema.model_dump()

    def _check_value(value: Any) -> bool:
        """Recursively check a value for http: variables."""
        if isinstance(value, str):
            return contains_http_variable(value)
        elif isinstance(value, dict):
            for v in value.values():
                if _check_value(v):
                    return True
        elif isinstance(value, list):
            for item in value:
                if _check_value(item):
                    return True
        return False

    return _check_value(schema_dict)


def _exposure_contains_http_variable(exposure: Exposure) -> bool:
    """Check if exposure config contains http: variables."""
    if exposure.http and contains_http_variable(exposure.http.path):
        return True
    return False


def _subscription_contains_http_variable(subscription: Subscription) -> bool:
    """Check if subscription config contains http: variables."""
    if contains_http_variable(subscription.protocol):
        return True
    if subscription.hub and contains_http_variable(subscription.hub):
        return True
    if subscription.topic and contains_http_variable(subscription.topic):
        return True
    if subscription.callback and contains_http_variable(subscription.callback):
        return True
    if subscription.secret and contains_http_variable(subscription.secret):
        return True
    if _authentication_contains_http_variable(subscription.authentication):
        return True
    return False


def _tool_filter_contains_http_variable(tool_filter: ToolFilter | None) -> bool:
    """Check if tool filter contains http: variables."""
    if tool_filter is None:
        return False

    all_tools = (tool_filter.allow or []) + (tool_filter.deny or [])
    for tool in all_tools:
        if contains_http_variable(tool):
            return True
    return False
