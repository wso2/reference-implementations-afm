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

from pathlib import Path

import pytest

from afm.models import AgentMetadata, LocalSkillSource, SkillInfo
from afm.skills import (
    activate_skill,
    build_skill_catalog,
    discover_local_skills,
    discover_skills,
    extract_skill_catalog,
    list_local_resources,
    parse_skill_md,
    parse_skill_md_content,
    read_skill_resource,
)

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "skills"


# ---------------------------------------------------------------------------
# parse_skill_md_content
# ---------------------------------------------------------------------------


class TestParseSkillMdContent:
    def test_valid_skill(self) -> None:
        content = "---\nname: my-skill\ndescription: Does things\n---\nBody here."
        info = parse_skill_md_content(content, Path("/tmp"), [])
        assert info.name == "my-skill"
        assert info.description == "Does things"
        assert info.body == "Body here."
        assert info.resources == []

    def test_strips_whitespace(self) -> None:
        content = "---\nname: '  spaced  '\ndescription: '  desc  '\n---\n\n  body  \n"
        info = parse_skill_md_content(content, Path("/tmp"), [])
        assert info.name == "spaced"
        assert info.description == "desc"
        assert info.body == "body"

    def test_empty_name_raises(self) -> None:
        content = "---\nname: ''\ndescription: Valid\n---\nBody."
        with pytest.raises(ValueError, match="name"):
            parse_skill_md_content(content, Path("/tmp"), [])

    def test_empty_description_raises(self) -> None:
        content = "---\nname: valid\ndescription: ''\n---\nBody."
        with pytest.raises(ValueError, match="description"):
            parse_skill_md_content(content, Path("/tmp"), [])

    def test_missing_name_raises(self) -> None:
        content = "---\ndescription: Valid\n---\nBody."
        with pytest.raises(ValueError, match="name"):
            parse_skill_md_content(content, Path("/tmp"), [])

    def test_missing_frontmatter_raises(self) -> None:
        content = "No frontmatter here."
        with pytest.raises(ValueError, match="frontmatter"):
            parse_skill_md_content(content, Path("/tmp"), [])

    def test_unclosed_frontmatter_raises(self) -> None:
        content = "---\nname: x\ndescription: y\nBody."
        with pytest.raises(ValueError, match="Unclosed"):
            parse_skill_md_content(content, Path("/tmp"), [])

    def test_preserves_resources(self) -> None:
        content = "---\nname: s\ndescription: d\n---\nBody."
        resources = ["references/REF.md", "assets/tpl.json"]
        info = parse_skill_md_content(content, Path("/tmp"), resources)
        assert info.resources == resources


# ---------------------------------------------------------------------------
# parse_skill_md (from file)
# ---------------------------------------------------------------------------


class TestParseSkillMd:
    def test_single_skill(self) -> None:
        skill_path = FIXTURES_DIR / "single_skill" / "SKILL.md"
        info = parse_skill_md(skill_path, FIXTURES_DIR / "single_skill")
        assert info.name == "test-gen"
        assert "unit tests" in info.description
        assert "Identify the functions" in info.body

    def test_invalid_skill_raises(self) -> None:
        skill_path = FIXTURES_DIR / "invalid_skill" / "SKILL.md"
        with pytest.raises(ValueError, match="name"):
            parse_skill_md(skill_path, FIXTURES_DIR / "invalid_skill")

    def test_no_frontmatter_raises(self) -> None:
        skill_path = FIXTURES_DIR / "no_frontmatter" / "SKILL.md"
        with pytest.raises(ValueError, match="frontmatter"):
            parse_skill_md(skill_path, FIXTURES_DIR / "no_frontmatter")


# ---------------------------------------------------------------------------
# list_local_resources
# ---------------------------------------------------------------------------


