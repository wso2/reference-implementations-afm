# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Command-line interface for the AFM interpreter.

This module provides the `afm` command for running AFM agents from the terminal.
It supports multiple interface types and can run them concurrently.

Usage:
    uv run afm agent.afm.md
    uv run afm agent.afm.md --port 8080
    uv run afm agent.afm.md --dry-run
    uv run afm agent.afm.md --no-console
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncGenerator

import click
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Version is defined here to avoid circular import
__cli_version__ = "0.1.0"

from .agent import Agent
from .exceptions import AFMError
from .interfaces.base import get_http_path, get_interfaces
from .interfaces.console_chat import async_run_console_chat
from .interfaces.web_chat import create_webchat_router
from .interfaces.webhook import create_webhook_router
from .models import (
    ConsoleChatInterface,
    WebChatInterface,
    WebhookInterface,
)
from .parser import parse_afm_file

if TYPE_CHECKING:
    from .models import AFMRecord

logger = logging.getLogger(__name__)


# =============================================================================
# Unified App Factory
# =============================================================================


def create_unified_app(
    agent: Agent,
    *,
    webchat_interface: WebChatInterface | None = None,
    webhook_interface: WebhookInterface | None = None,
    cors_origins: list[str] | None = None,
    startup_event: asyncio.Event | None = None,
) -> FastAPI:
    """Create a unified FastAPI app that serves multiple interface types.

    This factory creates a single FastAPI application that can serve both
    webchat and webhook interfaces on different paths. This follows the
    pattern from the Ballerina reference implementation.

    Args:
        agent: The AFM agent to expose.
        webchat_interface: Optional webchat interface configuration.
        webhook_interface: Optional webhook interface configuration.
        cors_origins: Optional list of allowed CORS origins.
        startup_event: Optional event to signal when MCP connection is complete.
            Useful for coordinating with other async tasks that need the agent
            to be connected before proceeding.

    Returns:
        A FastAPI application with routes for all configured interfaces.

    Raises:
        ValueError: If neither webchat nor webhook interface is provided.
    """
    if webchat_interface is None and webhook_interface is None:
        raise ValueError("At least one HTTP interface must be provided")

    # Create lifespan for MCP connection management
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        # Connect MCP servers on startup
        await agent.connect()
        # Signal that startup is complete if an event was provided
        if startup_event is not None:
            startup_event.set()
        yield
        # Disconnect MCP servers on shutdown
        await agent.disconnect()

    # Create main app
    app = FastAPI(
        title=agent.name,
        description=agent.description or f"AFM Agent: {agent.name}",
        version=agent.afm.metadata.version or "0.0.0",
        lifespan=lifespan,
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

    # Determine paths for info endpoint
    webchat_path = get_http_path(webchat_interface) if webchat_interface else None
    webhook_path = get_http_path(webhook_interface) if webhook_interface else None

    # ==========================================================================
    # Common Endpoints
    # ==========================================================================

    @app.get("/")
    async def root_info() -> dict[str, Any]:
        """Get agent metadata."""
        return {
            "name": agent.name,
            "description": agent.description,
            "version": agent.afm.metadata.version,
            "interfaces": {
                "webchat": webchat_path,
                "webhook": webhook_path,
            },
        }

    @app.get("/health")
    async def health_check() -> dict[str, str]:
        """Health check endpoint."""
        return {"status": "ok"}

    # ==========================================================================
    # Include Interface Routers
    # ==========================================================================

    if webchat_interface is not None:
        webchat_router = create_webchat_router(
            agent,
            webchat_interface.signature,
            webchat_path,  # type: ignore[arg-type]
        )
        app.include_router(webchat_router)

    if webhook_interface is not None:
        webhook_router = create_webhook_router(
            agent,
            webhook_interface,
            webhook_path,  # type: ignore[arg-type]
        )
        app.include_router(webhook_router)

    return app


# =============================================================================
# Validation Output
# =============================================================================


def format_validation_output(afm: AFMRecord) -> str:
    """Format validation output for --dry-run mode.

    Args:
        afm: The parsed AFM record.

    Returns:
        Formatted string with agent information.
    """
    lines: list[str] = []
    lines.append("")
    lines.append("Agent validated successfully")
    lines.append("")

    # Basic info
    name = afm.metadata.name or "Unnamed Agent"
    lines.append(f"  Name: {name}")

    if afm.metadata.description:
        lines.append(f"  Description: {afm.metadata.description}")

    if afm.metadata.version:
        lines.append(f"  Version: {afm.metadata.version}")

    # Model info
    if afm.metadata.model:
        model = afm.metadata.model
        model_name = model.name or "default"
        provider = model.provider or "openai"
        lines.append(f"  Model: {model_name} via {provider}")

    lines.append("")

    # Interfaces
    interfaces = get_interfaces(afm)
    lines.append("  Interfaces:")
    for iface in interfaces:
        sig = iface.signature
        sig_str = f"{sig.input.type} -> {sig.output.type}"

        if isinstance(iface, ConsoleChatInterface):
            lines.append(f"    - consolechat ({sig_str})")
        elif isinstance(iface, WebChatInterface):
            path = get_http_path(iface)
            lines.append(f"    - webchat at {path} ({sig_str})")
        elif isinstance(iface, WebhookInterface):
            path = get_http_path(iface)
            lines.append(f"    - webhook at {path} ({sig_str})")

    # Tools
    if afm.metadata.tools and afm.metadata.tools.mcp:
        lines.append("")
        lines.append("  MCP Servers:")
        for server in afm.metadata.tools.mcp:
            lines.append(f"    - {server.name}: {server.transport.url}")
            if server.tool_filter:
                if server.tool_filter.allow:
                    lines.append(f"      Allow: {', '.join(server.tool_filter.allow)}")
                if server.tool_filter.deny:
                    lines.append(f"      Deny: {', '.join(server.tool_filter.deny)}")

    lines.append("")
    return "\n".join(lines)


# =============================================================================
# Interface Extraction
# =============================================================================


def extract_interfaces(
    afm: AFMRecord,
) -> tuple[
    ConsoleChatInterface | None, WebChatInterface | None, WebhookInterface | None
]:
    """Extract and validate interfaces from AFM record.

    Args:
        afm: The parsed AFM record.

    Returns:
        Tuple of (consolechat, webchat, webhook) interfaces.

    Raises:
        click.ClickException: If multiple interfaces of the same type are found.
    """
    interfaces = get_interfaces(afm)

    consolechat: ConsoleChatInterface | None = None
    webchat: WebChatInterface | None = None
    webhook: WebhookInterface | None = None

    console_count = 0
    webchat_count = 0
    webhook_count = 0

    for iface in interfaces:
        if isinstance(iface, ConsoleChatInterface):
            console_count += 1
            consolechat = iface
        elif isinstance(iface, WebChatInterface):
            webchat_count += 1
            webchat = iface
        elif isinstance(iface, WebhookInterface):
            webhook_count += 1
            webhook = iface

    if console_count > 1 or webchat_count > 1 or webhook_count > 1:
        raise click.ClickException(
            "Multiple interfaces of the same type are not supported"
        )

    return consolechat, webchat, webhook


# =============================================================================
# Main CLI Command
# =============================================================================


@click.command()
@click.argument("file", type=click.Path(exists=True, path_type=Path))
@click.option(
    "--port",
    "-p",
    default=8000,
    type=int,
    help="HTTP port for web interfaces (default: 8000)",
)
@click.option(
    "--host",
    "-H",
    default="0.0.0.0",
    help="Host to bind HTTP server to (default: 0.0.0.0)",
)
@click.option(
    "--dry-run",
    is_flag=True,
    help="Validate AFM file without running the agent",
)
@click.option(
    "--no-console",
    is_flag=True,
    help="Skip consolechat interface even if defined",
)
@click.option(
    "--verbose",
    "-v",
    is_flag=True,
    help="Enable verbose/debug logging",
)
@click.version_option(version=__cli_version__, prog_name="afm")
def main(
    file: Path,
    port: int,
    host: str,
    dry_run: bool,
    no_console: bool,
    verbose: bool,
) -> None:
    """Run an AFM agent from FILE.

    The agent will start all interfaces defined in the AFM file.
    HTTP interfaces (webchat, webhook) run on the specified port.
    Console chat runs interactively in the terminal.

    Examples:

        uv run afm agent.afm.md

        uv run afm agent.afm.md --port 8080

        uv run afm agent.afm.md --dry-run

        uv run afm agent.afm.md --no-console
    """
    # Configure logging
    log_level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(levelname)s: %(message)s",
    )
    if not verbose:
        logging.getLogger("httpx").setLevel(logging.WARNING)
        logging.getLogger("httpcore").setLevel(logging.WARNING)

    # Parse AFM file
    click.echo(f"Loading: {file}")
    try:
        afm = parse_afm_file(str(file))
    except AFMError as e:
        raise click.ClickException(f"Failed to parse AFM file: {e}")
    except Exception as e:
        raise click.ClickException(f"Unexpected error parsing AFM file: {e}")

    # Dry-run mode: validate and exit
    if dry_run:
        click.echo(format_validation_output(afm))
        return

    # Extract interfaces
    consolechat, webchat, webhook = extract_interfaces(afm)

    # Check if we have anything to run
    has_http = webchat is not None or webhook is not None
    has_console = consolechat is not None and not no_console

    if not has_http and not has_console:
        click.echo("No interfaces to run (consolechat skipped with --no-console)")
        return

    # Create agent
    agent = Agent(afm)

    # Print startup info
    click.echo("")
    click.echo(f"Agent: {agent.name}")
    if agent.description:
        click.echo(f"Description: {agent.description}")

    click.echo("")
    click.echo("Starting interfaces:")

    if webchat:
        webchat_path = get_http_path(webchat)
        click.echo(f"  - webchat at http://{host}:{port}{webchat_path}")

    if webhook:
        webhook_path = get_http_path(webhook)
        click.echo(f"  - webhook at http://{host}:{port}{webhook_path}")

    if has_console:
        click.echo("  - consolechat (interactive)")

    click.echo("")

    # Run the appropriate configuration
    if has_http and has_console:
        # Both HTTP and console: run HTTP in background, console in foreground
        asyncio.run(_run_http_and_console(agent, webchat, webhook, host, port, verbose))
    elif has_http:
        # HTTP only: run uvicorn blocking
        _run_http_only(agent, webchat, webhook, host, port, verbose)
    else:
        # Console only: run console blocking
        asyncio.run(_run_console_only(agent))


