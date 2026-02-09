# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Webhook interface handler."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any, AsyncGenerator

import httpx
from fastapi import APIRouter, FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from ..exceptions import TemplateEvaluationError, VariableResolutionError
from ..templates import compile_template, evaluate_template
from ..variables import resolve_variables
from .base import InterfaceNotFoundError, get_http_path, get_webhook_interface

if TYPE_CHECKING:
    from ..agent import Agent
    from ..models import CompiledTemplate, WebhookInterface

logger = logging.getLogger(__name__)


class WebhookResponse(BaseModel):
    """Response model for webhook processing."""

    result: Any = Field(..., description="The agent's response to the webhook")


class ErrorResponse(BaseModel):
    """Response model for error responses."""

    error: str = Field(..., description="Error message")
    detail: str | None = Field(None, description="Detailed error information")


class HealthResponse(BaseModel):
    """Response model for health check endpoint."""

    status: str = Field("ok", description="Health status")


class WebSubSubscriber:
    """Handles WebSub subscription lifecycle.

    This class manages subscribing to a WebSub hub and handles the
    verification callback.
    """

    def __init__(
        self,
        hub: str,
        topic: str,
        callback: str,
        *,
        secret: str | None = None,
        lease_seconds: int = 86400,  # 24 hours default
    ) -> None:
        """Initialize the WebSub subscriber.

        Args:
            hub: The WebSub hub URL to subscribe to.
            topic: The topic URL to subscribe to.
            callback: The callback URL that will receive events.
            secret: Optional secret for HMAC signature verification.
            lease_seconds: Subscription lease duration in seconds.
        """
        self.hub = hub
        self.topic = topic
        self.callback = callback
        self.secret = secret
        self.lease_seconds = lease_seconds
        self._verified = False
        self._challenge: str | None = None

    @property
    def is_verified(self) -> bool:
        """Whether the subscription has been verified."""
        return self._verified

    async def subscribe(self) -> bool:
        """Send subscription request to the hub.

        Returns:
            True if subscription request was accepted, False otherwise.
        """
        try:
            async with httpx.AsyncClient() as client:
                data = {
                    "hub.mode": "subscribe",
                    "hub.topic": self.topic,
                    "hub.callback": self.callback,
                    "hub.lease_seconds": str(self.lease_seconds),
                }

                if self.secret:
                    data["hub.secret"] = self.secret

                response = await client.post(
                    self.hub,
                    data=data,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    timeout=30.0,
                )

                # WebSub spec: 202 Accepted means subscription request received
                if response.status_code in (200, 202, 204):
                    logger.info(
                        f"WebSub subscription request sent to {self.hub} "
                        f"for topic {self.topic}"
                    )
                    return True
                else:
                    logger.error(
                        f"WebSub subscription failed: {response.status_code} "
                        f"{response.text}"
                    )
                    return False

        except Exception as e:
            logger.error(f"WebSub subscription error: {e}")
            return False

    async def unsubscribe(self) -> bool:
        """Send unsubscription request to the hub.

        Returns:
            True if unsubscription request was accepted, False otherwise.
        """
        try:
            async with httpx.AsyncClient() as client:
                data = {
                    "hub.mode": "unsubscribe",
                    "hub.topic": self.topic,
                    "hub.callback": self.callback,
                }

                response = await client.post(
                    self.hub,
                    data=data,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    timeout=30.0,
                )

                if response.status_code in (200, 202, 204):
                    logger.info(f"WebSub unsubscription request sent for {self.topic}")
                    return True
                else:
                    logger.warning(
                        f"WebSub unsubscription may have failed: {response.status_code}"
                    )
                    return False

        except Exception as e:
            logger.error(f"WebSub unsubscription error: {e}")
            return False

    def verify_challenge(
        self,
        mode: str,
        topic: str,
        challenge: str,
        lease_seconds: int | None = None,
    ) -> str | None:
        """Verify a WebSub verification request.

        Args:
            mode: The hub.mode parameter (subscribe or unsubscribe).
            topic: The hub.topic parameter.
            challenge: The hub.challenge parameter to echo back.
            lease_seconds: Optional lease duration from hub.

        Returns:
            The challenge string to echo back if valid, None otherwise.
        """
        if topic != self.topic:
            logger.warning(f"Topic mismatch: expected {self.topic}, got {topic}")
            return None

        if mode == "subscribe":
            self._verified = True
            self._challenge = challenge
            logger.info(f"WebSub subscription verified for {self.topic}")
            return challenge
        elif mode == "unsubscribe":
            self._verified = False
            logger.info(f"WebSub unsubscription verified for {self.topic}")
            return challenge

        return None


