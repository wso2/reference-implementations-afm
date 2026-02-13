# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from unittest.mock import MagicMock, patch

import pytest

from afm_langchain.backend import LangChainRunner
from afm.models import (
    AFMRecord,
    AgentMetadata,
    Model,
)


@pytest.fixture
def mock_chat_model() -> MagicMock:
    from langchain_core.messages import AIMessage
    from unittest.mock import AsyncMock

    model = MagicMock()
    model.invoke.return_value = AIMessage(content="Hello! I'm here to help.")
    model.ainvoke = AsyncMock(
        return_value=AIMessage(content="Hello! I'm here to help.")
    )
    return model


@pytest.fixture
def simple_afm() -> AFMRecord:
    return AFMRecord(
        metadata=AgentMetadata(
            name="Test Agent",
            description="A test agent",
        ),
        role="You are a helpful assistant.",
        instructions="Be concise and helpful in your responses.",
    )


class TestAgentCreation:
    def test_create_agent_with_mock_model(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        agent = LangChainRunner(simple_afm, model=mock_chat_model)
        assert agent.name == "Test Agent"
        assert agent.description == "A test agent"

    def test_agent_name_defaults_when_not_set(
        self,
        mock_chat_model: MagicMock,
    ) -> None:
        afm = AFMRecord(
            metadata=AgentMetadata(),
            role="Test role",
            instructions="Test instructions",
        )
        agent = LangChainRunner(afm, model=mock_chat_model)
        assert agent.name == "AFM Agent"

    def test_agent_description_can_be_none(
        self,
        mock_chat_model: MagicMock,
    ) -> None:
        afm = AFMRecord(
            metadata=AgentMetadata(name="Test"),
            role="Test role",
            instructions="Test instructions",
        )
        agent = LangChainRunner(afm, model=mock_chat_model)
        assert agent.description is None

    def test_agent_stores_afm(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        agent = LangChainRunner(simple_afm, model=mock_chat_model)
        assert agent.afm is simple_afm

    def test_agent_max_iterations(
        self,
        mock_chat_model: MagicMock,
    ) -> None:
        afm = AFMRecord(
            metadata=AgentMetadata(max_iterations=50),
            role="Test role",
            instructions="Test instructions",
        )
        agent = LangChainRunner(afm, model=mock_chat_model)
        assert agent.max_iterations == 50


class TestSystemPrompt:
    def test_system_prompt_includes_role_and_instructions(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        agent = LangChainRunner(simple_afm, model=mock_chat_model)
        prompt = agent.system_prompt
        assert "# Role" in prompt
        assert "You are a helpful assistant." in prompt
        assert "# Instructions" in prompt
        assert "Be concise and helpful" in prompt


class TestModelProviderIntegration:
    @patch("afm_langchain.backend.create_model_provider")
    def test_creates_model_from_afm_config(
        self,
        mock_create_provider: MagicMock,
    ) -> None:
        mock_model = MagicMock()
        mock_create_provider.return_value = mock_model

        afm = AFMRecord(
            metadata=AgentMetadata(
                model=Model(provider="openai", name="gpt-4"),
            ),
            role="Test",
            instructions="Test",
        )

        LangChainRunner(afm)

        mock_create_provider.assert_called_once_with(afm.metadata.model)

    def test_uses_provided_model(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        with patch("afm_langchain.backend.create_model_provider") as mock_create:
            LangChainRunner(simple_afm, model=mock_chat_model)
            mock_create.assert_not_called()
