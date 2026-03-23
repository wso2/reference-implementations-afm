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

from __future__ import annotations

from typing import Any, Type

from afm.models import SkillInfo
from afm.skills import activate_skill, read_skill_resource
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field


class ActivateSkillInput(BaseModel):
    name: str = Field(
        description="The name of the skill to activate (must match a name from the available skills catalog)"
    )


class ReadSkillResourceInput(BaseModel):
    skill_name: str = Field(description="The name of the skill that owns the resource")
    resource_path: str = Field(
        description="Relative path to the resource file (e.g., 'references/REFERENCE.md' or 'assets/template.json')"
    )


class ActivateSkillTool(BaseTool):
    """Activates a skill by name and returns its full instructions."""

    name: str = "activate_skill"
    description: str = (
        "Activates a skill by name and returns its full instructions "
        "along with available resources. Call this when a task matches "
        "one of the available skills' descriptions."
    )
    args_schema: Type[BaseModel] = ActivateSkillInput

    skills: dict[str, SkillInfo]

    def _run(self, name: str, **kwargs: Any) -> str:
        try:
            return activate_skill(name, self.skills)
        except ValueError as e:
            return f"Error: {e}"


class ReadSkillResourceTool(BaseTool):
    """Reads a resource file from a skill's references/ or assets/ directory."""

    name: str = "read_skill_resource"
    description: str = (
        "Reads a resource file from a skill's references/ or assets/ directory. "
        "Only files listed in skill_resources after activating a skill can be read."
    )
    args_schema: Type[BaseModel] = ReadSkillResourceInput

    skills: dict[str, SkillInfo]

    def _run(self, skill_name: str, resource_path: str, **kwargs: Any) -> str:
        try:
            return read_skill_resource(skill_name, resource_path, self.skills)
        except (ValueError, UnicodeDecodeError) as e:
            return f"Error: {e}"
