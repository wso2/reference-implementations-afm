# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from textual.containers import VerticalScroll
from textual.widgets import Input, Static

from afm.runner import AgentRunner
from afm.interfaces.console_chat import ChatApp


@pytest.fixture
def mock_agent() -> MagicMock:
    agent = MagicMock(spec=AgentRunner)
    agent.name = "Test Agent"
    agent.description = "A test agent for unit testing"
    # Mock arun to yield control back to the event loop
    agent.arun = AsyncMock(return_value="Hello! I'm the test agent.")
    agent.clear_history = MagicMock()
    return agent


@pytest.mark.asyncio
async def test_app_starts_with_welcome(mock_agent: MagicMock) -> None:
    app = ChatApp(mock_agent)
    async with app.run_test():
        # Check welcome message
        chat_log = app.query_one("#chat-log")
        assert chat_log is not None

        welcome_widget = chat_log.query_one(".system-message", Static)
        assert "Welcome to chat with Test Agent" in str(welcome_widget.render())


@pytest.mark.asyncio
async def test_user_message_flow(mock_agent: MagicMock) -> None:
    app = ChatApp(mock_agent)
    async with app.run_test() as pilot:
        # Type message
        input_widget = app.query_one("#chat-input", Input)
        input_widget.value = "Hello!"
        await pilot.press("enter")

        # Wait for worker to complete
        await pilot.pause()

        # Check user message
        chat_log = app.query_one("#chat-log", VerticalScroll)
        user_msgs = chat_log.query(".user-message")
        assert len(user_msgs) == 1
        assert "Hello!" in str(user_msgs[0].render())

        # Check agent response
        agent_msgs = chat_log.query(".agent-message")
        assert len(agent_msgs) == 1
        assert "Hello! I'm the test agent." in str(agent_msgs[0].render())

        # Verify agent was called
        mock_agent.arun.assert_called_once()


@pytest.mark.asyncio
async def test_help_command(mock_agent: MagicMock) -> None:
    app = ChatApp(mock_agent)
    async with app.run_test() as pilot:
        input_widget = app.query_one("#chat-input", Input)
        input_widget.value = "help"
        await pilot.press("enter")

        await pilot.pause()

        # Check for help message
        chat_log = app.query_one("#chat-log")
        system_msgs = chat_log.query(".system-message")
        # Should be welcome + help
        assert len(system_msgs) >= 2
        last_msg = system_msgs[-1]
        assert "Available commands" in str(last_msg.render())


@pytest.mark.asyncio
async def test_clear_command(mock_agent: MagicMock) -> None:
    app = ChatApp(mock_agent)
    async with app.run_test() as pilot:
        input_widget = app.query_one("#chat-input", Input)
        input_widget.value = "clear"
        await pilot.press("enter")

        await pilot.pause()

        # Check confirmation
        chat_log = app.query_one("#chat-log")
        system_msgs = chat_log.query(".system-message")
        last_msg = system_msgs[-1]
        assert "history cleared" in str(last_msg.render())

        # Verify agent called
        mock_agent.clear_history.assert_called_once()


@pytest.mark.asyncio
async def test_exit_command(mock_agent: MagicMock) -> None:
    app = ChatApp(mock_agent)
    async with app.run_test() as pilot:
        input_widget = app.query_one("#chat-input", Input)
        input_widget.value = "exit"
        await pilot.press("enter")

        # App should exit
        await pilot.pause()
        assert not app.is_running


@pytest.mark.asyncio
async def test_agent_error_display(mock_agent: MagicMock) -> None:
    mock_agent.arun.side_effect = Exception("Test Error")

    app = ChatApp(mock_agent)
    async with app.run_test() as pilot:
        input_widget = app.query_one("#chat-input", Input)
        input_widget.value = "Hello"
        await pilot.press("enter")

        await pilot.pause()

        # Check error message
        errors = app.query(".error-message")
        assert len(errors) == 1
        assert "Test Error" in str(errors[0].render())


@pytest.mark.asyncio
async def test_json_response(mock_agent: MagicMock) -> None:
    mock_agent.arun.return_value = {"foo": "bar"}

    app = ChatApp(mock_agent)
    async with app.run_test() as pilot:
        input_widget = app.query_one("#chat-input", Input)
        input_widget.value = "Hello"
        await pilot.press("enter")

        await pilot.pause()

        agent_msgs = app.query(".agent-message")
        assert '"foo": "bar"' in str(agent_msgs[0].render())