def verify_webhook_signature(
    body: bytes,
    signature_header: str | None,
    secret: str,
    *,
    algorithm: str = "sha256",
) -> bool:
    """Verify the HMAC signature of a webhook payload.

    Args:
        body: The raw request body bytes.
        signature_header: The signature header value (e.g., "sha256=abc123...").
        secret: The shared secret for HMAC verification.
        algorithm: The hash algorithm (default: sha256).

    Returns:
        True if signature is valid, False otherwise.
    """
    if not signature_header:
        return False

    # Parse signature header (format: "algorithm=signature")
    if "=" in signature_header:
        algo, provided_sig = signature_header.split("=", 1)
        # Some implementations prefix with algorithm
        if algo.lower() in ("sha1", "sha256", "sha512"):
            algorithm = algo.lower()
    else:
        provided_sig = signature_header

    # Compute expected signature
    if algorithm == "sha1":
        hash_func = hashlib.sha1
    elif algorithm == "sha512":
        hash_func = hashlib.sha512
    else:
        hash_func = hashlib.sha256

    expected_sig = hmac.new(
        secret.encode("utf-8"),
        body,
        hash_func,
    ).hexdigest()

    # Constant-time comparison
    return hmac.compare_digest(expected_sig.lower(), provided_sig.lower())


def create_webhook_router(
    agent: Agent,
    interface: WebhookInterface,
    path: str = "/webhook",
    *,
    verify_signatures: bool = True,
) -> APIRouter:
    """Create an APIRouter with webhook endpoints.

    This function creates a router that can be mounted on any FastAPI app.
    It's used internally by create_webhook_app() and can be used directly
    for composing unified apps with multiple interfaces.

    Args:
        agent: The AFM agent to expose.
        interface: The webhook interface configuration.
        path: The path for the webhook endpoint. Defaults to "/webhook".
        verify_signatures: Whether to verify HMAC signatures. Defaults to True.

    Returns:
        An APIRouter with the webhook endpoints.
    """
    router = APIRouter()

    # Compile the prompt template if provided
    compiled_prompt: CompiledTemplate | None = None
    if interface.prompt:
        compiled_prompt = compile_template(interface.prompt)

    # Get signature configuration
    signature = interface.signature
    output_is_string = signature.output.type == "string"

    # Get subscription configuration
    subscription = interface.subscription
    secret = resolve_secret(subscription.secret)

    # WebSub verification endpoint
    @router.get(path)
    async def websub_verification(
        request: Request,
        hub_mode: str = Query(..., alias="hub.mode"),
        hub_topic: str = Query(..., alias="hub.topic"),
        hub_challenge: str = Query(..., alias="hub.challenge"),
        hub_lease_seconds: int | None = Query(None, alias="hub.lease_seconds"),
    ) -> PlainTextResponse:
        """WebSub subscription verification endpoint."""
        # Check for subscriber in app state (for topic verification)
        websub_subscriber = getattr(request.app.state, "websub_subscriber", None)

        if hub_mode in ("subscribe", "unsubscribe"):
            # If we have a subscriber, verify the topic matches
            if websub_subscriber is not None:
                # Use subscriber's verification logic
                challenge = websub_subscriber.verify_challenge(
                    hub_mode,
                    hub_topic,
                    hub_challenge,
                    lease_seconds=hub_lease_seconds,
                )
                if challenge:
                    return PlainTextResponse(content=challenge)
                # Verification failed (e.g. topic mismatch)
                raise HTTPException(status_code=404, detail="Verification failed")

            elif hasattr(request.app.state, "websub_subscriber"):
                # Subscriber was explicitly set to None - reject verification
                raise HTTPException(status_code=404, detail="No subscriber configured")

            return PlainTextResponse(content=hub_challenge)
        raise HTTPException(status_code=404, detail="Invalid mode")

    # Webhook receiver endpoint
    @router.post(
        path,
        responses={
            400: {"model": ErrorResponse},
            401: {"model": ErrorResponse},
            500: {"model": ErrorResponse},
        },
    )
    async def receive_webhook(request: Request) -> JSONResponse:
        """Receive and process webhook events."""
        # Get raw body for signature verification
        body = await request.body()

        # Verify signature if configured
        if verify_signatures and secret:
            signature_header = request.headers.get(
                "X-Hub-Signature-256"
            ) or request.headers.get("X-Hub-Signature")

            if not verify_webhook_signature(body, signature_header, secret):
                raise HTTPException(
                    status_code=401,
                    detail="Invalid signature",
                )

        try:
            # Parse payload
            payload = json.loads(body)
        except json.JSONDecodeError as e:
            raise HTTPException(
                status_code=400,
                detail="Invalid JSON payload",
            ) from e

        headers = dict(request.headers)
        # Construct user prompt
        if compiled_prompt:
            try:
                user_prompt = evaluate_template(compiled_prompt, payload, headers)
            except TemplateEvaluationError as e:
                logger.warning(f"Template evaluation error: {e}")
                raise HTTPException(
                    status_code=400,
                    detail="Failed to evaluate prompt template",
                ) from e
        else:
            # Default: stringify the payload
            user_prompt = json.dumps(payload, indent=2)

        try:
            # Run the agent
            response = await agent.arun(user_prompt)
            logger.debug(f"Agent response: {response}")

            # Format response based on output schema
            if output_is_string:
                if not isinstance(response, str):
                    response = json.dumps(response)
                return JSONResponse(content={"result": response})
            else:
                if isinstance(response, dict):
                    return JSONResponse(content=response)
                elif isinstance(response, str):
                    try:
                        return JSONResponse(content=json.loads(response))
                    except json.JSONDecodeError:
                        return JSONResponse(content={"result": response})
                else:
                    return JSONResponse(content={"result": response})

        except Exception as e:
            logger.exception("Agent execution error")
            raise HTTPException(
                status_code=500,
                detail="Internal server error",
            ) from e

    return router