class TestListLocalResources:
    def test_skill_with_resources(self) -> None:
        base = FIXTURES_DIR / "multi_skills" / "security_review"
        resources = list_local_resources(base)
        assert "assets/template.json" in resources
        assert "references/REFERENCE.md" in resources

    def test_skill_without_resources(self) -> None:
        base = FIXTURES_DIR / "single_skill"
        resources = list_local_resources(base)
        assert resources == []

    def test_nonexistent_path(self) -> None:
        resources = list_local_resources(Path("/nonexistent/path"))
        assert resources == []


# ---------------------------------------------------------------------------
# discover_local_skills
# ---------------------------------------------------------------------------


class TestDiscoverLocalSkills:
    def test_single_skill_directory(self) -> None:
        skills = discover_local_skills(FIXTURES_DIR / "single_skill")
        assert "test-gen" in skills
        assert len(skills) == 1

    def test_multi_skills_directory(self) -> None:
        skills = discover_local_skills(FIXTURES_DIR / "multi_skills")
        assert "pr-summary" in skills
        assert "security-review" in skills
        assert len(skills) == 2

    def test_security_review_has_resources(self) -> None:
        skills = discover_local_skills(FIXTURES_DIR / "multi_skills")
        sr = skills["security-review"]
        assert "references/REFERENCE.md" in sr.resources
        assert "assets/template.json" in sr.resources

    def test_empty_directory(self) -> None:
        skills = discover_local_skills(FIXTURES_DIR / "empty_dir")
        assert skills == {}

    def test_invalid_skill_skipped(self) -> None:
        # invalid_skill/ has a SKILL.md with empty name — treated as a single
        # skill dir, so it raises (not skipped) when called directly
        with pytest.raises(ValueError):
            discover_local_skills(FIXTURES_DIR / "invalid_skill")

    def test_nonexistent_path(self) -> None:
        skills = discover_local_skills(Path("/nonexistent/path"))
        assert skills == {}


# ---------------------------------------------------------------------------
# discover_skills (multiple sources)
# ---------------------------------------------------------------------------


class TestDiscoverSkills:
    def test_multiple_sources(self) -> None:
        sources = [
            LocalSkillSource(path="single_skill"),
            LocalSkillSource(path="multi_skills"),
        ]
        skills = discover_skills(sources, FIXTURES_DIR)
        assert "test-gen" in skills
        assert "pr-summary" in skills
        assert "security-review" in skills
        assert len(skills) == 3

    def test_duplicate_across_sources_keeps_first(self) -> None:
        """When two sources provide the same skill name, the first one wins."""
        sources = [
            LocalSkillSource(path="single_skill"),
            LocalSkillSource(path="single_skill"),
        ]
        skills = discover_skills(sources, FIXTURES_DIR)
        assert len(skills) == 1
        assert "test-gen" in skills

    def test_empty_sources(self) -> None:
        skills = discover_skills([], FIXTURES_DIR)
        assert skills == {}

    def test_absolute_path_accepted(self) -> None:
        abs_path = str((FIXTURES_DIR / "single_skill").resolve())
        sources = [LocalSkillSource(path=abs_path)]
        skills = discover_skills(sources, Path("/some/other/dir"))
        assert len(skills) == 1
        assert "test-gen" in skills


# ---------------------------------------------------------------------------
# build_skill_catalog
# ---------------------------------------------------------------------------


class TestBuildSkillCatalog:
    def test_builds_catalog(self) -> None:
        skills = discover_local_skills(FIXTURES_DIR / "multi_skills")
        catalog = build_skill_catalog(skills)
        assert catalog is not None
        assert "Available Skills" in catalog
        assert "<name>pr-summary</name>" in catalog
        assert "<name>security-review</name>" in catalog
        assert "activate_skill" in catalog

    def test_empty_skills_returns_none(self) -> None:
        assert build_skill_catalog({}) is None


# ---------------------------------------------------------------------------
# extract_skill_catalog
# ---------------------------------------------------------------------------


