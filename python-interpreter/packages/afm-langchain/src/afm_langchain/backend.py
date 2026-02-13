# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from __future__ import annotations

import json
import logging
from types import TracebackType
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import BaseTool

from afm.exceptions import AgentError, InputValidationError, OutputValidationError
from afm.models import (
    AFMRecord,
    Interface,
    Signature,
)
from afm.schema_validator import (
    build_output_schema_instruction,
    coerce_output_to_schema,
    validate_input,
)

from .providers import create_model_provider
from .tools.mcp import MCPManager

logger = logging.getLogger(__name__)


class LangChainRunner:
    def __init__(
        self,
        afm: AFMRecord,
        *,
        model: BaseChatModel | None = None,
        tools: list[BaseTool] | None = None,
    ) -> None:
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

    async def __aenter__(self) -> "LangChainRunner":
        await self.connect()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.disconnect()

    async def connect(self) -> None:
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

        return self._external_tools + self._mcp_tools

    @property
    def afm(self) -> AFMRecord:
        return self._afm

    @property
    def name(self) -> str:
        return self._afm.metadata.name or "AFM Agent"

    @property
    def description(self) -> str | None:
        return self._afm.metadata.description

    @property
    def system_prompt(self) -> str:
        return f"""# Role

{self._afm.role}

# Instructions

{self._afm.instructions}"""

    @property
    def max_iterations(self) -> int | None:
        return self._afm.metadata.max_iterations

    @property
    def tools(self) -> list[BaseTool]:
        return self._get_all_tools()

    @property
    def signature(self) -> Signature:
        return self._signature

    def _get_primary_interface(self) -> Interface | None:
        interfaces = self._afm.metadata.interfaces
        if interfaces and len(interfaces) > 0:
            return interfaces[0]
        return None

    def _get_signature(self) -> Signature:
        if self._interface is not None:
            return self._interface.signature
        # Default: string input/output
        return Signature()

    def _get_session_history(self, session_id: str) -> list[HumanMessage | AIMessage]:
        if session_id not in self._sessions:
            self._sessions[session_id] = []
        return self._sessions[session_id]

    def _prepare_input(self, input_data: str | dict[str, Any]) -> str:
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
        if isinstance(response, AIMessage):
            content = response.content
        else:
            content = str(response)

        if not isinstance(content, str):
            content = str(content)

        return content

    async def arun(
        self,
        input_data: str | dict[str, Any],
        *,
        session_id: str = "default",
    ) -> str | dict[str, Any]:
        try:
            # Prepare and validate input
            user_input = self._prepare_input(input_data)

            # Get session history
            session_history = self._get_session_history(session_id)

            # Save the original input for history before schema augmentation
            original_input = user_input

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

            if iterations >= max_iterations and response and response.tool_calls:
                logger.warning(
                    f"Max iterations ({max_iterations}) reached with "
                    f"{len(response.tool_calls)} pending tool calls: "
                    f"{[tc['name'] for tc in response.tool_calls]}"
                )

            if response is None:
                raise AgentError("No response from LLM")

            # Extract content from response
            response_content = self._extract_response_content(response)

            # Validate and coerce output
            output_schema = self._signature.output
            result = coerce_output_to_schema(response_content, output_schema)

            # Update session history
            session_history.append(HumanMessage(content=original_input))
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
        if session_id in self._sessions:
            del self._sessions[session_id]
