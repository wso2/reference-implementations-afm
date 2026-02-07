# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""AFM Agent runtime using LangChain.

This module provides the Agent class that wraps a parsed AFM record
and executes it using LangChain's chat models.
"""

from __future__ import annotations

import json
import logging
from types import TracebackType
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool

from .exceptions import AgentError, InputValidationError, OutputValidationError
from .models import (
    AFMRecord,
    Interface,
    Signature,
)
from .providers import create_model_provider
from .schema_validator import (
    build_output_schema_instruction,
    coerce_output_to_schema,
    validate_input,
)
from .tools.mcp import MCPManager

logger = logging.getLogger(__name__)


class Agent:
    """AFM Agent runtime using LangChain.

    This class wraps a parsed AFMRecord and provides methods to run the agent
    with user input. It handles:
    - System prompt construction from Role + Instructions
    - LLM provider configuration
    - Session/conversation history management
    - Input/output schema validation
    - MCP tool server connections (when configured)

    For agents with MCP tools, use as an async context manager:
        >>> async with Agent(afm) as agent:
        ...     response = await agent.arun("Hello!")

    For agents without MCP tools, the context manager is optional:
        >>> agent = Agent(afm)
        >>> response = agent.run("Hello!")
    """

    def __init__(
        self,
        afm: AFMRecord,
        *,
        model: BaseChatModel | None = None,
        tools: list[BaseTool] | None = None,
    ) -> None:
        """Initialize the agent from a parsed AFM record.

        Args:
            afm: The parsed AFM record containing metadata, role, and instructions.
            model: Optional LangChain chat model to use. If not provided,
                   a model will be created from the AFM model configuration.
            tools: Optional list of LangChain tools to use. If not provided,
                   tools will be loaded from MCP servers when using the
                   async context manager.

        Raises:
            AgentConfigError: If the agent configuration is invalid.
            ProviderError: If the LLM provider cannot be configured.
        """
        self._afm = afm
        self._base_model = model or create_model_provider(afm.metadata.model)
        self._model = self._base_model  # Will be updated with tools when connected
        self._sessions: dict[str, list[HumanMessage | AIMessage]] = {}

        # MCP management
        self._mcp_manager = MCPManager.from_afm(afm)
        self._external_tools = tools or []
        self._mcp_tools: list[BaseTool] = []
        self._connected = False

        # Cache the active interface for signature validation
        self._interface = self._get_primary_interface()
        self._signature = self._get_signature()

    async def __aenter__(self) -> "Agent":
        """Connect to MCP servers and prepare tools.

        Returns:
            Self with MCP connections established.

        Raises:
            MCPConnectionError: If connection to any MCP server fails.
        """
        await self.connect()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        """Disconnect from MCP servers.

        Args:
            exc_type: Exception type if an exception occurred.
            exc_val: Exception value if an exception occurred.
            exc_tb: Exception traceback if an exception occurred.
        """
        await self.disconnect()

    async def connect(self) -> None:
        """Connect to MCP servers and load tools.

        This method is called automatically when using the agent as an
        async context manager. Call it explicitly if you need to manage
        the connection lifecycle manually.

        Raises:
            MCPConnectionError: If connection to any MCP server fails.
        """
        if self._connected:
            return

        if self._mcp_manager is not None:
            logger.info(f"Connecting to MCP servers: {self._mcp_manager.server_names}")
            self._mcp_tools = await self._mcp_manager.get_tools()
            logger.info(f"Loaded {len(self._mcp_tools)} MCP tools")

        # Bind tools to model if any are available
        all_tools = self._get_all_tools()
        if all_tools:
            self._model = self._base_model.bind_tools(all_tools)
            logger.info(f"Bound {len(all_tools)} tools to model")

        self._connected = True

    async def disconnect(self) -> None:
        """Disconnect from MCP servers and clear tools.

        This method is called automatically when exiting the async context
        manager. Call it explicitly if you need to manage the connection
        lifecycle manually.
        """
        if not self._connected:
            return

        # Clear MCP tools and reset model
        self._mcp_tools = []
        self._model = self._base_model
        self._connected = False

        if self._mcp_manager is not None:
            self._mcp_manager.clear_cache()
            logger.info("Disconnected from MCP servers")

    def _get_all_tools(self) -> list[BaseTool]:
        """Get all available tools (external + MCP).

        Returns:
            Combined list of all tools.
        """
        return self._external_tools + self._mcp_tools

    @property
    def afm(self) -> AFMRecord:
        """The underlying AFM record."""
        return self._afm

    @property
    def name(self) -> str:
        """The agent's name from metadata, or a default."""
        return self._afm.metadata.name or "AFM Agent"

    @property
    def description(self) -> str | None:
        """The agent's description from metadata."""
        return self._afm.metadata.description

    @property
    def system_prompt(self) -> str:
        """Build the system prompt from Role and Instructions."""
        return f"""# Role

{self._afm.role}

# Instructions

{self._afm.instructions}"""

    @property
    def max_iterations(self) -> int | None:
        """The maximum iterations setting from metadata."""
        return self._afm.metadata.max_iterations

    @property
    def tools(self) -> list[BaseTool]:
        """Get all available tools.

        Note: MCP tools are only available after calling connect() or
        entering the async context manager.
        """
        return self._get_all_tools()

    @property
    def is_connected(self) -> bool:
        """Check if MCP connections are established."""
        return self._connected

    @property
    def has_mcp_config(self) -> bool:
        """Check if the agent has MCP servers configured."""
        return self._mcp_manager is not None

    @property
    def signature(self) -> Signature:
        """The agent's input/output signature for validation."""
        return self._signature

    def _get_primary_interface(self) -> Interface | None:
        """Get the primary interface from metadata.

        Returns the first interface, or None if no interfaces are defined.
        """
        interfaces = self._afm.metadata.interfaces
        if interfaces and len(interfaces) > 0:
            return interfaces[0]
        return None

    def _get_signature(self) -> Signature:
        """Get the signature for input/output validation.

        Returns the signature from the primary interface, or a default
        string-to-string signature if no interface is defined.
        """
        if self._interface is not None:
            return self._interface.signature
        # Default: string input/output
        return Signature()

    def _get_session_history(self, session_id: str) -> list[HumanMessage | AIMessage]:
        """Get or create the message history for a session.

        Args:
            session_id: The session identifier.

        Returns:
            The list of messages for the session.
        """
        if session_id not in self._sessions:
            self._sessions[session_id] = []
        return self._sessions[session_id]

    def _prepare_input(self, input_data: str | dict[str, Any]) -> str:
        """Prepare and validate input data.

        Args:
            input_data: The user input (string or dict).

        Returns:
            The input as a string suitable for the LLM.

        Raises:
            InputValidationError: If input doesn't match the signature schema.
        """
        input_schema = self._signature.input

        # Validate input
        validate_input(input_data, input_schema)

        # Convert to string for the LLM
        if isinstance(input_data, str):
            return input_data
        return json.dumps(input_data)

    def _build_messages(
        self,
        user_input: str,
        session_history: list[HumanMessage | AIMessage],
    ) -> list[SystemMessage | HumanMessage | AIMessage | ToolMessage]:
        """Build the message list for the LLM.

        Args:
            user_input: The prepared user input string.
            session_history: The conversation history for this session.

        Returns:
            The complete list of messages to send to the LLM.
        """
        messages: list[SystemMessage | HumanMessage | AIMessage | ToolMessage] = [
            SystemMessage(content=self.system_prompt)
        ]

        # Add conversation history
        messages.extend(session_history)

        # Add the current user message
        # If output schema is not string, append schema instructions
        output_schema = self._signature.output
        if output_schema.type != "string":
            schema_instruction = build_output_schema_instruction(output_schema)
            user_input = user_input + schema_instruction

        messages.append(HumanMessage(content=user_input))

        return messages

    def _extract_response_content(self, response: Any) -> str:
        """Extract string content from LLM response.

        Args:
            response: The response from the LLM.

        Returns:
            The response content as a string.
        """
        if isinstance(response, AIMessage):
            content = response.content
        else:
            content = str(response)

        if not isinstance(content, str):
            content = str(content)

        return content

    def run(
        self,
        input_data: str | dict[str, Any],
        *,
        session_id: str = "default",
    ) -> str | dict[str, Any]:
        """Run the agent with the given input.

        Note: For agents with MCP tools, use arun() with the async context
        manager instead, as MCP connections require async operations.

        Args:
            input_data: The user input. Should be a string for string-type
                       signatures, or a dict for object-type signatures.
            session_id: Optional session ID for conversation history management.
                       Different session IDs maintain separate conversation histories.

        Returns:
            The agent's response. Returns a string for string-type output
            signatures, or a parsed dict/list for other output types.

        Raises:
            InputValidationError: If input doesn't match the input signature.
            OutputValidationError: If the LLM response doesn't match the output signature.
            AgentError: If there's an error during agent execution.
        """
        try:
            # Prepare and validate input
            user_input = self._prepare_input(input_data)

            # Get session history
            session_history = self._get_session_history(session_id)

            # Build messages
            messages: list[Any] = self._build_messages(user_input, session_history)

            # Max iterations for tool use
            max_iterations = (
                self.max_iterations if self.max_iterations is not None else 10
            )
            iterations = 0
            response = None

            # Main agent loop to handle tool calls
            while iterations < max_iterations:
                # Invoke the LLM
                response = self._model.invoke(messages)

                # If no tool calls, we're done
                if not response.tool_calls:
                    break

                # Add the assistant message (containing tool calls) to the conversation
                messages.append(response)

                # Execute tool calls
                for tool_call in response.tool_calls:
                    # Find the tool
                    tool_name = tool_call["name"]
                    tool = next((t for t in self.tools if t.name == tool_name), None)

                    if tool is None:
                        tool_output = f"Error: Tool '{tool_name}' not found."
                    else:
                        try:
                            # Run the tool
                            tool_output = tool.invoke(tool_call["args"])
                        except Exception as e:
                            tool_output = f"Error executing tool '{tool_name}': {e}"

                    # Add tool response to messages
                    messages.append(
                        ToolMessage(
                            content=str(tool_output),
                            tool_call_id=tool_call["id"],
                        )
                    )

                iterations += 1

            if response is None:
                raise AgentError("No response from LLM")

            # Extract content from response
            response_content = self._extract_response_content(response)

            # Validate and coerce output
            output_schema = self._signature.output
            result = coerce_output_to_schema(response_content, output_schema)

            # Update session history
            session_history.append(HumanMessage(content=user_input))
            session_history.append(AIMessage(content=response_content))

            return result

        except InputValidationError:
            raise
        except OutputValidationError:
            raise
        except Exception as e:
            if isinstance(e, AgentError):
                raise
            raise AgentError(f"Agent execution failed: {e}") from e

    async def arun(
        self,
        input_data: str | dict[str, Any],
        *,
        session_id: str = "default",
    ) -> str | dict[str, Any]:
        """Async version of run().

        When using MCP tools, this method should be called within an
        async context manager:

            async with Agent(afm) as agent:
                response = await agent.arun("Hello!")

        Args:
            input_data: The user input.
            session_id: Optional session ID for conversation history management.

        Returns:
            The agent's response.

        Raises:
            InputValidationError: If input doesn't match the input signature.
            OutputValidationError: If the LLM response doesn't match the output signature.
            AgentError: If there's an error during agent execution.
        """
        try:
            # Prepare and validate input
            user_input = self._prepare_input(input_data)

            # Get session history
            session_history = self._get_session_history(session_id)

            # Build messages
            messages: list[Any] = self._build_messages(user_input, session_history)

            # Max iterations for tool use
            max_iterations = (
                self.max_iterations if self.max_iterations is not None else 10
            )
            iterations = 0
            response = None

            # Main agent loop to handle tool calls
            while iterations < max_iterations:
                # Invoke the LLM asynchronously
                response = await self._model.ainvoke(messages)

                # If no tool calls, we're done
                if not response.tool_calls:
                    break

                # Add the assistant message (containing tool calls) to the conversation
                messages.append(response)

                # Execute tool calls
                for tool_call in response.tool_calls:
                    # Find the tool
                    tool_name = tool_call["name"]
                    tool = next((t for t in self.tools if t.name == tool_name), None)

                    if tool is None:
                        tool_output = f"Error: Tool '{tool_name}' not found."
                    else:
                        try:
                            # Run the tool
                            tool_output = await tool.ainvoke(tool_call["args"])
                        except Exception as e:
                            tool_output = f"Error executing tool '{tool_name}': {e}"

                    # Add tool response to messages
                    messages.append(
                        ToolMessage(
                            content=str(tool_output),
                            tool_call_id=tool_call["id"],
                        )
                    )

                iterations += 1

            if response is None:
                raise AgentError("No response from LLM")

            # Extract content from response
            response_content = self._extract_response_content(response)

            # Validate and coerce output
            output_schema = self._signature.output
            result = coerce_output_to_schema(response_content, output_schema)

            # Update session history (only Human and AI messages for simplicity in get_history)
            session_history.append(HumanMessage(content=user_input))
            session_history.append(AIMessage(content=response_content))

            return result

        except InputValidationError:
            raise
        except OutputValidationError:
            raise
        except Exception as e:
            if isinstance(e, AgentError):
                raise
            raise AgentError(f"Agent execution failed: {e}") from e

    def clear_history(self, session_id: str = "default") -> None:
        """Clear the conversation history for a session.

        Args:
            session_id: The session ID to clear history for.
        """
        if session_id in self._sessions:
            del self._sessions[session_id]

    def clear_all_history(self) -> None:
        """Clear conversation history for all sessions."""
        self._sessions.clear()

    def get_session_ids(self) -> list[str]:
        """Get all active session IDs.

        Returns:
            List of session IDs that have conversation history.
        """
        return list(self._sessions.keys())

    def get_history(
        self,
        session_id: str = "default",
    ) -> list[dict[str, str]]:
        """Get the conversation history for a session.

        Args:
            session_id: The session ID to get history for.

        Returns:
            List of message dicts with 'role' and 'content' keys.
        """
        history = self._get_session_history(session_id)
        result = []
        for msg in history:
            if isinstance(msg, HumanMessage):
                result.append({"role": "user", "content": str(msg.content)})
            elif isinstance(msg, AIMessage):
                result.append({"role": "assistant", "content": str(msg.content)})
        return result
