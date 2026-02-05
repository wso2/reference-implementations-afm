# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""AFM (Agent-Flavored Markdown) parser.

Parses AFM files containing YAML frontmatter and Markdown body with
Role and Instructions sections.
"""

from pathlib import Path

import yaml
from pydantic import ValidationError

from .exceptions import AFMParseError, AFMValidationError
from .models import AFMRecord, AgentMetadata
from .variables import resolve_variables, validate_http_variables

# Delimiter for YAML frontmatter
FRONTMATTER_DELIMITER = "---"


def parse_afm(content: str) -> AFMRecord:
    """Parse AFM content into an AFMRecord.

    This is the main entry point for parsing AFM files. It:
    1. Resolves static variables (env:, bare variables)
    2. Extracts and parses YAML frontmatter (if present)
    3. Extracts Role and Instructions sections from markdown body
    4. Validates that http: variables only appear in webhook prompts

    Args:
        content: The raw AFM file content.

    Returns:
        An AFMRecord containing parsed metadata, role, and instructions.

    Raises:
        AFMParseError: If the content cannot be parsed.
        AFMValidationError: If the content is invalid.
        VariableResolutionError: If a variable cannot be resolved.
    """
    # Resolve static variables
    resolved_content = resolve_variables(content)

    # Split into lines
    lines = resolved_content.splitlines()

    # Extract frontmatter
    metadata, body_start = _extract_frontmatter(lines)

    # Extract role and instructions
    role, instructions = _extract_role_and_instructions(lines, body_start)

    # Create AFM record
    afm_record = AFMRecord(
        metadata=metadata,
        role=role,
        instructions=instructions,
    )

    # Validate http: variables
    validate_http_variables(afm_record)

    return afm_record


def parse_afm_file(file_path: str | Path) -> AFMRecord:
    """Parse an AFM file from disk.

    Args:
        file_path: Path to the AFM file.

    Returns:
        An AFMRecord containing parsed metadata, role, and instructions.

    Raises:
        FileNotFoundError: If the file doesn't exist.
        AFMParseError: If the content cannot be parsed.
        AFMValidationError: If the content is invalid.
        VariableResolutionError: If a variable cannot be resolved.
    """
    path = Path(file_path)
    content = path.read_text(encoding="utf-8")
    return parse_afm(content)


def _extract_frontmatter(lines: list[str]) -> tuple[AgentMetadata, int]:
    """Extract and parse YAML frontmatter from AFM lines.

    Args:
        lines: List of lines from the AFM content.

    Returns:
        Tuple of (AgentMetadata, body_start_index).
        If no frontmatter, returns (empty AgentMetadata, 0).

    Raises:
        AFMParseError: If frontmatter is malformed.
        AFMValidationError: If frontmatter content is invalid.
    """
    if not lines or lines[0].strip() != FRONTMATTER_DELIMITER:
        # No frontmatter - return empty metadata
        return AgentMetadata(), 0

    # Find closing delimiter
    end_index = None
    for i in range(1, len(lines)):
        if lines[i].strip() == FRONTMATTER_DELIMITER:
            end_index = i
            break

    if end_index is None:
        raise AFMParseError("Unclosed frontmatter - missing closing '---'")

    # Extract YAML content
    yaml_lines = lines[1:end_index]
    yaml_content = "\n".join(yaml_lines)

    if not yaml_content.strip():
        # Empty frontmatter
        return AgentMetadata(), end_index + 1

    # Parse YAML
    try:
        yaml_data = yaml.safe_load(yaml_content)
    except yaml.YAMLError as e:
        raise AFMParseError(f"Invalid YAML in frontmatter: {e}")

    if yaml_data is None:
        # YAML parsed to None (e.g., just comments)
        return AgentMetadata(), end_index + 1

    if not isinstance(yaml_data, dict):
        raise AFMParseError("Frontmatter must be a YAML mapping/object")

    # Parse into AgentMetadata
    try:
        metadata = AgentMetadata.model_validate(yaml_data)
    except ValidationError as e:
        # Convert Pydantic validation error to our error type
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
    """Extract Role and Instructions sections from markdown body.

    Looks for "# Role" and "# Instructions" headings and extracts
    the content following each.

    Args:
        lines: List of lines from the AFM content.
        start_index: Index to start searching from (after frontmatter).

    Returns:
        Tuple of (role_content, instructions_content).
        Both are trimmed strings.
    """
    role_lines: list[str] = []
    instructions_lines: list[str] = []

    in_role = False
    in_instructions = False

    for i in range(start_index, len(lines)):
        line = lines[i]
        stripped = line.strip()

        # Check for heading
        if stripped.startswith("# "):
            heading = stripped[2:].lower()
            if heading.startswith("role"):
                in_role = True
                in_instructions = False
                continue
            elif heading.startswith("instructions"):
                in_role = False
                in_instructions = True
                continue
            else:
                # Different heading - stop current section
                in_role = False
                in_instructions = False

        # Add line to appropriate section
        if in_role:
            role_lines.append(line)
        elif in_instructions:
            instructions_lines.append(line)

    role = "\n".join(role_lines).strip()
    instructions = "\n".join(instructions_lines).strip()

    return role, instructions


def validate_and_extract_interfaces(
    interfaces: list,
) -> tuple:
    """Validate and extract interfaces by type.

    Ensures no duplicate interface types and returns each type separately.

    Args:
        interfaces: List of Interface objects.

    Returns:
        Tuple of (console_chat, web_chat, webhook) where each is the
        interface of that type or None.

    Raises:
        AFMValidationError: If duplicate interface types are found.
    """
    from .models import ConsoleChatInterface, WebChatInterface, WebhookInterface

    console_chat: ConsoleChatInterface | None = None
    web_chat: WebChatInterface | None = None
    webhook: WebhookInterface | None = None

    for interface in interfaces:
        if isinstance(interface, ConsoleChatInterface):
            if console_chat is not None:
                raise AFMValidationError(
                    "Multiple interfaces of the same type are not supported"
                )
            console_chat = interface
        elif isinstance(interface, WebChatInterface):
            if web_chat is not None:
                raise AFMValidationError(
                    "Multiple interfaces of the same type are not supported"
                )
            web_chat = interface
        elif isinstance(interface, WebhookInterface):
            if webhook is not None:
                raise AFMValidationError(
                    "Multiple interfaces of the same type are not supported"
                )
            webhook = interface

    return console_chat, web_chat, webhook
