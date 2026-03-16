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

from __future__ import annotations

import logging
from pathlib import Path
from .models import AgentMetadata, LocalSkillSource, SkillInfo, SkillSource
from .parser import extract_raw_frontmatter

logger = logging.getLogger(__name__)
SKILL_FILE = "SKILL.md"
REFERENCES_DIR = "references"
ASSETS_DIR = "assets"


def extract_skill_catalog(
    metadata: AgentMetadata, afm_file_dir: Path
) -> tuple[str, dict[str, SkillInfo]] | None:
    """Discover skills and build a catalog string.

    Returns a tuple of (catalog_text, skills_dict) or None if no skills found.
    """
    if not metadata.skills:
        return None

    skills = discover_skills(metadata.skills, afm_file_dir)
    if not skills:
        return None

    logger.debug(
        "Loaded %d skill(s): %s", len(skills), ", ".join(skills.keys())
    )

    catalog = build_skill_catalog(skills)
    if catalog is None:
        return None

    return catalog, skills


def discover_skills(
    sources: list[SkillSource], afm_file_dir: Path
) -> dict[str, SkillInfo]:
    """Discover skills from all sources, resolving paths relative to the AFM file directory."""
    skills: dict[str, SkillInfo] = {}

    normalized_afm_dir = afm_file_dir.resolve()

    for source in sources:
        if not isinstance(source, LocalSkillSource):
            logger.warning("Unsupported skill source type: %s", type(source).__name__)
            continue
        if Path(source.path).is_absolute():
            raise ValueError(
                f"Skill source path must be relative, but got: {source.path}"
            )
        resolved_path = (afm_file_dir / source.path).resolve()
        if not resolved_path.is_relative_to(normalized_afm_dir):
            raise ValueError(
                f"Skill source path '{source.path}' resolves outside the AFM file directory"
            )
        local_skills = discover_local_skills(resolved_path)
        for name, info in local_skills.items():
            if name in skills:
                logger.warning(
                    "Skill '%s' already discovered, skipping duplicate from %s",
                    name,
                    source.path,
                )
                continue
            skills[name] = info

    return skills


def discover_local_skills(path: Path) -> dict[str, SkillInfo]:
    """Discover skills at a local path.

    If the path itself contains a SKILL.md, treat it as a single skill.
    Otherwise, scan subdirectories for SKILL.md files.
    """
    # Check if this path itself is a skill
    skill_md_path = path / SKILL_FILE
    if skill_md_path.is_file():
        info = parse_skill_md(skill_md_path, path)
        return {info.name: info}

    # Scan subdirectories
    skills: dict[str, SkillInfo] = {}
    if not path.is_dir():
        return skills

    for entry in sorted(path.iterdir()):
        if not entry.is_dir():
            continue
        sub_skill_md = entry / SKILL_FILE
        if not sub_skill_md.is_file():
            continue

        try:
            info = parse_skill_md(sub_skill_md, entry)
        except ValueError as e:
            logger.error("Failed to parse skill at %s: %s", entry, e)
            continue

        if info.name in skills:
            logger.warning(
                "Skill '%s' already discovered, skipping duplicate at %s",
                info.name,
                entry,
            )
            continue
        skills[info.name] = info

    return skills


def parse_skill_md(skill_md_path: Path, base_path: Path) -> SkillInfo:
    """Parse a SKILL.md file and return a SkillInfo."""
    content = skill_md_path.read_text(encoding="utf-8")
    resources = list_local_resources(base_path)
    return parse_skill_md_content(content, base_path, resources)


def parse_skill_md_content(
    content: str, base_path: Path, resources: list[str]
) -> SkillInfo:
    """Parse SKILL.md content string into a SkillInfo.

    Expects YAML frontmatter with 'name' and 'description' fields.
    """
    frontmatter, body = extract_raw_frontmatter(content)
    if frontmatter is None:
        raise ValueError("SKILL.md must start with YAML frontmatter (---)")

    name = frontmatter.get("name", "")
    description = frontmatter.get("description", "")

    if not isinstance(name, str) or not name.strip():
        raise ValueError("SKILL.md 'name' field is required and must not be empty")
    if not isinstance(description, str) or not description.strip():
        raise ValueError(
            "SKILL.md 'description' field is required and must not be empty"
        )

    return SkillInfo(
        name=name.strip(),
        description=description.strip(),
        body=body.strip(),
        base_path=base_path,
        resources=resources,
    )


def list_local_resources(base_path: Path) -> list[str]:
    """List resource files in the references/ and assets/ directories of a skill."""
    resources: list[str] = []
    for dir_name in [REFERENCES_DIR, ASSETS_DIR]:
        dir_path = base_path / dir_name
        if not dir_path.is_dir():
            continue
        for entry in sorted(dir_path.iterdir()):
            if entry.is_file():
                resources.append(f"{dir_name}/{entry.name}")
    return resources


def build_skill_catalog(skills: dict[str, SkillInfo]) -> str | None:
    """Build a skill catalog string for inclusion in the system prompt."""
    if not skills:
        return None

    skill_entries = "\n".join(
        f"    <skill>\n"
        f"        <name>{info.name}</name>\n"
        f"        <description>{info.description}</description>\n"
        f"    </skill>"
        for info in skills.values()
    )

    return (
        "\n## Available Skills\n"
        "\n"
        "The following skills provide specialized instructions for specific tasks.\n"
        "When a task matches a skill's description, call the activate_skill tool\n"
        "with the skill's name to load its full instructions.\n"
        "\n"
        "<available_skills>\n"
        f"{skill_entries}\n"
        "</available_skills>\n"
    )


def activate_skill(name: str, skills: dict[str, SkillInfo]) -> str:
    """Activate a skill by name and return its full instructions."""
    if name not in skills:
        available = ", ".join(skills.keys())
        raise ValueError(
            f"Skill '{name}' not found. Available skills: {available}"
        )

    info = skills[name]
    resources_section = ""
    if info.resources:
        resource_entries = "\n".join(
            f"<file>{res}</file>" for res in info.resources
        )
        resources_section = (
            f"\n<skill_resources>\n{resource_entries}\n</skill_resources>\n"
            "Use the read_skill_resource tool to read any of these files if needed.\n"
        )

    return (
        f'<skill_content name="{info.name}">\n'
        f"{info.body}\n"
        f"{resources_section}"
        "</skill_content>\n"
    )


def read_skill_resource(
    skill_name: str, resource_path: str, skills: dict[str, SkillInfo]
) -> str:
    """Read a resource file from a skill's references/ or assets/ directory."""
    if skill_name not in skills:
        raise ValueError(f"Skill '{skill_name}' not found")

    # Validate path structure
    parts = Path(resource_path).parts
    if len(parts) < 2 or parts[0] not in (REFERENCES_DIR, ASSETS_DIR):
        raise ValueError(
            f"Resource path must start with '{REFERENCES_DIR}/' or '{ASSETS_DIR}/'"
        )

    if ".." in Path(resource_path).parts:
        raise ValueError("Path traversal is not allowed in resource paths")

    info = skills[skill_name]
    if resource_path not in info.resources:
        available = ", ".join(info.resources)
        raise ValueError(
            f"Resource '{resource_path}' not found in skill '{skill_name}'. "
            f"Available: {available}"
        )

    full_path = info.base_path / resource_path
    return full_path.read_text(encoding="utf-8")