async def _run_http_and_console(
    agent: Agent,
    webchat: WebChatInterface | None,
    webhook: WebhookInterface | None,
    host: str,
    port: int,
    verbose: bool,
) -> None:
    """Run HTTP server in background and console chat in foreground."""
    # Event to signal when server startup is complete and agent is connected
    startup_event = asyncio.Event()

    # Create unified app (lifespan handles MCP connection)
    app = create_unified_app(
        agent,
        webchat_interface=webchat,
        webhook_interface=webhook,
        startup_event=startup_event,
    )

    # Configure uvicorn
    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level="debug" if verbose else "info",
    )
    server = uvicorn.Server(config)

    # Start HTTP server in background task
    server_task = asyncio.create_task(server.serve())

    try:
        # Wait for EITHER server startup to complete OR server to fail.
        # Without this race, a port-in-use error (or any startup failure)
        # leaves startup_event unset and we block forever.
        startup_waiter = asyncio.create_task(startup_event.wait())
        done, _pending = await asyncio.wait(
            [server_task, startup_waiter],
            return_when=asyncio.FIRST_COMPLETED,
        )

        if server_task in done:
            # Server exited before startup completed — propagate the error
            startup_waiter.cancel()
            server_task.result()  # raises the underlying exception
            return  # unreachable if result() raised

        # Server started successfully — run console chat, but also watch
        # for the server dying mid-run so we don't hang.
        console_task = asyncio.create_task(async_run_console_chat(agent))
        done, pending = await asyncio.wait(
            [server_task, console_task],
            return_when=asyncio.FIRST_COMPLETED,
        )

        for task in pending:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, SystemExit):
                pass

        # If the server exited (e.g. port in use), inform the user
        if server_task in done:
            click.echo(
                "\nHTTP server stopped unexpectedly. Exiting.",
                err=True,
            )

        # Propagate any real exception from whichever task finished first
        for task in done:
            exc = task.exception()
            if exc is not None and not isinstance(exc, SystemExit):
                raise exc
    finally:
        # Ensure the HTTP server shuts down cleanly
        server.should_exit = True
        try:
            await server_task
        except (asyncio.CancelledError, SystemExit):
            pass


def _run_http_only(
    agent: Agent,
    webchat: WebChatInterface | None,
    webhook: WebhookInterface | None,
    host: str,
    port: int,
    verbose: bool,
) -> None:
    """Run HTTP server only (blocking)."""
    # Create unified app (lifespan handles MCP connections)
    app = create_unified_app(
        agent,
        webchat_interface=webchat,
        webhook_interface=webhook,
    )

    # Run uvicorn (blocking)
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="debug" if verbose else "info",
    )


async def _run_console_only(agent: Agent) -> None:
    """Run console chat only."""
    async with agent:
        await async_run_console_chat(agent)


if __name__ == "__main__":
    main()
