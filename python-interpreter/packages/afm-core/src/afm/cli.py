# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from importlib.metadata import version
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncGenerator

import click
import uvicorn
from fastapi import FastAPI

from .exceptions import AFMError
from .interfaces.base import get_http_path, get_interfaces
from .interfaces.console_chat import async_run_console_chat
from .interfaces.web_chat import create_webchat_router
from .interfaces.webhook import (
    WebSubSubscriber,
    create_webhook_router,
    log_task_exception,
    subscribe_with_retry,
)
from .models import (
    ConsoleChatInterface,
    WebChatInterface,
    WebhookInterface,
)
from .parser import parse_afm_file
from .runner import AgentRunner, discover_runners, load_runner

if TYPE_CHECKING:
    from .models import AFMRecord

logger = logging.getLogger(__name__)


def create_unified_app(
    agent: AgentRunner,
    *,
    webchat_interface: WebChatInterface | None = None,
    webhook_interface: WebhookInterface | None = None,
    startup_event: asyncio.Event | None = None,
    host: str = "0.0.0.0",
    port: int = 8000,
) -> FastAPI:
    if webchat_interface is None and webhook_interface is None:
        raise ValueError("At least one HTTP interface must be provided")

    # Set up WebSub subscriber if configured
    websub_subscriber: WebSubSubscriber | None = None
    secret: str | None = None

    if webhook_interface is not None:
        subscription = webhook_interface.subscription
        secret = subscription.secret

        if subscription.hub and subscription.topic:
            webhook_path = get_http_path(webhook_interface)

            # Determine callback URL - use localhost for 0.0.0.0 since it's not externally routable
            if subscription.callback:
                callback_url = subscription.callback
            else:
                # Construct fallback callback URL from host/port
                # Use localhost for 0.0.0.0 since it's not externally routable
                if host == "0.0.0.0":
                    effective_host = "localhost"
                else:
                    effective_host = host
                callback_url = f"http://{effective_host}:{port}{webhook_path}"
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

    # Create lifespan for MCP connection management and WebSub
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
        # Connect MCP servers on startup
        await agent.connect()

        # Startup: Subscribe to WebSub hub
        if websub_subscriber:
            # Run subscription in background
            subscription_task = asyncio.create_task(
                subscribe_with_retry(websub_subscriber)
            )
            subscription_task.add_done_callback(log_task_exception)
            app.state.subscription_task = subscription_task

        # Signal that startup is complete if an event was provided
        if startup_event is not None:
            startup_event.set()
        yield
        # Shutdown: Cancel pending subscription task
        subscription_task = getattr(app.state, "subscription_task", None)
        if subscription_task is not None and not subscription_task.done():
            subscription_task.cancel()
            try:
                await subscription_task
            except asyncio.CancelledError:
                pass
        # Unsubscribe from WebSub hub if verified
        if websub_subscriber and websub_subscriber.is_verified:
            await websub_subscriber.unsubscribe()

        # Disconnect MCP servers on shutdown
        await agent.disconnect()

    # Create main app
    app = FastAPI(
        title=agent.name,
        description=agent.description or f"AFM Agent: {agent.name}",
        version=agent.afm.metadata.version or "0.0.0",
        lifespan=lifespan,
    )

    # Store agent reference
    app.state.agent = agent

    # Determine paths for info endpoint
    webchat_path = get_http_path(webchat_interface) if webchat_interface else None
    webhook_path = get_http_path(webhook_interface) if webhook_interface else None

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
        # Store subscriber in app state for verification endpoint
        app.state.websub_subscriber = websub_subscriber
        app.state.secret = secret

    return app


def format_validation_output(afm: AFMRecord) -> str:
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


def extract_interfaces(
    afm: AFMRecord,
) -> tuple[
    ConsoleChatInterface | None, WebChatInterface | None, WebhookInterface | None
]:
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


# ---------------------------------------------------------------------------
# CLI entry point: Click Group with subcommands
# ---------------------------------------------------------------------------


def _version_callback(ctx: click.Context, _param: click.Parameter, value: bool) -> None:
    if not value or ctx.resilient_parsing:
        return
    core_version = version("afm-core")
    try:
        cli_version = version("afm-cli")
        click.echo(f"afm-cli {cli_version} (afm-core {core_version})")
    except Exception:
        click.echo(f"afm-core {core_version}")
    ctx.exit()


@click.group()
@click.option(
    "--version",
    is_flag=True,
    callback=_version_callback,
    expose_value=False,
    is_eager=True,
    help="Show version information.",
)
@click.pass_context
def cli(ctx: click.Context) -> None:
    """AFM Agent CLI — parse, validate, and run Agent-Flavored Markdown files."""
    from .update import maybe_check_for_updates, notify_if_update_available

    maybe_check_for_updates()
    ctx.call_on_close(notify_if_update_available)


@cli.command()
@click.argument("file", type=click.Path(exists=True, path_type=Path))
def validate(file: Path) -> None:
    """Validate an AFM file without running the agent.

    Parses FILE and displays agent metadata, interfaces, and tools.
    Does NOT require a backend (e.g. langchain) to be installed.
    """
    try:
        afm = parse_afm_file(str(file))
    except AFMError as e:
        raise click.ClickException(f"Failed to parse AFM file: {e}") from e
    except Exception as e:
        raise click.ClickException(f"Unexpected error parsing AFM file: {e}") from e

    click.echo(f"Loading: {file}")
    click.echo(format_validation_output(afm))


