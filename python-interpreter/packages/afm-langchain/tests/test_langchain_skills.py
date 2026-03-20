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
from unittest.mock import MagicMock

import pytest

from afm.models import AFMRecord, AgentMetadata, LocalSkillSource, SkillInfo
from afm.skills import discover_local_skills
from afm_langchain.backend import LangChainRunner
from afm_langchain.tools.skills import ActivateSkillTool, ReadSkillResourceTool

# Reuse the fixtures from afm-core
FIXTURES_DIR = (
    Path(__file__).parent.parent.parent / "afm-core" / "tests" / "fixtures" / "skills"
)


@pytest.fixture
def multi_skills() -> dict[str, SkillInfo]:
    return discover_local_skills(FIXTURES_DIR / "multi_skills")


@pytest.fixture
def mock_chat_model() -> MagicMock:
    from unittest.mock import AsyncMock

    from langchain_core.messages import AIMessage

    model = MagicMock()
    model.ainvoke = AsyncMock(return_value=AIMessage(content="Hello!"))
    return model


# ---------------------------------------------------------------------------
# ActivateSkillTool
# ---------------------------------------------------------------------------


class TestActivateSkillTool:
    def test_activate_existing(self, multi_skills: dict[str, SkillInfo]) -> None:
        tool = ActivateSkillTool(skills=multi_skills)
        result = tool._run(name="pr-summary")
        assert "changelog" in result
        assert '<skill_content name="pr-summary">' in result

    def test_activate_unknown_returns_error(
        self, multi_skills: dict[str, SkillInfo]
    ) -> None:
        tool = ActivateSkillTool(skills=multi_skills)
        result = tool._run(name="nonexistent")
        assert "Error" in result
        assert "not found" in result

    @pytest.mark.asyncio
    async def test_arun(self, multi_skills: dict[str, SkillInfo]) -> None:
        tool = ActivateSkillTool(skills=multi_skills)
        result = await tool.ainvoke({"name": "security-review"})
        assert "OWASP" in result


# ---------------------------------------------------------------------------
# ReadSkillResourceTool
# ---------------------------------------------------------------------------


class TestReadSkillResourceTool:
    def test_read_valid_resource(self, multi_skills: dict[str, SkillInfo]) -> None:
        tool = ReadSkillResourceTool(skills=multi_skills)
        result = tool._run(
            skill_name="security-review",
            resource_path="references/REFERENCE.md",
        )
        assert "OWASP" in result

    def test_read_invalid_returns_error(
        self, multi_skills: dict[str, SkillInfo]
    ) -> None:
        tool = ReadSkillResourceTool(skills=multi_skills)
        result = tool._run(
            skill_name="security-review",
            resource_path="references/../../../etc/passwd",
        )
        assert "Error" in result
        assert "traversal" in result


# ---------------------------------------------------------------------------
# LangChainRunner integration
# ---------------------------------------------------------------------------


class TestLangChainRunnerSkills:
    def test_skills_in_system_prompt(self, mock_chat_model: MagicMock) -> None:
        afm = AFMRecord(
            metadata=AgentMetadata(
                name="Skill Agent",
                skills=[LocalSkillSource(path="multi_skills")],
            ),
            role="You are a helpful assistant.",
            instructions="Help the user.",
            source_dir=FIXTURES_DIR,
        )
        runner = LangChainRunner(afm, model=mock_chat_model)
        assert "Available Skills" in runner.system_prompt
        assert "pr-summary" in runner.system_prompt
        assert "security-review" in runner.system_prompt

    def test_skill_tools_registered(self, mock_chat_model: MagicMock) -> None:
        afm = AFMRecord(
            metadata=AgentMetadata(
                name="Skill Agent",
                skills=[LocalSkillSource(path="multi_skills")],
            ),
            role="Test",
            instructions="Test",
            source_dir=FIXTURES_DIR,
        )
        runner = LangChainRunner(afm, model=mock_chat_model)
        tool_names = [t.name for t in runner.tools]
        assert "activate_skill" in tool_names
        assert "read_skill_resource" in tool_names

    def test_no_skills_no_catalog(self, mock_chat_model: MagicMock) -> None:
        afm = AFMRecord(
            metadata=AgentMetadata(name="No Skills Agent"),
            role="Test",
            instructions="Test",
        )
        runner = LangChainRunner(afm, model=mock_chat_model)
        assert "Available Skills" not in runner.system_prompt
        assert runner.tools == []

    def test_no_source_dir_skips_skills(self, mock_chat_model: MagicMock) -> None:
        afm = AFMRecord(
            metadata=AgentMetadata(
                skills=[LocalSkillSource(path="multi_skills")],
            ),
            role="Test",
            instructions="Test",
            # source_dir not set — skills should be skipped
        )
        runner = LangChainRunner(afm, model=mock_chat_model)
        assert "Available Skills" not in runner.system_prompt
        assert runner.tools == []
