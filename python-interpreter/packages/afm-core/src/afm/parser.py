# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from pathlib import Path

import yaml
from pydantic import ValidationError

from .exceptions import AFMParseError, AFMValidationError
from .models import AFMRecord, AgentMetadata
from .variables import resolve_variables, validate_http_variables

# Delimiter for YAML frontmatter
FRONTMATTER_DELIMITER = "---"


def parse_afm(content: str) -> AFMRecord:
    resolved_content = resolve_variables(content)
    lines = resolved_content.splitlines()
    metadata, body_start = _extract_frontmatter(lines)
    role, instructions = _extract_role_and_instructions(lines, body_start)
    afm_record = AFMRecord(
        metadata=metadata,
        role=role,
        instructions=instructions,
    )
    validate_http_variables(afm_record)
    return afm_record


def parse_afm_file(file_path: str | Path) -> AFMRecord:
    path = Path(file_path)
    content = path.read_text(encoding="utf-8")
    return parse_afm(content)


def _extract_frontmatter(lines: list[str]) -> tuple[AgentMetadata, int]:
    if not lines or lines[0].strip() != FRONTMATTER_DELIMITER:
        # No frontmatter - return empty metadata
        return AgentMetadata(), 0

    end_index = None
    for i in range(1, len(lines)):
        if lines[i].strip() == FRONTMATTER_DELIMITER:
            end_index = i
            break

    if end_index is None:
        raise AFMParseError("Unclosed frontmatter - missing closing '---'")

    yaml_lines = lines[1:end_index]
    yaml_content = "\n".join(yaml_lines)

    if not yaml_content.strip():
        return AgentMetadata(), end_index + 1

    try:
        yaml_data = yaml.safe_load(yaml_content)
    except yaml.YAMLError as e:
        raise AFMParseError(f"Invalid YAML in frontmatter: {e}")

    if yaml_data is None:
        return AgentMetadata(), end_index + 1

    if not isinstance(yaml_data, dict):
        raise AFMParseError("Frontmatter must be a YAML mapping/object")

    try:
        metadata = AgentMetadata.model_validate(yaml_data)
    except ValidationError as e:
        errors = e.errors()
        if errors:
            first_error = errors[0]
            field = ".".join(str(loc) for loc in first_error.get("loc", []))
            msg = first_error.get("msg", "Invalid value")
            raise AFMValidationError(msg, field=field)
        raise AFMValidationError(str(e))

    return metadata, end_index + 1


def _extract_role_and_instructions(
    lines: list[str], start_index: int
) -> tuple[str, str]:
    role_lines: list[str] = []
    instructions_lines: list[str] = []

    in_role = False
    in_instructions = False

    for i in range(start_index, len(lines)):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("# "):
            heading = stripped[2:].strip().lower()
            if heading == "role":
                in_role = True
                in_instructions = False
                continue
            elif heading == "instructions":
                in_role = False
                in_instructions = True
                continue
            else:
                # Different heading - stop current section
                in_role = False
                in_instructions = False

        if in_role:
            role_lines.append(line)
        elif in_instructions:
            instructions_lines.append(line)

    role = "\n".join(role_lines).strip()
    instructions = "\n".join(instructions_lines).strip()

    return role, instructions