@cli.command()
@click.argument("file", type=click.Path(exists=True, path_type=Path))
@click.option(
    "--framework",
    "-f",
    default=None,
    help="Runner backend to use (e.g. 'langchain'). Auto-detected if omitted.",
)
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
@click.option(
    "--log-file",
    "-l",
    type=click.Path(path_type=Path),
    help="Redirect logs to a file",
)
def run(
    file: Path,
    framework: str | None,
    port: int,
    host: str,
    dry_run: bool,
    no_console: bool,
    verbose: bool,
    log_file: Path | None,
) -> None:
    """Run an AFM agent from FILE.

    The agent will start all interfaces defined in the AFM file.
    HTTP interfaces (webchat, webhook) run on the specified port.
    Console chat runs interactively in the terminal.
    """
    try:
        afm = parse_afm_file(str(file))
    except AFMError as e:
        raise click.ClickException(f"Failed to parse AFM file: {e}") from e
    except Exception as e:
        raise click.ClickException(f"Unexpected error parsing AFM file: {e}") from e

    # Extract interfaces
    consolechat, webchat, webhook = extract_interfaces(afm)

    # Check if we have anything to run
    has_http = webchat is not None or webhook is not None
    has_console = (consolechat is not None or not has_http) and not no_console

    # Configure logging
    log_level = logging.DEBUG if verbose else logging.INFO
    log_handlers: list[logging.Handler] = []

    if has_console:
        # Scenario: Console Chat is active
        if log_file:
            # Route all logs to the specified file, silence terminal
            log_handlers.append(logging.FileHandler(log_file))
        else:
            # Silence all logs (no handlers)
            log_handlers.append(logging.NullHandler())
    else:
        # Scenario: Non-Console mode
        log_handlers.append(logging.StreamHandler())
        if log_file:
            # Route logs to file AND terminal
            log_handlers.append(logging.FileHandler(log_file))

    logging.basicConfig(
        level=log_level,
        format="%(levelname)s: %(message)s",
        handlers=log_handlers,
        force=True,  # Override any existing configuration
    )

    if not verbose:
        logging.getLogger("httpx").setLevel(logging.WARNING)
        logging.getLogger("httpcore").setLevel(logging.WARNING)

    click.echo(f"Loading: {file}")

    # Dry-run mode: validate and exit
    if dry_run:
        click.echo(format_validation_output(afm))
        return

    if not has_http and not has_console:
        click.echo("No interfaces to run (consolechat skipped with --no-console)")
        return

    # Load runner backend via entry points
    try:
        runner_cls = load_runner(framework)
    except RuntimeError as e:
        raise click.ClickException(str(e)) from e

    # Create agent
    agent = runner_cls(afm)

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

    if has_console:
        click.echo("  - consolechat (interactive)")

    click.echo("")

    # Run the appropriate configuration
    if has_http and has_console:
        # Both HTTP and console: run HTTP in background, console in foreground
        asyncio.run(
            _run_http_and_console(
                agent, webchat, webhook, host, port, verbose, has_console, log_file
            )
        )
    elif has_http:
        # HTTP only: run uvicorn blocking
        _run_http_only(agent, webchat, webhook, host, port, verbose, log_file)
    else:
        # Console only: run console blocking
        asyncio.run(_run_console_only(agent))


@cli.group()
def framework() -> None:
    """Manage runner frameworks (backends)."""


@framework.command(name="list")
def framework_list() -> None:
    """List discovered runner backends."""
    runners = discover_runners()

    if not runners:
        click.echo("No runner backends found.")
        click.echo("")
        click.echo("Install a backend package such as 'afm-langchain':")
        click.echo("  uv add afm-langchain")
        return

    click.echo("Discovered runner backends:")
    click.echo("")
    for name, ep in runners.items():
        click.echo(f"  - {name} ({ep.value})")
    click.echo("")


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


async def _run_http_and_console(
    agent: AgentRunner,
    webchat: WebChatInterface | None,
    webhook: WebhookInterface | None,
    host: str,
    port: int,
    verbose: bool,
    has_console: bool = False,
    log_file: Path | None = None,
) -> None:
    # Event to signal when server startup is complete and agent is connected
    startup_event = asyncio.Event()

    # Create unified app (lifespan handles MCP connection)
    app = create_unified_app(
        agent,
        webchat_interface=webchat,
        webhook_interface=webhook,
        startup_event=startup_event,
        host=host,
        port=port,
    )

    # Configure uvicorn logging level
    # If console is active and no log file, silence uvicorn by setting to warning/error
    if has_console and not log_file:
        uvicorn_log_level = "warning"
    else:
        uvicorn_log_level = "debug" if verbose else "info"

    # Configure uvicorn
    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level=uvicorn_log_level,
    )
    server = uvicorn.Server(config)

    # Start HTTP server in background task
    server_task = asyncio.create_task(server.serve())

    try:
        # Wait for EITHER server startup to complete OR server to fail.
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
    agent: AgentRunner,
    webchat: WebChatInterface | None,
    webhook: WebhookInterface | None,
    host: str,
    port: int,
    verbose: bool,
    log_file: Path | None = None,
) -> None:
    # Create unified app (lifespan handles MCP connections)
    app = create_unified_app(
        agent,
        webchat_interface=webchat,
        webhook_interface=webhook,
        host=host,
        port=port,
    )

    # Run uvicorn (blocking)
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="debug" if verbose else "info",
    )


async def _run_console_only(agent: AgentRunner) -> None:
    async with agent:
        await async_run_console_chat(agent)


if __name__ == "__main__":
    cli()