def create_webhook_app(
    agent: Agent,
    *,
    verify_signatures: bool = True,
    auto_subscribe: bool = True,
    path: str | None = None,
    host: str | None = None,
    port: int | None = None,
) -> FastAPI:
    """Create a FastAPI application for webhook handling.

    This function creates a FastAPI app that exposes the agent as a webhook
    endpoint. The app includes:

    - POST {path} - Webhook event receiver (default: /webhook)
    - GET {path} - WebSub verification endpoint
    - GET /health - Health check

    Features:
    - Template evaluation for constructing prompts from payloads
    - HMAC signature verification (optional)
    - WebSub auto-subscription on startup (optional)

    Args:
        agent: The AFM agent to expose.
        verify_signatures: Whether to verify HMAC signatures. Defaults to True.
        auto_subscribe: Whether to auto-subscribe to WebSub hub. Defaults to True.
        path: Optional custom path for the webhook endpoint.
              If not provided, uses the path from the interface configuration
              or defaults to "/webhook".
        host: Optional host to use for WebSub callback URL construction.
              Used when subscription.callback is not configured.
        port: Optional port to use for WebSub callback URL construction.
              Used when subscription.callback is not configured.

    Returns:
        A FastAPI application instance.

    Example:
        >>> from afm_cli import parse_afm_file, Agent
        >>> from afm_cli.interfaces import create_webhook_app
        >>> import uvicorn
        >>> afm = parse_afm_file("webhook_agent.afm.md")
        >>> agent = Agent(afm)
        >>> app = create_webhook_app(agent)
        >>> uvicorn.run(app, host="0.0.0.0", port=8000)
    """
    # Get interface configuration
    try:
        interface = get_webhook_interface(agent.afm)
        webhook_path = path or get_http_path(interface)
    except InterfaceNotFoundError as e:
        raise ValueError(
            "Agent must have a webhook interface to create a webhook app. "
            "Add a webhook interface to the agent's metadata."
        ) from e

    # Get subscription configuration for WebSub
    subscription = interface.subscription
    secret = resolve_secret(subscription.secret)

    # Set up WebSub subscriber if configured
    websub_subscriber: WebSubSubscriber | None = None
    if auto_subscribe and subscription.hub and subscription.topic:
        if subscription.callback:
            callback_url = subscription.callback
        else:
            # Construct fallback callback URL from host/port
            # Use localhost for 0.0.0.0 since it's not externally routable
            if host and host != "0.0.0.0":
                effective_host = host
            else:
                effective_host = "localhost"

            effective_port = port if port else 8000
            
            callback_url = f"http://{effective_host}:{effective_port}{webhook_path}"
            logger.warning(
                f"Using auto-generated WebSub callback URL: {callback_url}. "
                "For production use, set subscription.callback explicitly in the AFM file."
            )
        websub_subscriber = WebSubSubscriber(
            hub=subscription.hub,
            topic=subscription.topic,
            callback=callback_url,
            secret=secret,
        )

    # Create lifespan context manager for startup/shutdown
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        # Startup: Subscribe to WebSub hub
        if websub_subscriber:
            # Run subscription in background to not block startup
            subscription_task = asyncio.create_task(
                subscribe_with_retry(websub_subscriber)
            )
            subscription_task.add_done_callback(log_task_exception)
            app.state.subscription_task = subscription_task
        yield
        # Shutdown: Unsubscribe from WebSub hub
        if websub_subscriber and websub_subscriber.is_verified:
            await websub_subscriber.unsubscribe()

    # Create the FastAPI app
    app = FastAPI(
        title=f"{agent.name} Webhook",
        description=agent.description or f"Webhook interface for {agent.name}",
        version=agent.afm.metadata.version or "0.0.0",
        lifespan=lifespan,
    )

    # Store references in app state
    app.state.agent = agent
    app.state.interface = interface
    app.state.websub_subscriber = websub_subscriber
    app.state.secret = secret
    app.state.verify_signatures = verify_signatures

    # ==========================================================================
    # Health Endpoint
    # ==========================================================================

    @app.get("/health", response_model=HealthResponse)
    async def health_check() -> HealthResponse:
        """Health check endpoint."""
        return HealthResponse(status="ok")

    # ==========================================================================
    # Include Webhook Router
    # ==========================================================================

    webhook_router = create_webhook_router(
        agent, interface, webhook_path, verify_signatures=verify_signatures
    )
    app.include_router(webhook_router)

    return app


