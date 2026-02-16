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

from pathlib import Path

import pytest


@pytest.fixture
def fixtures_dir() -> Path:
    return Path(__file__).parent / "fixtures"


@pytest.fixture
def sample_agent_path(fixtures_dir: Path) -> Path:
    return fixtures_dir / "sample_agent.afm.md"


@pytest.fixture
def sample_consolechat_path(fixtures_dir: Path) -> Path:
    return fixtures_dir / "sample_consolechat_agent.afm.md"


@pytest.fixture
def sample_webhook_path(fixtures_dir: Path) -> Path:
    return fixtures_dir / "sample_webhook_agent.afm.md"


@pytest.fixture
def sample_minimal_path(fixtures_dir: Path) -> Path:
    return fixtures_dir / "sample_minimal.afm.md"


@pytest.fixture
def sample_no_frontmatter_path(fixtures_dir: Path) -> Path:
    return fixtures_dir / "sample_no_frontmatter.afm.md"
