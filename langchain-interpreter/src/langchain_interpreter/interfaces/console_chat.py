# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Console chat interface handler.

This module provides an interactive terminal-based chat interface for
AFM agents. It reads user input from stdin and prints agent responses
to stdout.
"""

from __future__ import annotations

import sys
import uuid
from typing import TYPE_CHECKING, Callable, TextIO

if TYPE_CHECKING:
    from ..agent import Agent

# Default prompts
DEFAULT_USER_PROMPT = "You: "
DEFAULT_AGENT_PREFIX = "Agent: "


def _print_welcome(agent: Agent, output: TextIO) -> None:
    """Print the welcome message for the chat session.

    Args:
        agent: The agent instance.
        output: The output stream to write to.
    """
    name = agent.name
    description = agent.description

    output.write(f"\n{'=' * 50}\n")
    output.write(f"Chat with {name}\n")
    if description:
        output.write(f"{description}\n")
    output.write(f"{'=' * 50}\n")
    output.write("Type 'exit' or 'quit' to end the chat\n")
    output.write("Type 'help' for available commands\n")
    output.write("Type 'clear' to clear conversation history\n")
    output.write("\n")
    output.flush()


def _print_help(output: TextIO) -> None:
    """Print the help message.

    Args:
        output: The output stream to write to.
    """
    output.write("\nAvailable commands:\n")
    output.write("  exit, quit  - End the chat session\n")
    output.write("  help        - Show this help message\n")
    output.write("  clear       - Clear conversation history\n")
    output.write("\n")
    output.flush()


def _print_thinking(output: TextIO) -> None:
    """Print the thinking indicator.

    Args:
        output: The output stream to write to.
    """
    output.write("[Thinking...]\n")
    output.flush()


def _print_response(response: str, output: TextIO, prefix: str) -> None:
    """Print the agent's response.

    Args:
        response: The agent's response text.
        output: The output stream to write to.
        prefix: The prefix to use before the response.
    """
    output.write(f"{prefix}{response}\n\n")
    output.flush()


def _print_error(error: str, output: TextIO) -> None:
    """Print an error message.

    Args:
        error: The error message.
        output: The output stream to write to.
    """
    output.write(f"[Error: {error}]\n\n")
    output.flush()


def _print_cleared(output: TextIO) -> None:
    """Print the history cleared message.

    Args:
        output: The output stream to write to.
    """
    output.write("[Conversation history cleared]\n\n")
    output.flush()


def _print_goodbye(output: TextIO) -> None:
    """Print the goodbye message.

    Args:
        output: The output stream to write to.
    """
    output.write("\nGoodbye!\n")
    output.flush()


def run_console_chat(
    agent: Agent,
    *,
    session_id: str | None = None,
    input_fn: Callable[[str], str] | None = None,
    output: TextIO | None = None,
    user_prompt: str = DEFAULT_USER_PROMPT,
    agent_prefix: str = DEFAULT_AGENT_PREFIX,
    show_thinking: bool = True,
) -> None:
    """Run an interactive console chat session with the agent.

    This function starts a blocking REPL loop that:
    - Reads user input from stdin (or custom input function)
    - Sends input to the agent
    - Prints the agent's response to stdout (or custom output stream)
    - Supports commands: exit, quit, help, clear

    The session continues until the user types 'exit' or 'quit',
    or sends EOF (Ctrl+D), or a KeyboardInterrupt (Ctrl+C) is received.

    Args:
        agent: The AFM agent to chat with.
        session_id: Optional session ID for conversation history.
                   If not provided, a random UUID is generated.
        input_fn: Optional custom input function. Defaults to built-in input().
                 Should accept a prompt string and return user input.
        output: Optional output stream. Defaults to sys.stdout.
        user_prompt: The prompt shown to the user. Defaults to "You: ".
        agent_prefix: The prefix for agent responses. Defaults to "Agent: ".
        show_thinking: Whether to show "[Thinking...]" while waiting. Defaults to True.

    Example:
        >>> from langchain_interpreter import parse_afm_file, Agent
        >>> from langchain_interpreter.interfaces import run_console_chat
        >>> afm = parse_afm_file("my_agent.afm.md")
        >>> agent = Agent(afm)
        >>> run_console_chat(agent)
    """
    # Set up defaults
    if session_id is None:
        session_id = str(uuid.uuid4())
    if input_fn is None:
        input_fn = input
    if output is None:
        output = sys.stdout

    # Print welcome message
    _print_welcome(agent, output)

    # Main chat loop
    while True:
        try:
            # Read user input
            user_input = input_fn(user_prompt)

            # Handle empty input
            if not user_input.strip():
                continue

            # Handle commands
            command = user_input.strip().lower()

            if command in ("exit", "quit"):
                _print_goodbye(output)
                break

            if command == "help":
                _print_help(output)
                continue

            if command == "clear":
                agent.clear_history(session_id)
                _print_cleared(output)
                continue

            # Show thinking indicator
            if show_thinking:
                _print_thinking(output)

            # Run the agent
            try:
                response = agent.run(user_input, session_id=session_id)

                # Convert response to string if needed
                if not isinstance(response, str):
                    import json

                    response = json.dumps(response, indent=2)

                _print_response(response, output, agent_prefix)

            except Exception as e:
                _print_error(str(e), output)

        except EOFError:
            # Handle Ctrl+D
            _print_goodbye(output)
            break

        except KeyboardInterrupt:
            # Handle Ctrl+C
            output.write("\n")
            _print_goodbye(output)
            break


async def async_run_console_chat(
    agent: Agent,
    *,
    session_id: str | None = None,
    input_fn: Callable[[str], str] | None = None,
    output: TextIO | None = None,
    user_prompt: str = DEFAULT_USER_PROMPT,
    agent_prefix: str = DEFAULT_AGENT_PREFIX,
    show_thinking: bool = True,
) -> None:
    """Async version of run_console_chat.

    This function uses the agent's async run method (arun) for executing
    queries. The input/output handling remains synchronous as terminal I/O
    is inherently blocking.

    Args:
        agent: The AFM agent to chat with.
        session_id: Optional session ID for conversation history.
        input_fn: Optional custom input function.
        output: Optional output stream.
        user_prompt: The prompt shown to the user.
        agent_prefix: The prefix for agent responses.
        show_thinking: Whether to show "[Thinking...]" while waiting.

    Example:
        >>> import asyncio
        >>> from langchain_interpreter import parse_afm_file, Agent
        >>> from langchain_interpreter.interfaces import async_run_console_chat
        >>> afm = parse_afm_file("my_agent.afm.md")
        >>> agent = Agent(afm)
        >>> asyncio.run(async_run_console_chat(agent))
    """
    # Set up defaults
    if session_id is None:
        session_id = str(uuid.uuid4())
    if input_fn is None:
        input_fn = input
    if output is None:
        output = sys.stdout

    # Print welcome message
    _print_welcome(agent, output)

    # Main chat loop
    while True:
        try:
            # Read user input (blocking)
            user_input = input_fn(user_prompt)

            # Handle empty input
            if not user_input.strip():
                continue

            # Handle commands
            command = user_input.strip().lower()

            if command in ("exit", "quit"):
                _print_goodbye(output)
                break

            if command == "help":
                _print_help(output)
                continue

            if command == "clear":
                agent.clear_history(session_id)
                _print_cleared(output)
                continue

            # Show thinking indicator
            if show_thinking:
                _print_thinking(output)

            # Run the agent asynchronously
            try:
                response = await agent.arun(user_input, session_id=session_id)

                # Convert response to string if needed
                if not isinstance(response, str):
                    import json

                    response = json.dumps(response, indent=2)

                _print_response(response, output, agent_prefix)

            except Exception as e:
                _print_error(str(e), output)

        except EOFError:
            # Handle Ctrl+D
            _print_goodbye(output)
            break

        except KeyboardInterrupt:
            # Handle Ctrl+C
            output.write("\n")
            _print_goodbye(output)
            break