async def subscribe_with_retry(
    subscriber: WebSubSubscriber,
    max_retries: int = 3,
    retry_delay: float = 5.0,
) -> None:
    """Subscribe to WebSub hub with retry logic.

    Args:
        subscriber: The WebSub subscriber instance.
        max_retries: Maximum number of retry attempts.
        retry_delay: Delay between retries in seconds.
    """
    for attempt in range(max_retries):
        try:
            success = await subscriber.subscribe()
            if success:
                return
        except Exception as e:
            logger.warning(f"WebSub subscription attempt {attempt + 1} failed: {e}")

        if attempt < max_retries - 1:
            await asyncio.sleep(retry_delay)

    logger.error(f"Failed to subscribe to WebSub after {max_retries} attempts")


def log_task_exception(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception():
        logger.error(
            "Background subscription task failed with unexpected error",
            exc_info=task.exception(),
        )


def resolve_secret(secret: str | None) -> str | None:
    if not secret:
        return None

    try:
        return resolve_variables(secret)
    except VariableResolutionError as e:
        logger.warning(f"Failed to resolve secret template {e}")
        raise
    except Exception as e:
        logger.warning(f"Unexpected error resolving secret template {e}")
        raise


def run_webhook_server(
    agent: Agent,
    *,
    host: str = "0.0.0.0",
    port: int = 8000,
    verify_signatures: bool = True,
    auto_subscribe: bool = True,
    path: str | None = None,
    log_level: str = "info",
) -> None:
    """Run a webhook server for the agent.

    This is a convenience function that creates the FastAPI app and runs
    it with uvicorn.

    Args:
        agent: The AFM agent to expose.
        host: The host to bind to. Defaults to "0.0.0.0".
        port: The port to listen on. Defaults to 8000.
        verify_signatures: Whether to verify HMAC signatures.
        auto_subscribe: Whether to auto-subscribe to WebSub hub.
        path: Optional custom path for the webhook endpoint.
        log_level: Uvicorn log level. Defaults to "info".

    Example:
        >>> from afm_cli import parse_afm_file, Agent
        >>> from afm_cli.interfaces import run_webhook_server
        >>> afm = parse_afm_file("webhook_agent.afm.md")
        >>> agent = Agent(afm)
        >>> run_webhook_server(agent, port=8080)
    """
    import uvicorn

    app = create_webhook_app(
        agent,
        verify_signatures=verify_signatures,
        auto_subscribe=auto_subscribe,
        path=path,
        host=host,
        port=port,
    )
    uvicorn.run(app, host=host, port=port, log_level=log_level)
