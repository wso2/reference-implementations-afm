# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

import os
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


@pytest.fixture
def env_vars():
    original_values: dict[str, str | None] = {}

    class EnvManager:
        def set(self, name: str, value: str) -> None:
            if name not in original_values:
                original_values[name] = os.environ.get(name)
            os.environ[name] = value

        def unset(self, name: str) -> None:
            if name not in original_values:
                original_values[name] = os.environ.get(name)
            if name in os.environ:
                del os.environ[name]

    yield EnvManager()

    for name, original_value in original_values.items():
        if original_value is None:
            if name in os.environ:
                del os.environ[name]
        else:
            os.environ[name] = original_value
