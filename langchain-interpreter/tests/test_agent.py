# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Tests for the Agent class."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from langchain_interpreter.agent import Agent
from langchain_interpreter.exceptions import (
    AgentError,
    InputValidationError,
    OutputValidationError,
)
from langchain_interpreter.models import (
    AFMRecord,
    AgentMetadata,
    ConsoleChatInterface,
    JSONSchema,
    Model,
    Signature,
    WebChatInterface,
)


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def mock_chat_model() -> MagicMock:
    """Create a mock LangChain chat model."""
    model = MagicMock()
    model.invoke.return_value = AIMessage(content="Hello! I'm here to help.")
    model.ainvoke = AsyncMock(
        return_value=AIMessage(content="Hello! I'm here to help.")
    )
    return model


@pytest.fixture
def simple_afm() -> AFMRecord:
    """Create a simple AFM record for testing."""
    return AFMRecord(
        metadata=AgentMetadata(
            name="Test Agent",
            description="A test agent",
        ),
        role="You are a helpful assistant.",
        instructions="Be concise and helpful in your responses.",
    )


@pytest.fixture
def afm_with_interface() -> AFMRecord:
    """Create an AFM record with an interface."""
    return AFMRecord(
        metadata=AgentMetadata(
            name="Chat Agent",
            interfaces=[ConsoleChatInterface()],
        ),
        role="You are a chat assistant.",
        instructions="Respond conversationally.",
    )


@pytest.fixture
def afm_with_object_output() -> AFMRecord:
    """Create an AFM record with object output signature."""
    return AFMRecord(
        metadata=AgentMetadata(
            name="JSON Agent",
            interfaces=[
                WebChatInterface(
                    signature=Signature(
                        input=JSONSchema(type="string"),
                        output=JSONSchema(
                            type="object",
                            properties={
                                "answer": JSONSchema(type="string"),
                                "confidence": JSONSchema(type="number"),
                            },
                            required=["answer"],
                        ),
                    ),
                ),
            ],
        ),
        role="You are a question-answering agent.",
        instructions="Answer questions and provide confidence scores.",
    )


@pytest.fixture
def afm_with_object_input() -> AFMRecord:
    """Create an AFM record with object input signature."""
    return AFMRecord(
        metadata=AgentMetadata(
            name="Structured Input Agent",
            interfaces=[
                WebChatInterface(
                    signature=Signature(
                        input=JSONSchema(
                            type="object",
                            properties={
                                "query": JSONSchema(type="string"),
                                "context": JSONSchema(type="string"),
                            },
                            required=["query"],
                        ),
                        output=JSONSchema(type="string"),
                    ),
                ),
            ],
        ),
        role="You answer questions with context.",
        instructions="Use the provided context to answer the query.",
    )


# =============================================================================
# Agent Creation Tests
# =============================================================================


