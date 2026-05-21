# Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
#
# WSO2 LLC. licenses this file to you under the Apache License,
# Version 2.0 (the "License"); you may not use this file except
# in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied. See the License for the
# specific language governing permissions and limitations
# under the License.

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ...exceptions import TemplateEvaluationError
from ...models import PlatformChatMode
from ...templates import compile_template, evaluate_template
from ..base import (
    InterfaceNotFoundError,
    get_http_path,
    get_platform_chat_interface,
)
from ..webhook import log_task_exception
from ._handler import PlatformHandler
from .gchat import GChatHandler
from .slack import SlackHandler

if TYPE_CHECKING:
    from ...models import CompiledTemplate, PlatformChatInterface
    from ...runner import AgentRunner

logger = logging.getLogger(__name__)


_HANDLERS: dict[str, PlatformHandler] = {
    SlackHandler.name: SlackHandler(),
    GChatHandler.name: GChatHandler(),
}


def get_platform_handler(platform: str) -> PlatformHandler:
    handler = _HANDLERS.get(platform)
    if handler is None:
        raise ValueError(
            f"Platform {platform!r} is not supported. "
            f"Supported platforms: {', '.join(sorted(_HANDLERS))}"
        )
    return handler


class ErrorResponse(BaseModel):
    error: str = Field(..., description="Error message")
    detail: str | None = Field(None, description="Detailed error information")


class HealthResponse(BaseModel):
    status: str = Field("ok", description="Health status")


def get_platform_session_id(platform: str, payload: object) -> str:
    handler = _HANDLERS.get(platform)
    if handler is None:
        return "default"
    return handler.get_session_id(payload)


def validate_platform_chat_interface_schema(
    interface: PlatformChatInterface,
) -> None:
    """Schema-only validation: typed platform_config check + supported platform.

    Safe to call at AFM-validate time (does not require env vars to resolve).
    Raises ValueError or pydantic ValidationError on bad config.
    """
    handler = get_platform_handler(interface.platform)
    handler.parse_config(interface.platform_config)


def validate_platform_chat_interface(
    interface: PlatformChatInterface,
    *,
    verify_signatures: bool,
) -> None:
    """Full validation: schema + runtime requirements (e.g. signing secret).

    Called at app-creation time.
    """
    handler = get_platform_handler(interface.platform)
    handler.parse_config(interface.platform_config)
    handler.validate_runtime_config(interface, verify_signatures=verify_signatures)


def create_platform_chat_router(
    agent: AgentRunner,
    interface: PlatformChatInterface,
    path: str,
    *,
    verify_signatures: bool = True,
) -> APIRouter:
    router = APIRouter()
    handler = get_platform_handler(interface.platform)

    compiled_prompt: CompiledTemplate | None = None
    if interface.prompt:
        compiled_prompt = compile_template(interface.prompt)

    is_request_mode = interface.mode == PlatformChatMode.REQUEST

    async def _run_agent_in_background(user_prompt: str, session_id: str) -> None:
        try:
            response = await agent.arun(user_prompt, session_id=session_id)
            logger.debug(f"Agent response: {response}")
        except Exception:
            logger.exception("Agent execution error")

    def _build_user_prompt(payload: object, headers: dict[str, str]) -> str:
        if compiled_prompt:
            try:
                return evaluate_template(compiled_prompt, payload, headers)
            except TemplateEvaluationError as e:
                logger.warning(f"Template evaluation error: {e}")
                raise HTTPException(
                    status_code=400,
                    detail="Failed to evaluate prompt template",
                ) from e

        return json.dumps(payload, indent=2)

    @router.post(
        path,
        status_code=202,
        responses={
            400: {"model": ErrorResponse},
            401: {"model": ErrorResponse},
        },
    )
    async def receive_platform_event(request: Request) -> Response:
        body = await request.body()
        headers = dict(request.headers)

        if verify_signatures:
            handler.verify_raw_request(body, headers, interface)

        try:
            payload = json.loads(body)
        except json.JSONDecodeError as e:
            raise HTTPException(
                status_code=400,
                detail="Invalid JSON payload",
            ) from e

        if verify_signatures:
            handler.verify_parsed_payload(payload, interface)

        early = handler.handle_pre_dispatch(payload)
        if early is not None:
            return early

        if handler.should_ignore(payload):
            return handler.create_ignored_response()

        session_id = handler.get_session_id(payload)

        if not is_request_mode:
            # Notification mode: acknowledge immediately and run
            # template evaluation + agent in the background.
            async def _background(p: object, h: dict[str, str], sid: str) -> None:
                try:
                    prompt = _build_user_prompt(p, h)
                except HTTPException:
                    logger.warning(
                        "Skipping agent execution: prompt template evaluation "
                        "failed for background platform chat event"
                    )
                    return
                await _run_agent_in_background(prompt, sid)

            task = asyncio.create_task(_background(payload, headers, session_id))
            task.add_done_callback(log_task_exception)

            return handler.create_notification_ack()

        # Request mode: run agent synchronously and return result in response.
        user_prompt = _build_user_prompt(payload, headers)
        try:
            response = await agent.arun(user_prompt, session_id=session_id)
        except Exception as e:
            logger.exception("Agent execution error")
            raise HTTPException(
                status_code=500,
                detail="Agent execution failed",
            ) from e

        return handler.create_request_response(response)

    return router


def create_platform_chat_app(
    agent: AgentRunner,
    *,
    verify_signatures: bool = True,
) -> FastAPI:
    try:
        interface = get_platform_chat_interface(agent.afm)
        path = get_http_path(interface)
    except InterfaceNotFoundError as e:
        raise ValueError(
            "Agent must have a platformchat interface to create a platformchat app. "
            "Add a platformchat interface to the agent's metadata."
        ) from e

    validate_platform_chat_interface(interface, verify_signatures=verify_signatures)

    app = FastAPI(
        title=f"{agent.name} Platform Chat",
        description=agent.description or f"Platform chat interface for {agent.name}",
        version=agent.afm.metadata.version or "0.0.0",
    )

    app.state.agent = agent
    app.state.interface = interface
    app.state.verify_signatures = verify_signatures

    @app.get("/health", response_model=HealthResponse)
    async def health_check() -> HealthResponse:
        return HealthResponse(status="ok")

    router = create_platform_chat_router(
        agent, interface, path, verify_signatures=verify_signatures
    )
    app.include_router(router)

    return app
