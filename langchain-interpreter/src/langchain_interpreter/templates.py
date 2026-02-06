# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Webhook template compilation and evaluation.

Handles ${http:payload...} and ${http:header...} variable substitution
in webhook prompt templates.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .exceptions import (
    JSONAccessError,
    TemplateCompilationError,
)
from .models import (
    CompiledTemplate,
    HeaderVariable,
    LiteralSegment,
    PayloadVariable,
    TemplateSegment,
)

# Pattern to match ${...} variable syntax
VARIABLE_PATTERN = re.compile(r"\$\{([^}]+)\}")


def compile_template(template: str) -> CompiledTemplate:
    """Compile a webhook prompt template into segments.

    Parses the template string and returns a CompiledTemplate containing
    a sequence of segments that can be:
    - LiteralSegment: Static text
    - PayloadVariable: ${http:payload} or ${http:payload.field}
    - HeaderVariable: ${http:header.HeaderName}

    Non-http variables (like ${env:VAR}) are preserved as literal text.

    Args:
        template: The raw template string.

    Returns:
        A CompiledTemplate with parsed segments.

    Raises:
        TemplateCompilationError: If the template contains invalid syntax.
    """
    segments: list[TemplateSegment] = []
    pos = 0

    while pos < len(template):
        # Find next ${
        dollar_pos = template.find("${", pos)

        if dollar_pos == -1:
            # No more variables - add remaining text as literal
            if pos < len(template):
                segments.append(LiteralSegment(text=template[pos:]))
            break

        # Find closing brace
        close_pos = template.find("}", dollar_pos)

        if close_pos == -1:
            # No closing brace - treat rest as literal
            if pos < len(template):
                segments.append(LiteralSegment(text=template[pos:]))
            break

        # Add text before the variable as literal
        if dollar_pos > pos:
            segments.append(LiteralSegment(text=template[pos:dollar_pos]))

        # Extract variable expression
        var_expr = template[dollar_pos + 2 : close_pos]

        # Check if it's an http: variable
        if var_expr.startswith("http:"):
            http_part = var_expr[5:]  # Remove "http:" prefix
            segment = _parse_http_variable(http_part, var_expr)
            segments.append(segment)
        else:
            # Non-http variable - preserve as literal
            segments.append(LiteralSegment(text=f"${{{var_expr}}}"))

        pos = close_pos + 1

    return CompiledTemplate(segments=tuple(segments))


def _parse_http_variable(http_part: str, full_expr: str) -> TemplateSegment:
    """Parse an http: variable into a PayloadVariable or HeaderVariable.

    Args:
        http_part: The part after "http:" (e.g., "payload.field" or "header.Name")
        full_expr: The full variable expression for error messages

    Returns:
        PayloadVariable or HeaderVariable segment

    Raises:
        TemplateCompilationError: If the variable format is invalid
    """
    if http_part == "payload":
        # Entire payload
        return PayloadVariable(path="")

    if http_part.startswith("payload."):
        path = http_part[8:]  # Remove "payload."
        if not path:
            raise TemplateCompilationError(
                f"Invalid http variable format: {full_expr}",
                template=full_expr,
            )
        return PayloadVariable(path=path)

    if http_part.startswith("header."):
        header_name = http_part[7:]  # Remove "header."
        if not header_name:
            raise TemplateCompilationError(
                f"Invalid http variable format: {full_expr}",
                template=full_expr,
            )
        return HeaderVariable(name=header_name)

    # Unknown prefix
    prefix = http_part.split(".")[0] if "." in http_part else http_part
    raise TemplateCompilationError(
        f"Unknown http variable prefix: {prefix}",
        template=full_expr,
    )


def evaluate_template(
    compiled: CompiledTemplate,
    payload: Any,
    headers: dict[str, str | list[str]] | None,
) -> str:
    """Evaluate a compiled template with the given payload and headers.

    Args:
        compiled: The compiled template to evaluate.
        payload: The JSON payload from the webhook request.
        headers: HTTP headers from the webhook request (case-insensitive).

    Returns:
        The evaluated template string.

    Raises:
        TemplateEvaluationError: If evaluation fails.
    """
    parts: list[str] = []

    for segment in compiled.segments:
        match segment:
            case LiteralSegment(text=text):
                parts.append(text)
            case PayloadVariable():
                _handle_payload_variable(payload, parts, segment)
            case HeaderVariable():
                _handle_header_variable(headers, parts, segment)

    return "".join(parts)


def _handle_payload_variable(
    payload: Any,
    parts: list[str],
    segment: PayloadVariable,
) -> None:
    """Handle a payload variable by extracting and converting the value.

    Args:
        payload: The JSON payload.
        parts: List to append the result to.
        segment: The PayloadVariable segment.
    """
    if segment.path == "":
        # Entire payload
        parts.append(json.dumps(payload))
        return

    try:
        value = access_json_field(payload, segment.path)
        if isinstance(value, str):
            parts.append(value)
        else:
            parts.append(json.dumps(value))
    except JSONAccessError:
        # Missing field - add empty string
        parts.append("")


