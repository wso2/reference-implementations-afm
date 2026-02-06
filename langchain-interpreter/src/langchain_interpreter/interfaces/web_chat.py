# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Web chat interface handler.

This module provides an HTTP REST endpoint for chatting with AFM agents
using FastAPI.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from .base import get_http_path, get_webchat_interface, InterfaceNotFoundError

if TYPE_CHECKING:
    from ..agent import Agent
    from ..models import Signature


# =============================================================================
# Request/Response Models
# =============================================================================


class ObjectChatResponse(BaseModel):
    """Response model for object-based chat (pass-through)."""

    # This is a pass-through model - actual fields depend on output schema
    model_config = {"extra": "allow"}


class AgentInfo(BaseModel):
    """Response model for agent metadata endpoint."""

    name: str = Field(..., description="The agent's name")
    description: str | None = Field(None, description="The agent's description")
    version: str | None = Field(None, description="The agent's version")


class HealthResponse(BaseModel):
    """Response model for health check endpoint."""

    status: str = Field("ok", description="Health status")


class ErrorResponse(BaseModel):
    """Response model for error responses."""

    error: str = Field(..., description="Error message")
    detail: str | None = Field(None, description="Detailed error information")


# =============================================================================
# Webchat Router Factory
# =============================================================================


def create_webchat_router(
    agent: Agent,
    signature: Signature,
    path: str = "/chat",
) -> APIRouter:
    """Create an APIRouter with webchat endpoints.

    This function creates a router that can be mounted on any FastAPI app.
    It's used internally by create_webchat_app() and can be used directly
    for composing unified apps with multiple interfaces.

    Args:
        agent: The AFM agent to expose.
        signature: The interface signature defining input/output types.
        path: The path for the chat endpoint. Defaults to "/chat".

    Returns:
        An APIRouter with the webchat endpoints.
    """
    router = APIRouter()

    # Determine if we need simple string I/O or complex schema
    input_is_string = signature.input.type == "string"
    output_is_string = signature.output.type == "string"

    # Create the appropriate chat endpoint based on signature
    if input_is_string and output_is_string:
        # Simple string-to-string chat
        @router.post(
            path,
            response_class=PlainTextResponse,
            responses={
                400: {"model": ErrorResponse},
                500: {"model": ErrorResponse},
            },
        )
        async def chat_string(
            request: Request,
            x_session_id: str | None = Header(None, alias="X-Session-Id"),
        ) -> PlainTextResponse:
            """Chat with the agent using simple string messages."""
            session_id = x_session_id or "default"

            try:
                content_type = request.headers.get("content-type", "").lower()
                if content_type.startswith("text/plain") or not content_type:
                    body = await request.body()
                    message = body.decode("utf-8")
                elif content_type.startswith("application/json"):
                    body = await request.json()
                    if not isinstance(body, str):
                        raise HTTPException(
                            status_code=400,
                            detail="Expected JSON string for string input",
                        )
                    message = body
                else:
                    raise HTTPException(
                        status_code=400,
                        detail="Unsupported Content-Type for string input",
                    )

                if not isinstance(message, str) or not message.strip():
                    raise HTTPException(
                        status_code=400,
                        detail="Message body must be a non-empty string",
                    )

                response = await agent.arun(message, session_id=session_id)

                if not isinstance(response, str):
                    response = json.dumps(response)

                return PlainTextResponse(content=response)

            except HTTPException:
                raise
            except json.JSONDecodeError:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid JSON in request body",
                )
            except Exception as e:
                raise HTTPException(
                    status_code=500,
                    detail=str(e),
                )

    else:
        # Complex schema-based chat
        @router.post(
            path,
            responses={
                400: {"model": ErrorResponse},
                500: {"model": ErrorResponse},
            },
        )
        async def chat_object(
            request: Request,
            x_session_id: str | None = Header(None, alias="X-Session-Id"),
        ) -> JSONResponse:
            """Chat with the agent using schema-validated messages."""
            session_id = x_session_id or "default"

            try:
                content_type = request.headers.get("content-type", "").lower()
                if not content_type.startswith("application/json"):
                    raise HTTPException(
                        status_code=400,
                        detail="Content-Type must be application/json",
                    )
                # Parse request body
                body = await request.json()

                # For string input schema, extract the string value
                if input_is_string:
                    if isinstance(body, str):
                        input_data: str | dict[str, Any] = body
                    else:
                        raise HTTPException(
                            status_code=400,
                            detail="Expected JSON string for string input",
                        )
                else:
                    input_data = body

                # Run the agent
                response = await agent.arun(input_data, session_id=session_id)

                # Format response based on output schema
                if output_is_string:
                    if not isinstance(response, str):
                        response = json.dumps(response)
                    return JSONResponse(content={"response": response})
                else:
                    # Object output - return as-is or wrap
                    if isinstance(response, dict):
                        return JSONResponse(content=response)
                    elif isinstance(response, str):
                        # Try to parse as JSON
                        try:
                            return JSONResponse(content=json.loads(response))
                        except json.JSONDecodeError:
                            return JSONResponse(content={"response": response})
                    else:
                        return JSONResponse(content={"response": response})

            except HTTPException:
                raise
            except json.JSONDecodeError:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid JSON in request body",
                )
            except Exception as e:
                raise HTTPException(
                    status_code=500,
                    detail=str(e),
                )

    return router


