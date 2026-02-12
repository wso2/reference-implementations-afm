# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0


from __future__ import annotations

import json
from typing import Any

from .exceptions import (
    JSONAccessError,
    TemplateCompilationError,
    TemplateEvaluationError,
)
from .models import (
    CompiledTemplate,
    HeaderVariable,
    LiteralSegment,
    PayloadVariable,
    TemplateSegment,
)


def compile_template(template: str) -> CompiledTemplate:
    segments: list[TemplateSegment] = []
    pos = 0

    while pos < len(template):
        dollar_pos = template.find("${", pos)

        if dollar_pos == -1:
            if pos < len(template):
                segments.append(LiteralSegment(text=template[pos:]))
            break

        close_pos = template.find("}", dollar_pos)

        if close_pos == -1:
            if pos < len(template):
                segments.append(LiteralSegment(text=template[pos:]))
            break

        if dollar_pos > pos:
            segments.append(LiteralSegment(text=template[pos:dollar_pos]))

        var_expr = template[dollar_pos + 2 : close_pos]

        if var_expr.startswith("http:"):
            http_part = var_expr[5:]  # Remove "http:" prefix
            segment = _parse_http_variable(http_part, var_expr)
            segments.append(segment)
        else:
            segments.append(LiteralSegment(text=f"${{{var_expr}}}"))

        pos = close_pos + 1

    return CompiledTemplate(segments=tuple(segments))


def _parse_http_variable(http_part: str, full_expr: str) -> TemplateSegment:
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
    except JSONAccessError as e:
        raise TemplateEvaluationError(
            f"Cannot resolve payload variable '${{http:payload.{segment.path}}}': "
            f"field not found",
            template=f"http:payload.{segment.path}",
        ) from e


def _handle_header_variable(
    headers: dict[str, str | list[str]] | None,
    parts: list[str],
    segment: HeaderVariable,
) -> None:
    if headers is None:
        raise TemplateEvaluationError(
            f"Cannot resolve header variable '${{http:header.{segment.name}}}': "
            "no headers provided",
            template=f"http:header.{segment.name}",
        )

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
    raise TemplateEvaluationError(
        f"Cannot resolve header variable '${{http:header.{segment.name}}}': "
        f"header not found",
        template=f"http:header.{segment.name}",
    )


def access_json_field(payload: Any, path: str) -> Any:
    if not path:
        return payload

    current = payload
    remaining = path

    while remaining:
        # Check for bracket notation at start
        if remaining.startswith("["):
            current, remaining = _handle_bracket_access(current, remaining)
        elif remaining.startswith("."):
            if remaining.startswith(".."):
                raise JSONAccessError(
                    f"Empty field name in path: {remaining}",
                    path=remaining,
                )
            # Skip leading dot
            remaining = remaining[1:]
        else:
            # Dot notation - find next delimiter
            current, remaining = _handle_dot_notation(current, remaining)

    return current


def _handle_bracket_access(current: Any, remaining: str) -> tuple[Any, str]:
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
        raise JSONAccessError(
            f"Empty field name in path: {remaining}",
            path=remaining,
        )

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
