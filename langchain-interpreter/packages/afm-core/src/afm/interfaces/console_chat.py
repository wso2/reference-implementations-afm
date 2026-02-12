# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from __future__ import annotations

import logging
import uuid
from typing import TYPE_CHECKING

from rich.markup import escape
from textual import work
from textual.app import App, ComposeResult
from textual.containers import Vertical, VerticalScroll
from textual.widgets import Footer, Header, Input, LoadingIndicator, Static

if TYPE_CHECKING:
    from ..runner import AgentRunner

logger = logging.getLogger(__name__)


class ChatApp(App):
    CSS_PATH = "console_chat.tcss"
    BINDINGS = [
        ("ctrl+q", "quit", "Quit"),
        ("ctrl+l", "clear_history", "Clear History"),
        ("ctrl+h", "show_help", "Help"),
    ]

    def __init__(
        self,
        agent: AgentRunner,
        session_id: str | None = None,
    ):
        super().__init__()
        self.agent = agent
        self.session_id = session_id or str(uuid.uuid4())

    def compose(self) -> ComposeResult:
        yield Header()
        yield VerticalScroll(id="chat-log")
        yield Input(placeholder="Type a message...", id="chat-input")
        yield Footer()

    def on_mount(self) -> None:
        logger.debug("ChatApp.on_mount called")
        self.title = f"Chat with {self.agent.name}"
        if self.agent.description:
            self.sub_title = self.agent.description

        # Show welcome message
        welcome_msg = (
            f"Welcome to chat with {self.agent.name}!\n"
            "type 'exit', 'quit' or Ctrl+Q to end.\n"
            "type 'help' or Ctrl+H for help.\n"
            "type 'clear' or Ctrl+L to clear history."
        )
        self.query_one("#chat-log").mount(Static(welcome_msg, classes="system-message"))
        self.query_one("#chat-input").focus()

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        logger.debug(f"on_input_submitted triggered. Value: '{event.value}'")
        try:
            user_input = event.value.strip()
            logger.debug(f"Input submitted: {user_input}")
            if not user_input:
                return

            # Clear input
            event.input.value = ""

            # Handle local commands
            command = user_input.lower()
            if command in ("exit", "quit"):
                self.exit()
                return

            if command == "help":
                self.action_show_help()
                return

            if command == "clear":
                self.action_clear_history()
                return

            # Display user message
            chat_log = self.query_one("#chat-log")
            msg_widget = Static(f"{escape(user_input)}", classes="message user-message")
            await chat_log.mount(
                Vertical(
                    msg_widget, classes="message-container message-container--user"
                )
            )

            # Send to agent
            self._send_message(user_input)
        except Exception:
            logger.exception("Error in on_input_submitted")

    @work(exclusive=True)
    async def _send_message(self, user_input: str) -> None:
        logger.debug(f"Sending message to agent: {user_input}")

        try:
            chat_log = self.query_one("#chat-log", VerticalScroll)

            # Show thinking indicator
            thinking = LoadingIndicator()
            await chat_log.mount(thinking)
            chat_log.scroll_end(animate=False)

            response = await self.agent.arun(user_input, session_id=self.session_id)

            # Handle non-string responses
            if not isinstance(response, str):
                import json

                response = json.dumps(response, indent=2)

            # Remove thinking and show response
            await thinking.remove()
            logger.debug(f"Mounting response: '{response}'")

            msg_widget = Static(f"{escape(response)}", classes="message agent-message")
            await chat_log.mount(
                Vertical(
                    msg_widget, classes="message-container message-container--agent"
                )
            )
            chat_log.scroll_end(animate=True)

        except Exception as e:
            logger.exception("Error in _send_message")
            # Try to report error to UI if possible
            try:
                chat_log = self.query_one("#chat-log", VerticalScroll)
                # Ensure thinking is removed if it was added
                try:
                    await thinking.remove()
                except UnboundLocalError:
                    pass
                except Exception:
                    logger.debug("Failed to remove thinking indicator")
                    pass

                await chat_log.mount(
                    Static(f"[Error: {str(e)}]", classes="error-message", markup=False)
                )
            except Exception as e2:
                logger.exception(f"Could not report error to UI: {e2}")

    def action_show_help(self) -> None:
        help_msg = (
            "Available commands:\n"
            "  exit, quit, Ctrl+Q  - End the chat session\n"
            "  help,     Ctrl+H    - Show this help message\n"
            "  clear,    Ctrl+L    - Clear conversation history"
        )
        self.query_one("#chat-log").mount(Static(help_msg, classes="system-message"))
        self.query_one("#chat-log").scroll_end()

    def action_clear_history(self) -> None:
        """Clear conversation history."""
        self.agent.clear_history(self.session_id)
        self.query_one("#chat-log").mount(
            Static(
                "[Conversation history cleared]", classes="system-message", markup=False
            )
        )
        self.query_one("#chat-log").scroll_end()


async def async_run_console_chat(
    agent: AgentRunner,
    *,
    session_id: str | None = None,
) -> None:
    app = ChatApp(agent, session_id=session_id)
    await app.run_async()