def _handle_header_variable(
    headers: dict[str, str | list[str]] | None,
    parts: list[str],
    segment: HeaderVariable,
) -> None:
    """Handle a header variable by extracting the header value.

    Args:
        headers: HTTP headers (case-insensitive lookup).
        parts: List to append the result to.
        segment: The HeaderVariable segment.
    """
    if headers is None:
        parts.append("")
        return

    # Case-insensitive header lookup
    header_name_lower = segment.name.lower()
    for key, value in headers.items():
        if key.lower() == header_name_lower:
            if isinstance(value, list):
                parts.append(", ".join(value))
            else:
                parts.append(value)
            return

    # Header not found
    parts.append("")


def access_json_field(payload: Any, path: str) -> Any:
    """Access a field in a JSON payload using dot/bracket notation.

    Supports:
    - Dot notation: "field.nested"
    - Bracket notation with quotes: "['field.with.dots']" or '["field"]'
    - Array index: "items[0]"
    - Combined: "data.items[0].name" or "['users.list'][1]['full.name']"

    Args:
        payload: The JSON payload to access.
        path: The field path.

    Returns:
        The value at the specified path.

    Raises:
        JSONAccessError: If the path is invalid or field not found.
    """
    if not path:
        return payload

    current = payload
    remaining = path

    while remaining:
        # Check for bracket notation at start
        if remaining.startswith("["):
            current, remaining = _handle_bracket_access(current, remaining)
        elif remaining.startswith("."):
            # Skip leading dot
            remaining = remaining[1:]
        else:
            # Dot notation - find next delimiter
            current, remaining = _handle_dot_notation(current, remaining)

    return current


def _handle_bracket_access(current: Any, remaining: str) -> tuple[Any, str]:
    """Handle bracket notation access like ['field'] or [0].

    Args:
        current: Current value being accessed.
        remaining: Remaining path string starting with '['.

    Returns:
        Tuple of (accessed value, remaining path).

    Raises:
        JSONAccessError: If bracket notation is invalid.
    """
    # Find closing bracket
    close_bracket = remaining.find("]")
    if close_bracket == -1:
        raise JSONAccessError(
            f"Invalid bracket notation in path: {remaining}",
            path=remaining,
        )

    bracket_content = remaining[1:close_bracket]
    new_remaining = remaining[close_bracket + 1 :]

    # Check if it's a quoted string or array index
    if (bracket_content.startswith("'") and bracket_content.endswith("'")) or (
        bracket_content.startswith('"') and bracket_content.endswith('"')
    ):
        # Quoted field name
        field_name = bracket_content[1:-1]
        if not isinstance(current, dict):
            raise JSONAccessError(
                f"Cannot access field '{field_name}' on non-object",
                path=remaining,
            )
        if field_name not in current:
            raise JSONAccessError(
                f"Field '{field_name}' not found",
                path=remaining,
            )
        return current[field_name], new_remaining
    else:
        # Array index
        try:
            index = int(bracket_content)
        except ValueError as err:
            raise JSONAccessError(
                f"Invalid array index: {bracket_content}",
                path=remaining,
            ) from err

        if not isinstance(current, list):
            raise JSONAccessError(
                f"Cannot access index {index} on non-array",
                path=remaining,
            )
        if index < 0 or index >= len(current):
            raise JSONAccessError(
                f"Array index out of bounds: {index}",
                path=remaining,
            )
        return current[index], new_remaining


def _handle_dot_notation(current: Any, remaining: str) -> tuple[Any, str]:
    """Handle dot notation access for field.nested or field[0] patterns.

    Args:
        current: Current value being accessed.
        remaining: Remaining path string.

    Returns:
        Tuple of (accessed value, remaining path).

    Raises:
        JSONAccessError: If field access fails.
    """
    # Find next delimiter (., [, or end of string)
    dot_pos = remaining.find(".")
    bracket_pos = remaining.find("[")

    if dot_pos == -1 and bracket_pos == -1:
        # No more delimiters - this is the final field
        field_name = remaining
        new_remaining = ""
    elif dot_pos == -1:
        # Only bracket found
        field_name = remaining[:bracket_pos]
        new_remaining = remaining[bracket_pos:]
    elif bracket_pos == -1:
        # Only dot found
        field_name = remaining[:dot_pos]
        new_remaining = remaining[dot_pos:]
    else:
        # Both found - use whichever comes first
        delimiter_pos = min(dot_pos, bracket_pos)
        field_name = remaining[:delimiter_pos]
        new_remaining = remaining[delimiter_pos:]

    if not field_name:
        # Empty field name (e.g., from ".." or ".[")
        return current, new_remaining

    if not isinstance(current, dict):
        raise JSONAccessError(
            f"Cannot access field '{field_name}' on non-object",
            path=remaining,
        )
    if field_name not in current:
        raise JSONAccessError(
            f"Field '{field_name}' not found",
            path=remaining,
        )

    return current[field_name], new_remaining
