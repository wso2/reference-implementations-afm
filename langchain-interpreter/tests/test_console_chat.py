# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Tests for console chat interface handler."""

from __future__ import annotations

import io
from unittest.mock import MagicMock

import pytest

from langchain_interpreter import AFMRecord, AgentMetadata
from langchain_interpreter.agent import Agent
from langchain_interpreter.interfaces.console_chat import (
    async_run_console_chat,
    run_console_chat,
)


@pytest.fixture
def mock_agent() -> MagicMock:
    """Create a mock agent for testing."""
    agent = MagicMock(spec=Agent)
    agent.name = "Test Agent"
    agent.description = "A test agent for unit testing"
    agent.run = MagicMock(return_value="Hello! I'm the test agent.")
    agent.arun = MagicMock(return_value="Hello! I'm the async test agent.")
    agent.clear_history = MagicMock()
    return agent


@pytest.fixture
def sample_afm() -> AFMRecord:
    """Create a sample AFM record for testing."""
    return AFMRecord(
        metadata=AgentMetadata(
            name="Test Agent",
            description="A test agent",
        ),
        role="You are a helpful assistant.",
        instructions="Be helpful and concise.",
    )


class TestRunConsoleChat:
    """Tests for run_console_chat function."""

    def test_exit_command(self, mock_agent: MagicMock) -> None:
        """Test that 'exit' command ends the chat."""
        output = io.StringIO()
        inputs = iter(["exit"])

        run_console_chat(
            mock_agent,
            input_fn=lambda _: next(inputs),
            output=output,
        )

        result = output.getvalue()
        assert "Chat with Test Agent" in result
        assert "Goodbye!" in result
        mock_agent.run.assert_not_called()

    def test_quit_command(self, mock_agent: MagicMock) -> None:
        """Test that 'quit' command ends the chat."""
        output = io.StringIO()
        inputs = iter(["quit"])

        run_console_chat(
            mock_agent,
            input_fn=lambda _: next(inputs),
            output=output,
        )

        result = output.getvalue()
        assert "Goodbye!" in result
        mock_agent.run.assert_not_called()

    def test_help_command(self, mock_agent: MagicMock) -> None:
        """Test that 'help' command shows available commands."""
        output = io.StringIO()
        inputs = iter(["help", "exit"])

        run_console_chat(
            mock_agent,
            input_fn=lambda _: next(inputs),
            output=output,
        )

        result = output.getvalue()
        assert "Available commands:" in result
        assert "exit, quit" in result
        assert "help" in result
        assert "clear" in result

    def test_clear_command(self, mock_agent: MagicMock) -> None:
        """Test that 'clear' command clears conversation history."""
        output = io.StringIO()
        inputs = iter(["clear", "exit"])

        run_console_chat(
            mock_agent,
            session_id="test-session",
            input_fn=lambda _: next(inputs),
            output=output,
        )

        result = output.getvalue()
        assert "Conversation history cleared" in result
        mock_agent.clear_history.assert_called_once_with("test-session")

    def test_empty_input_ignored(self, mock_agent: MagicMock) -> None:
        """Test that empty input is ignored."""
        output = io.StringIO()
        inputs = iter(["", "   ", "exit"])

        run_console_chat(
            mock_agent,
            input_fn=lambda _: next(inputs),
            output=output,
        )

        mock_agent.run.assert_not_called()

    def test_user_message_sent_to_agent(self, mock_agent: MagicMock) -> None:
        """Test that user messages are sent to the agent."""
        output = io.StringIO()
        inputs = iter(["Hello!", "exit"])

        run_console_chat(
            mock_agent,
            session_id="test-session",
            input_fn=lambda _: next(inputs),
            output=output,
        )

        mock_agent.run.assert_called_once_with("Hello!", session_id="test-session")
        result = output.getvalue()
        assert "Hello! I'm the test agent." in result

    def test_thinking_indicator_shown(self, mock_agent: MagicMock) -> None:
        """Test that thinking indicator is shown by default."""
        output = io.StringIO()
        inputs = iter(["Hello!", "exit"])

        run_console_chat(
            mock_agent,
            input_fn=lambda _: next(inputs),
            output=output,
            show_thinking=True,
        )

        result = output.getvalue()
        assert "[Thinking...]" in result

    def test_thinking_indicator_hidden(self, mock_agent: MagicMock) -> None:
        """Test that thinking indicator can be hidden."""
        output = io.StringIO()
        inputs = iter(["Hello!", "exit"])

        run_console_chat(
            mock_agent,
            input_fn=lambda _: next(inputs),
            output=output,
            show_thinking=False,
        )

        result = output.getvalue()
        assert "[Thinking...]" not in result

    def test_custom_prompts(self, mock_agent: MagicMock) -> None:
        """Test that custom prompts can be used."""
        output = io.StringIO()
        prompts_received: list[str] = []

        def capture_prompt(prompt: str) -> str:
            prompts_received.append(prompt)
            return "exit"

        run_console_chat(
            mock_agent,
            input_fn=capture_prompt,
            output=output,
            user_prompt=">> ",
            agent_prefix="Bot: ",
        )

        assert prompts_received == [">> "]

    def test_agent_error_handled(self, mock_agent: MagicMock) -> None:
        """Test that agent errors are handled gracefully."""
        output = io.StringIO()
        inputs = iter(["Hello!", "exit"])
        mock_agent.run.side_effect = Exception("Test error")

        run_console_chat(
            mock_agent,
            input_fn=lambda _: next(inputs),
            output=output,
        )

        result = output.getvalue()
        assert "[Error: Test error]" in result

    def test_json_response_formatted(self, mock_agent: MagicMock) -> None:
        """Test that JSON responses are formatted."""
        output = io.StringIO()
        inputs = iter(["Hello!", "exit"])
        mock_agent.run.return_value = {"response": "test", "confidence": 0.9}

        run_console_chat(
            mock_agent,
            input_fn=lambda _: next(inputs),
            output=output,
        )

        result = output.getvalue()
        assert '"response": "test"' in result
        assert '"confidence": 0.9' in result

    def test_eof_ends_chat(self, mock_agent: MagicMock) -> None:
        """Test that EOF (Ctrl+D) ends the chat."""
        output = io.StringIO()

        def raise_eof(_: str) -> str:
            raise EOFError()

        run_console_chat(
            mock_agent,
            input_fn=raise_eof,
            output=output,
        )

        result = output.getvalue()
        assert "Goodbye!" in result

    def test_keyboard_interrupt_ends_chat(self, mock_agent: MagicMock) -> None:
        """Test that KeyboardInterrupt (Ctrl+C) ends the chat."""
        output = io.StringIO()

        def raise_interrupt(_: str) -> str:
            raise KeyboardInterrupt()

        run_console_chat(
            mock_agent,
            input_fn=raise_interrupt,
            output=output,
        )

        result = output.getvalue()
        assert "Goodbye!" in result

    def test_session_id_auto_generated(self, mock_agent: MagicMock) -> None:
        """Test that session ID is auto-generated if not provided."""
        output = io.StringIO()
        inputs = iter(["Hello!", "exit"])

        run_console_chat(
            mock_agent,
            input_fn=lambda _: next(inputs),
            output=output,
        )

        # Verify run was called with some session_id
        call_args = mock_agent.run.call_args
        assert call_args is not None
        assert "session_id" in call_args.kwargs
        assert len(call_args.kwargs["session_id"]) > 0

    def test_welcome_shows_description(self, mock_agent: MagicMock) -> None:
        """Test that welcome message shows agent description."""
        output = io.StringIO()
        inputs = iter(["exit"])

        run_console_chat(
            mock_agent,
            input_fn=lambda _: next(inputs),
            output=output,
        )

        result = output.getvalue()
        assert "A test agent for unit testing" in result

    def test_welcome_without_description(self, mock_agent: MagicMock) -> None:
        """Test that welcome message works without description."""
        output = io.StringIO()
        inputs = iter(["exit"])
        mock_agent.description = None

        run_console_chat(
            mock_agent,
            input_fn=lambda _: next(inputs),
            output=output,
        )

        result = output.getvalue()
        assert "Chat with Test Agent" in result


