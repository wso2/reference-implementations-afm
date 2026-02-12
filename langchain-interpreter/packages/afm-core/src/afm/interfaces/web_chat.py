# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from __future__ import annotations

import html
import json
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from .base import InterfaceNotFoundError, get_http_path, get_webchat_interface

logger = logging.getLogger(__name__)

CHAT_UI_TEMPLATE_PATH = (
    Path(__file__).resolve().parent.parent / "resources" / "chat-ui.html"
)

_chat_ui_template_cache: str | None = None


def get_chat_ui_template() -> str:
    global _chat_ui_template_cache
    if _chat_ui_template_cache is not None:
        return _chat_ui_template_cache
    try:
        _chat_ui_template_cache = CHAT_UI_TEMPLATE_PATH.read_text(encoding="utf-8")
    except FileNotFoundError as e:
        raise FileNotFoundError(
            f"Chat UI template not found at {CHAT_UI_TEMPLATE_PATH}. "
            "Ensure the resources/chat-ui.html file exists in the package."
        ) from e
    return _chat_ui_template_cache


if TYPE_CHECKING:
    from ..runner import AgentRunner
    from ..models import Signature


class ObjectChatResponse(BaseModel):
    # This is a pass-through model - actual fields depend on output schema
    model_config = {"extra": "allow"}


class AgentInfo(BaseModel):
    name: str = Field(..., description="The agent's name")
    description: str | None = Field(None, description="The agent's description")
    version: str | None = Field(None, description="The agent's version")


class HealthResponse(BaseModel):
    status: str = Field("ok", description="Health status")


class ErrorResponse(BaseModel):
    error: str = Field(..., description="Error message")
    detail: str | None = Field(None, description="Detailed error information")


def create_webchat_router(
    agent: AgentRunner,
    signature: Signature,
    path: str = "/chat",
) -> APIRouter:
    router = APIRouter()
    ui_path = f"{path}/ui"
    raw_icon_url = agent.afm.metadata.icon_url
    icon_url = "" if raw_icon_url is None else html.escape(str(raw_icon_url))
    icon_style = "" if icon_url else "display:none;"
    agent_name = html.escape(str(agent.name))
    agent_description = (
        "" if agent.description is None else html.escape(str(agent.description))
    )
    chat_path_json = json.dumps(path)
    ui_html = (
        get_chat_ui_template()
        .replace("{{AGENT_NAME}}", agent_name)
        .replace("{{AGENT_DESCRIPTION}}", agent_description)
        .replace("{{AGENT_ICON_URL}}", icon_url)
        .replace("{{AGENT_ICON_STYLE}}", icon_style)
        .replace("{{CHAT_PATH}}", chat_path_json)
    )

    @router.get(ui_path, response_class=HTMLResponse)
    async def chat_ui() -> HTMLResponse:
        """Render the web chat UI."""
        return HTMLResponse(content=ui_html)

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
            except json.JSONDecodeError as e:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid JSON in request body",
                ) from e
            except UnicodeDecodeError as e:
                raise HTTPException(
                    status_code=400,
                    detail="Request body must be valid UTF-8",
                ) from e
            except Exception as e:
                logger.exception(f"Error in chat_string for session {session_id}: {e}")
                raise HTTPException(
                    status_code=500,
                    detail="Internal server error",
                ) from e

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
            except json.JSONDecodeError as e:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid JSON in request body",
                ) from e
            except Exception as e:
                logger.exception(f"Error in chat_object for session {session_id}: {e}")
                raise HTTPException(
                    status_code=500,
                    detail="Internal server error",
                ) from e

    return router


def create_webchat_app(
    agent: AgentRunner,
    *,
    cors_origins: list[str] | None = None,
    path: str | None = None,
) -> FastAPI:
    # Get interface configuration
    try:
        interface = get_webchat_interface(agent.afm)
        chat_path = path or get_http_path(interface)
        signature = interface.signature
    except InterfaceNotFoundError:
        # No webchat interface defined - use defaults
        chat_path = path or "/chat"
        signature = agent.signature  # Use agent's default signature

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

    app.state.agent = agent

    # Metadata Endpoints
    @app.get("/", response_model=AgentInfo)
    async def get_agent_info() -> AgentInfo:
        return AgentInfo(
            name=agent.name,
            description=agent.description,
            version=agent.afm.metadata.version,
        )

    @app.get("/health", response_model=HealthResponse)
    async def health_check() -> HealthResponse:
        return HealthResponse(status="ok")

    chat_router = create_webchat_router(agent, signature, chat_path)
    app.include_router(chat_router)

    return app
