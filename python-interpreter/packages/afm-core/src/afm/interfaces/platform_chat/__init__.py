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
from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ...exceptions import TemplateEvaluationError
from ...models import DEFAULT_POLLING_INTERVAL_SECONDS, PlatformChatMode
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
from .telegram import TelegramHandler

if TYPE_CHECKING:
    from ...models import CompiledTemplate, PlatformChatInterface
    from ...runner import AgentRunner

logger = logging.getLogger(__name__)

# Bounded in-loop retry for the polling dispatch path. The polling loop
# retries each update up to this many times before logging a drop and
# moving on. Counts are intentionally low: transient errors (network blip,
# LLM 5xx) usually recover within one or two retries, while permanent
# errors (template misalignment, persistent agent bug) should not stall
# the bot indefinitely.
MAX_DISPATCH_ATTEMPTS = 3
DISPATCH_BACKOFF_SECONDS = 1.0


_HANDLERS: dict[str, PlatformHandler] = {
    SlackHandler.name: SlackHandler(),
    GChatHandler.name: GChatHandler(),
    TelegramHandler.name: TelegramHandler(),
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
    detail: str = Field(..., description="Error message")


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
    if interface.mode not in handler.supported_modes:
        supported = ", ".join(sorted(m.value for m in handler.supported_modes))
        raise ValueError(
            f"Platform {interface.platform!r} does not support mode "
            f"{interface.mode.value!r}. Supported modes: {supported}"
        )
    handler.parse_config(interface.platform_config)


def validate_platform_chat_interface(
    interface: PlatformChatInterface,
    *,
    verify_signatures: bool,
) -> None:
    """Full validation: schema + runtime requirements (e.g. signing secret).

    Called at app-creation time.
    """
    validate_platform_chat_interface_schema(interface)
    handler = get_platform_handler(interface.platform)
    handler.validate_runtime_config(interface, verify_signatures=verify_signatures)


async def run_polling_loop(
    agent: AgentRunner,
    interface: PlatformChatInterface,
    *,
    stop_event: asyncio.Event | None = None,
) -> None:
    """Drive a platform's polling lifecycle until ``stop_event`` is set.

    Repeatedly calls ``handler.poll_updates``, dispatches each returned
    update through :func:`dispatch_update`, and sleeps ``Polling.interval``
    between iterations.

    Delivery semantics: at-least-once for transient failures, at-most-once
    for permanent ones. Each update is dispatched up to
    ``MAX_DISPATCH_ATTEMPTS`` times with exponential backoff
    (``DISPATCH_BACKOFF_SECONDS * 2**attempt``). Transient failures (LLM
    5xx, network blips) typically recover within the retry budget;
    permanent failures (template misalignment, persistent agent bug) are
    logged as ``ERROR`` with the update id and skipped, so a single bad
    update does not stall the bot.

    Updates are processed sequentially within a batch to preserve
    conversational order; a retrying update therefore delays subsequent
    updates in the same batch until its attempts are exhausted.

    State is held in-process only — restarting the runner restarts the
    cursor from the platform's default position. For Telegram this means
    Telegram-side retained updates (~24h) are re-delivered on restart.
    """
    handler = get_platform_handler(interface.platform)

    if interface.mode != PlatformChatMode.POLLING:
        raise ValueError(
            "run_polling_loop called with interface.mode = "
            f"{interface.mode.value!r}; expected 'polling'"
        )

    if PlatformChatMode.POLLING not in handler.supported_modes:
        raise ValueError(
            f"Platform {interface.platform!r} does not support polling mode"
        )

    handler.validate_runtime_config(interface, verify_signatures=False)

    compiled_prompt: CompiledTemplate | None = None
    if interface.prompt:
        compiled_prompt = compile_template(interface.prompt)

    interval = (
        interface.polling.interval
        if interface.polling
        else DEFAULT_POLLING_INTERVAL_SECONDS
    )

    state: dict[str, Any] = {}
    stop = stop_event or asyncio.Event()

    logger.info(
        "Starting polling loop for platform %r (interval=%ss)",
        interface.platform,
        interval,
    )

    while not stop.is_set():
        try:
            updates, next_state = await handler.poll_updates(interface, state)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Polling iteration failed; sleeping before retry")
            await _sleep_or_stop(interval, stop)
            continue

        completed_batch = True
        for update in updates:
            if handler.should_ignore(update):
                continue
            await _dispatch_with_retry(
                handler=handler,
                agent=agent,
                payload=update,
                compiled_prompt=compiled_prompt,
                stop=stop,
            )
            if stop.is_set():
                completed_batch = False
                break

        # Advance the cursor only after the dispatch loop has had its
        # chance at every update in the batch. The next poll_updates call
        # is what actually ack's the batch with the platform; deferring
        # the local assignment until here keeps that ordering explicit.
        if completed_batch:
            state = next_state

        await _sleep_or_stop(interval, stop)

    logger.info("Polling loop for platform %r stopped", interface.platform)


async def _dispatch_with_retry(
    *,
    handler: PlatformHandler,
    agent: AgentRunner,
    payload: Any,
    compiled_prompt: CompiledTemplate | None,
    stop: asyncio.Event,
) -> bool:
    """Dispatch one update with bounded retries + exponential backoff.

    Returns ``True`` if any attempt succeeded, ``False`` if all attempts
    were exhausted. A drop is logged at ``ERROR`` so it surfaces in ops
    monitoring rather than blending into normal warning noise.
    """
    for attempt in range(MAX_DISPATCH_ATTEMPTS):
        try:
            success = await dispatch_update(
                handler=handler,
                agent=agent,
                payload=payload,
                headers={},
                compiled_prompt=compiled_prompt,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            # dispatch_update is supposed to catch its own errors; if
            # something escapes, treat it as a failed attempt and keep
            # the loop going.
            logger.exception("Unexpected error from dispatch_update")
            success = False

        if success:
            return True

        # Don't sleep after the last attempt — the next thing we do is
        # log and move on.
        if attempt < MAX_DISPATCH_ATTEMPTS - 1:
            backoff = DISPATCH_BACKOFF_SECONDS * (2**attempt)
            await _sleep_or_stop(backoff, stop)
            if stop.is_set():
                return False

    logger.error(
        "Dropping update after %d failed dispatch attempts: update=%s",
        MAX_DISPATCH_ATTEMPTS,
        _summarize_dropped_payload(payload),
    )
    return False


def _summarize_dropped_payload(payload: Any) -> str:
    """Compact, log-safe summary of a payload for the drop message.

    Avoids dumping the whole event (which can be large and contain user
    content). Falls back to the type name if structure isn't recognized.
    """
    if isinstance(payload, dict):
        # Telegram's shape; safe to read defensively.
        update_id = payload.get("update_id")
        return f"update_id={update_id}"
    return f"<{type(payload).__name__}>"


async def _sleep_or_stop(seconds: float, stop: asyncio.Event) -> None:
    if stop.is_set():
        return
    if seconds <= 0:
        await asyncio.sleep(0)
        return
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        return


async def dispatch_update(
    *,
    handler: PlatformHandler,
    agent: AgentRunner,
    payload: Any,
    headers: dict[str, str],
    compiled_prompt: CompiledTemplate | None,
) -> bool:
    """Background-style per-update dispatch shared by notification mode
    (webhook) and polling mode. Assumes the caller has already filtered out
    updates that ``handler.should_ignore`` would reject (because the webhook
    router needs to return ``create_ignored_response`` for those). Logs and
    skips on template or agent errors so a single bad update doesn't crash
    the surrounding flow.

    Returns ``True`` if the agent ran to completion, ``False`` if a
    template-eval or agent-execution error was swallowed. The polling loop
    uses this to drive bounded retries; the webhook router ignores it
    (notification mode is fire-and-forget — Telegram/Slack/etc. won't
    redeliver, so there's no point retrying).
    """
    session_id = handler.get_session_id(payload)

    if compiled_prompt:
        try:
            user_prompt = evaluate_template(compiled_prompt, payload, headers)
        except TemplateEvaluationError as e:
            logger.warning("Skipping update: prompt template evaluation failed: %s", e)
            return False
    else:
        user_prompt = json.dumps(payload, indent=2)

    try:
        response = await agent.arun(user_prompt, session_id=session_id)
        logger.debug("Agent response: %s", response)
        return True
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Agent execution error")
        return False


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

        if not is_request_mode:
            # Notification mode: ack immediately and let dispatch_update
            # render the prompt + run the agent in the background.
            task = asyncio.create_task(
                dispatch_update(
                    handler=handler,
                    agent=agent,
                    payload=payload,
                    headers=headers,
                    compiled_prompt=compiled_prompt,
                )
            )
            task.add_done_callback(log_task_exception)
            return handler.create_notification_ack()

        # Request mode: synchronous flow with HTTP error propagation.
        session_id = handler.get_session_id(payload)
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
