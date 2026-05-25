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

import logging
from pathlib import Path

import yaml
from pydantic import ValidationError

from .exceptions import AFMParseError, AFMValidationError
from .models import AFMRecord, AgentMetadata, PlatformChatInterface
from .variables import resolve_variables, validate_http_variables

logger = logging.getLogger(__name__)

# Delimiter for YAML frontmatter
FRONTMATTER_DELIMITER = "---"

# AFM spec versions this implementation knows how to parse.
# Bump by adding the new version; keep older entries while changes remain
# backwards-compatible.
SUPPORTED_SPEC_VERSIONS: frozenset[str] = frozenset({"0.3.0", "0.4.0"})

# Minimum spec version that introduced the platformchat interface.
PLATFORMCHAT_MIN_VERSION: tuple[int, ...] = (0, 4, 0)


def _parse_version(version: str) -> tuple[int, ...] | None:
    try:
        return tuple(int(part) for part in version.split("."))
    except ValueError:
        return None


def extract_raw_frontmatter(content: str) -> tuple[dict | None, str]:
    """Extract raw YAML frontmatter dict and remaining body from a content string.

    Returns ``(None, content)`` when no opening delimiter is found.
    Returns ``(dict, body)`` when frontmatter is present and parsed.
    Raises :class:`ValueError` on malformed frontmatter.
    """
    lines = content.splitlines()

    if not lines or lines[0].strip() != FRONTMATTER_DELIMITER:
        return None, content

    end_index = None
    for i in range(1, len(lines)):
        if lines[i].strip() == FRONTMATTER_DELIMITER:
            end_index = i
            break

    if end_index is None:
        raise ValueError("Unclosed frontmatter - missing closing '---'")

    yaml_content = "\n".join(lines[1:end_index])
    body = "\n".join(lines[end_index + 1 :])

    if not yaml_content.strip():
        return {}, body

    try:
        yaml_data = yaml.safe_load(yaml_content)
    except yaml.YAMLError as e:
        raise ValueError(f"Invalid YAML in frontmatter: {e}") from e

    if yaml_data is None:
        return {}, body

    if not isinstance(yaml_data, dict):
        raise ValueError("Frontmatter must be a YAML mapping")

    return yaml_data, body


def parse_afm(content: str, *, resolve_env: bool = True) -> AFMRecord:
    if resolve_env:
        content = resolve_variables(content)
    lines = content.splitlines()
    metadata, body_start = _extract_frontmatter(lines)
    role, instructions = _extract_role_and_instructions(lines, body_start)
    afm_record = AFMRecord(
        metadata=metadata,
        role=role,
        instructions=instructions,
    )
    _warn_on_spec_version(metadata.spec_version)
    _check_feature_version_requirements(metadata)
    validate_http_variables(afm_record)
    return afm_record


def _check_feature_version_requirements(metadata: AgentMetadata) -> None:
    if metadata.spec_version is None:
        return
    declared = _parse_version(metadata.spec_version)
    if declared is None:
        return

    if declared < PLATFORMCHAT_MIN_VERSION and metadata.interfaces:
        for interface in metadata.interfaces:
            if isinstance(interface, PlatformChatInterface):
                raise AFMValidationError(
                    f"'platformchat' interface requires spec_version "
                    f"{'.'.join(str(p) for p in PLATFORMCHAT_MIN_VERSION)} or "
                    f"later (found {metadata.spec_version!r}).",
                    field="metadata.spec_version",
                )


def _warn_on_spec_version(spec_version: str | None) -> None:
    supported = ", ".join(sorted(SUPPORTED_SPEC_VERSIONS))
    if spec_version is None:
        logger.warning(
            "AFM file has no 'spec_version'; expected one of: %s. Proceeding anyway.",
            supported,
        )
        return
    if spec_version not in SUPPORTED_SPEC_VERSIONS:
        logger.warning(
            "AFM file 'spec_version' %r is not in the supported set (%s). "
            "Proceeding anyway; some fields may not be recognized.",
            spec_version,
            supported,
        )


def parse_afm_file(file_path: str | Path, *, resolve_env: bool = True) -> AFMRecord:
    path = Path(file_path).resolve()
    content = path.read_text(encoding="utf-8")
    record = parse_afm(content, resolve_env=resolve_env)
    record.source_dir = path.parent
    return record


def _extract_frontmatter(lines: list[str]) -> tuple[AgentMetadata, int]:
    content = "\n".join(lines)
    try:
        raw, body = extract_raw_frontmatter(content)
    except ValueError as e:
        raise AFMParseError(str(e))

    if raw is None:
        return AgentMetadata(), 0

    # Calculate the body start line index
    # The frontmatter occupies: opening --- + yaml lines + closing ---
    body_start = len(lines) - len(body.splitlines()) if body else len(lines)

    if not raw:
        return AgentMetadata(), body_start

    try:
        metadata = AgentMetadata.model_validate(raw)
    except ValidationError as e:
        errors = e.errors()
        if errors:
            first_error = errors[0]
            field = ".".join(str(loc) for loc in first_error.get("loc", []))
            msg = first_error.get("msg", "Invalid value")
            raise AFMValidationError(msg, field=field)
        raise AFMValidationError(str(e))

    return metadata, body_start


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