# =============================================================================
# Web Chat App Factory
# =============================================================================


def create_webchat_app(
    agent: Agent,
    *,
    cors_origins: list[str] | None = None,
    path: str | None = None,
) -> FastAPI:
    """Create a FastAPI application for web chat.

    This function creates a FastAPI app that exposes the agent as an HTTP
    REST endpoint. The app includes:

    - POST {path} - Chat endpoint (default: /chat)
    - GET / - Agent metadata
    - GET /health - Health check

    Args:
        agent: The AFM agent to expose.
        cors_origins: Optional list of allowed CORS origins.
                     If provided, CORS middleware will be added.
        path: Optional custom path for the chat endpoint.
              If not provided, uses the path from the interface configuration
              or defaults to "/chat".

    Returns:
        A FastAPI application instance.

    Example:
        >>> from langchain_interpreter import parse_afm_file, Agent
        >>> from langchain_interpreter.interfaces import create_webchat_app
        >>> import uvicorn
        >>> afm = parse_afm_file("my_agent.afm.md")
        >>> agent = Agent(afm)
        >>> app = create_webchat_app(agent, cors_origins=["http://localhost:3000"])
        >>> uvicorn.run(app, host="0.0.0.0", port=8000)
    """
    # Get interface configuration
    try:
        interface = get_webchat_interface(agent.afm)
        chat_path = path or get_http_path(interface)
        signature = interface.signature
    except InterfaceNotFoundError:
        # No webchat interface defined - use defaults
        chat_path = path or "/chat"
        signature = agent._signature  # Use agent's default signature

    # Create the FastAPI app
    app = FastAPI(
        title=agent.name,
        description=agent.description or f"Web chat interface for {agent.name}",
        version=agent.afm.metadata.version or "0.0.0",
    )

    # Add CORS middleware if origins specified
    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # Store agent reference
    app.state.agent = agent

    # ==========================================================================
    # Metadata Endpoints
    # ==========================================================================

    @app.get("/", response_model=AgentInfo)
    async def get_agent_info() -> AgentInfo:
        """Get agent metadata."""
        return AgentInfo(
            name=agent.name,
            description=agent.description,
            version=agent.afm.metadata.version,
        )

    @app.get("/health", response_model=HealthResponse)
    async def health_check() -> HealthResponse:
        """Health check endpoint."""
        return HealthResponse(status="ok")

    # ==========================================================================
    # Include Chat Router
    # ==========================================================================

    chat_router = create_webchat_router(agent, signature, chat_path)
    app.include_router(chat_router)

    return app


def run_webchat_server(
    agent: Agent,
    *,
    host: str = "0.0.0.0",
    port: int = 8000,
    cors_origins: list[str] | None = None,
    path: str | None = None,
    log_level: str = "info",
) -> None:
    """Run a web chat server for the agent.

    This is a convenience function that creates the FastAPI app and runs
    it with uvicorn.

    Args:
        agent: The AFM agent to expose.
        host: The host to bind to. Defaults to "0.0.0.0".
        port: The port to listen on. Defaults to 8000.
        cors_origins: Optional list of allowed CORS origins.
        path: Optional custom path for the chat endpoint.
        log_level: Uvicorn log level. Defaults to "info".

    Example:
        >>> from langchain_interpreter import parse_afm_file, Agent
        >>> from langchain_interpreter.interfaces import run_webchat_server
        >>> afm = parse_afm_file("my_agent.afm.md")
        >>> agent = Agent(afm)
        >>> run_webchat_server(agent, port=8080)
    """
    import uvicorn

    app = create_webchat_app(agent, cors_origins=cors_origins, path=path)
    uvicorn.run(app, host=host, port=port, log_level=log_level)