class TestAgentCreation:
    """Tests for Agent initialization."""

    def test_create_agent_with_mock_model(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test creating an agent with a mock model."""
        agent = Agent(simple_afm, model=mock_chat_model)
        assert agent.name == "Test Agent"
        assert agent.description == "A test agent"

    def test_agent_name_defaults_when_not_set(
        self,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that agent name defaults when not in metadata."""
        afm = AFMRecord(
            metadata=AgentMetadata(),
            role="Test role",
            instructions="Test instructions",
        )
        agent = Agent(afm, model=mock_chat_model)
        assert agent.name == "AFM Agent"

    def test_agent_description_can_be_none(
        self,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that description can be None."""
        afm = AFMRecord(
            metadata=AgentMetadata(name="Test"),
            role="Test role",
            instructions="Test instructions",
        )
        agent = Agent(afm, model=mock_chat_model)
        assert agent.description is None

    def test_agent_stores_afm(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that agent stores the AFM record."""
        agent = Agent(simple_afm, model=mock_chat_model)
        assert agent.afm is simple_afm

    def test_agent_max_iterations(
        self,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that max_iterations is accessible."""
        afm = AFMRecord(
            metadata=AgentMetadata(max_iterations=50),
            role="Test role",
            instructions="Test instructions",
        )
        agent = Agent(afm, model=mock_chat_model)
        assert agent.max_iterations == 50


# =============================================================================
# System Prompt Tests
# =============================================================================


class TestSystemPrompt:
    """Tests for system prompt generation."""

    def test_system_prompt_includes_role_and_instructions(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that system prompt includes role and instructions."""
        agent = Agent(simple_afm, model=mock_chat_model)
        prompt = agent.system_prompt
        assert "# Role" in prompt
        assert "You are a helpful assistant." in prompt
        assert "# Instructions" in prompt
        assert "Be concise and helpful" in prompt


# =============================================================================
# Run Tests
# =============================================================================


class TestAgentRun:
    """Tests for Agent.run() method."""

    def test_run_with_string_input(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test running with simple string input."""
        agent = Agent(simple_afm, model=mock_chat_model)
        result = agent.run("Hello!")

        assert result == "Hello! I'm here to help."
        mock_chat_model.invoke.assert_called_once()

    def test_run_passes_system_prompt(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that run passes the system prompt to the model."""
        agent = Agent(simple_afm, model=mock_chat_model)
        agent.run("Hello!")

        call_args = mock_chat_model.invoke.call_args[0][0]
        assert isinstance(call_args[0], SystemMessage)
        assert "# Role" in call_args[0].content

    def test_run_passes_user_message(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that run passes the user message to the model."""
        agent = Agent(simple_afm, model=mock_chat_model)
        agent.run("What is 2+2?")

        call_args = mock_chat_model.invoke.call_args[0][0]
        # Last message should be the user message
        assert isinstance(call_args[-1], HumanMessage)
        assert "What is 2+2?" in call_args[-1].content

    def test_run_with_object_output_parses_json(
        self,
        afm_with_object_output: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that object output schema parses JSON response."""
        mock_chat_model.invoke.return_value = AIMessage(
            content='```json\n{"answer": "42", "confidence": 0.95}\n```'
        )

        agent = Agent(afm_with_object_output, model=mock_chat_model)
        result = agent.run("What is the meaning of life?")

        assert isinstance(result, dict)
        assert result["answer"] == "42"
        assert result["confidence"] == 0.95

    def test_run_with_object_input_validates(
        self,
        afm_with_object_input: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that object input is validated."""
        agent = Agent(afm_with_object_input, model=mock_chat_model)
        result = agent.run({"query": "What is Python?"})

        assert result == "Hello! I'm here to help."

    def test_run_with_invalid_input_raises_error(
        self,
        afm_with_object_input: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that invalid input raises InputValidationError."""
        agent = Agent(afm_with_object_input, model=mock_chat_model)

        with pytest.raises(InputValidationError):
            agent.run({})  # Missing required 'query' field

    def test_run_with_object_output_validates_response(
        self,
        afm_with_object_output: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that invalid output raises AgentError wrapping OutputValidationError."""
        mock_chat_model.invoke.return_value = AIMessage(
            content='{"wrong_field": "value"}'  # Missing required 'answer'
        )

        agent = Agent(afm_with_object_output, model=mock_chat_model)

        with pytest.raises(AgentError) as exc_info:
            agent.run("Test")

        # Verify it's wrapping an OutputValidationError
        assert isinstance(exc_info.value.__cause__, OutputValidationError)

    def test_run_model_error_raises_agent_error(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that model errors are wrapped in AgentError."""
        mock_chat_model.invoke.side_effect = Exception("Model error")

        agent = Agent(simple_afm, model=mock_chat_model)

        with pytest.raises(AgentError) as exc_info:
            agent.run("Hello!")

        assert "Agent execution failed" in str(exc_info.value)


# =============================================================================
# Async Run Tests
# =============================================================================


class TestAgentArun:
    """Tests for Agent.arun() async method."""

    @pytest.mark.asyncio
    async def test_arun_with_string_input(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test async run with simple string input."""
        agent = Agent(simple_afm, model=mock_chat_model)
        result = await agent.arun("Hello!")

        assert result == "Hello! I'm here to help."
        mock_chat_model.ainvoke.assert_called_once()

    @pytest.mark.asyncio
    async def test_arun_with_object_output(
        self,
        afm_with_object_output: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test async run with object output."""
        mock_chat_model.ainvoke.return_value = AIMessage(
            content='{"answer": "async response", "confidence": 0.99}'
        )

        agent = Agent(afm_with_object_output, model=mock_chat_model)
        result = await agent.arun("Test async")

        assert isinstance(result, dict)
        assert result["answer"] == "async response"


# =============================================================================
# Session Management Tests
# =============================================================================


class TestSessionManagement:
    """Tests for session/conversation history management."""

    def test_conversation_history_maintained(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that conversation history is maintained across calls."""
        agent = Agent(simple_afm, model=mock_chat_model)

        agent.run("First message")
        agent.run("Second message")

        # Second call should include history
        second_call_messages = mock_chat_model.invoke.call_args_list[1][0][0]
        # Should have: system + first human + first ai + second human
        assert len(second_call_messages) >= 4

    def test_different_sessions_have_separate_history(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that different session IDs have separate histories."""
        agent = Agent(simple_afm, model=mock_chat_model)

        agent.run("Session A message", session_id="session_a")
        agent.run("Session B message", session_id="session_b")

        history_a = agent.get_history("session_a")
        history_b = agent.get_history("session_b")

        assert len(history_a) == 2  # user + assistant
        assert len(history_b) == 2
        assert history_a[0]["content"] == "Session A message"
        assert history_b[0]["content"] == "Session B message"

    def test_clear_history(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test clearing history for a session."""
        agent = Agent(simple_afm, model=mock_chat_model)

        agent.run("Test message")
        assert len(agent.get_history()) > 0

        agent.clear_history()
        assert len(agent.get_history()) == 0

    def test_clear_all_history(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test clearing all session histories."""
        agent = Agent(simple_afm, model=mock_chat_model)

        agent.run("Session A", session_id="a")
        agent.run("Session B", session_id="b")

        assert len(agent.get_session_ids()) == 2

        agent.clear_all_history()
        assert len(agent.get_session_ids()) == 0

    def test_get_session_ids(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test getting list of session IDs."""
        agent = Agent(simple_afm, model=mock_chat_model)

        agent.run("One", session_id="session1")
        agent.run("Two", session_id="session2")

        session_ids = agent.get_session_ids()
        assert "session1" in session_ids
        assert "session2" in session_ids

    def test_get_history_format(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that get_history returns correct format."""
        agent = Agent(simple_afm, model=mock_chat_model)

        agent.run("Hello!")
        history = agent.get_history()

        assert len(history) == 2
        assert history[0]["role"] == "user"
        assert history[0]["content"] == "Hello!"
        assert history[1]["role"] == "assistant"


# =============================================================================
# Model Provider Integration Tests
# =============================================================================


class TestModelProviderIntegration:
    """Tests for model provider integration."""

    @patch("langchain_interpreter.agent.create_model_provider")
    def test_creates_model_from_afm_config(
        self,
        mock_create_provider: MagicMock,
    ) -> None:
        """Test that model is created from AFM config when not provided."""
        mock_model = MagicMock()
        mock_create_provider.return_value = mock_model

        afm = AFMRecord(
            metadata=AgentMetadata(
                model=Model(provider="openai", name="gpt-4"),
            ),
            role="Test",
            instructions="Test",
        )

        agent = Agent(afm)

        mock_create_provider.assert_called_once_with(afm.metadata.model)

    def test_uses_provided_model(
        self,
        simple_afm: AFMRecord,
        mock_chat_model: MagicMock,
    ) -> None:
        """Test that provided model is used instead of creating one."""
        with patch("langchain_interpreter.agent.create_model_provider") as mock_create:
            agent = Agent(simple_afm, model=mock_chat_model)
            mock_create.assert_not_called()