class TestExtractSkillCatalog:
    def test_with_skills(self) -> None:
        metadata = AgentMetadata(skills=[LocalSkillSource(path="multi_skills")])
        result = extract_skill_catalog(metadata, FIXTURES_DIR)
        assert result is not None
        catalog, skills = result
        assert "pr-summary" in skills
        assert "security-review" in skills
        assert "Available Skills" in catalog

    def test_no_skills_metadata(self) -> None:
        metadata = AgentMetadata()
        assert extract_skill_catalog(metadata, FIXTURES_DIR) is None

    def test_empty_skills_list(self) -> None:
        metadata = AgentMetadata(skills=[])
        assert extract_skill_catalog(metadata, FIXTURES_DIR) is None


# ---------------------------------------------------------------------------
# activate_skill
# ---------------------------------------------------------------------------


class TestActivateSkill:
    @pytest.fixture
    def skills(self) -> dict[str, SkillInfo]:
        return discover_local_skills(FIXTURES_DIR / "multi_skills")

    def test_activate_existing_skill(self, skills: dict[str, SkillInfo]) -> None:
        result = activate_skill("pr-summary", skills)
        assert '<skill_content name="pr-summary">' in result
        assert "changelog" in result

    def test_activate_skill_with_resources(self, skills: dict[str, SkillInfo]) -> None:
        result = activate_skill("security-review", skills)
        assert "<skill_resources>" in result
        assert "references/REFERENCE.md" in result
        assert "assets/template.json" in result
        assert "read_skill_resource" in result

    def test_activate_skill_without_resources(self) -> None:
        skills = discover_local_skills(FIXTURES_DIR / "single_skill")
        result = activate_skill("test-gen", skills)
        assert "<skill_resources>" not in result

    def test_activate_unknown_skill_raises(self, skills: dict[str, SkillInfo]) -> None:
        with pytest.raises(ValueError, match="not found"):
            activate_skill("nonexistent", skills)


# ---------------------------------------------------------------------------
# read_skill_resource
# ---------------------------------------------------------------------------


class TestReadSkillResource:
    @pytest.fixture
    def skills(self) -> dict[str, SkillInfo]:
        return discover_local_skills(FIXTURES_DIR / "multi_skills")

    def test_read_reference(self, skills: dict[str, SkillInfo]) -> None:
        content = read_skill_resource(
            "security-review", "references/REFERENCE.md", skills
        )
        assert "OWASP" in content

    def test_read_asset(self, skills: dict[str, SkillInfo]) -> None:
        content = read_skill_resource("security-review", "assets/template.json", skills)
        assert "security-review" in content

    def test_unknown_skill_raises(self, skills: dict[str, SkillInfo]) -> None:
        with pytest.raises(ValueError, match="not found"):
            read_skill_resource("nope", "references/REFERENCE.md", skills)

    def test_unlisted_resource_raises(self, skills: dict[str, SkillInfo]) -> None:
        with pytest.raises(ValueError, match="not found in skill"):
            read_skill_resource("security-review", "references/SECRET.md", skills)

    def test_path_traversal_raises(self, skills: dict[str, SkillInfo]) -> None:
        with pytest.raises(ValueError, match="traversal"):
            read_skill_resource(
                "security-review", "references/../../../etc/passwd", skills
            )

    def test_symlink_traversal_raises(
        self, skills: dict[str, SkillInfo], tmp_path: Path
    ) -> None:
        # Create a symlink inside the skill's references/ dir pointing outside
        skill_info = skills["security-review"]
        outside_file = tmp_path / "secret.txt"
        outside_file.write_text("secret data")
        symlink = skill_info.base_path / "references" / "sneaky.md"
        symlink.symlink_to(outside_file)
        try:
            # Add the symlink to resources so it passes the allowlist check
            skill_info.resources.append("references/sneaky.md")
            with pytest.raises(ValueError, match="traversal"):
                read_skill_resource("security-review", "references/sneaky.md", skills)
        finally:
            symlink.unlink()
            skill_info.resources.remove("references/sneaky.md")

    def test_invalid_prefix_raises(self, skills: dict[str, SkillInfo]) -> None:
        with pytest.raises(ValueError, match="must start with"):
            read_skill_resource("security-review", "other/file.txt", skills)