class TestAsyncRunConsoleChat:
    """Tests for async_run_console_chat function."""

    @pytest.mark.asyncio
    async def test_exit_command(self, mock_agent: MagicMock) -> None:
        """Test that 'exit' command ends the async chat."""
        output = io.StringIO()
        inputs = iter(["exit"])

        await async_run_console_chat(
            mock_agent,
            input_fn=lambda _: next(inputs),
            output=output,
        )

        result = output.getvalue()
        assert "Chat with Test Agent" in result
        assert "Goodbye!" in result

    @pytest.mark.asyncio
    async def test_user_message_sent_to_agent(self, mock_agent: MagicMock) -> None:
        """Test that user messages use arun in async mode."""
        output = io.StringIO()
        inputs = iter(["Hello!", "exit"])

        # Make arun a coroutine
        async def mock_arun(msg: str, session_id: str) -> str:
            return "Hello! I'm the async test agent."

        mock_agent.arun = mock_arun

        await async_run_console_chat(
            mock_agent,
            session_id="test-session",
            input_fn=lambda _: next(inputs),
            output=output,
        )

        result = output.getvalue()
        assert "Hello! I'm the async test agent." in result

    @pytest.mark.asyncio
    async def test_clear_command(self, mock_agent: MagicMock) -> None:
        """Test that 'clear' command clears conversation history in async mode."""
        output = io.StringIO()
        inputs = iter(["clear", "exit"])

        await async_run_console_chat(
            mock_agent,
            session_id="test-session",
            input_fn=lambda _: next(inputs),
            output=output,
        )

        result = output.getvalue()
        assert "Conversation history cleared" in result
        mock_agent.clear_history.assert_called_once_with("test-session")

    @pytest.mark.asyncio
    async def test_agent_error_handled(self, mock_agent: MagicMock) -> None:
        """Test that agent errors are handled gracefully in async mode."""
        output = io.StringIO()
        inputs = iter(["Hello!", "exit"])

        async def mock_arun_error(msg: str, session_id: str) -> str:
            raise Exception("Async test error")

        mock_agent.arun = mock_arun_error

        await async_run_console_chat(
            mock_agent,
            input_fn=lambda _: next(inputs),
            output=output,
        )

        result = output.getvalue()
        assert "[Error: Async test error]" in result
