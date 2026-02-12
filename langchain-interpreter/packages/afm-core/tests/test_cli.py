# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from click.testing import CliRunner

from afm.cli import (
    __cli_version__,
    cli,
    create_unified_app,
)
from afm.models import (
    Subscription,
    WebChatInterface,
    WebhookInterface,
)
from afm.parser import parse_afm_file
from afm.runner import AgentRunner


@pytest.fixture
def runner():
    return CliRunner()


def _make_mock_agent() -> MagicMock:
    """Create a mock that satisfies the AgentRunner protocol."""
    agent = MagicMock(spec=AgentRunner)
    agent.name = "TestAgent"
    agent.description = "Test description"
    agent.afm = MagicMock()
    agent.afm.metadata.version = "0.1.0"
    agent.afm.metadata.tools = None
    return agent


class TestCLIBasics:
    def test_version(self, runner: CliRunner):
        result = runner.invoke(cli, ["--version"])
        assert result.exit_code == 0
        assert __cli_version__ in result.output

    def test_help(self, runner: CliRunner):
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "validate" in result.output
        assert "run" in result.output
        assert "framework" in result.output

    def test_run_help(self, runner: CliRunner):
        result = runner.invoke(cli, ["run", "--help"])
        assert result.exit_code == 0
        assert "Run an AFM agent from FILE" in result.output
        assert "--port" in result.output
        assert "--dry-run" in result.output
        assert "--no-console" in result.output
        assert "--verbose" in result.output
        assert "--framework" in result.output

    def test_run_missing_file_argument(self, runner: CliRunner):
        result = runner.invoke(cli, ["run"])
        assert result.exit_code != 0
        assert "Missing argument" in result.output or "Usage:" in result.output

    def test_run_nonexistent_file(self, runner: CliRunner):
        result = runner.invoke(cli, ["run", "/nonexistent/path/agent.afm.md"])
        assert result.exit_code != 0
        assert (
            "does not exist" in result.output.lower()
            or "error" in result.output.lower()
        )


class TestValidateCommand:
    def test_validate_valid_file(self, runner: CliRunner, sample_agent_path: Path):
        result = runner.invoke(cli, ["validate", str(sample_agent_path)])
        assert result.exit_code == 0
        assert "validated successfully" in result.output.lower()
        assert "TestAgent" in result.output

    def test_validate_minimal_file(self, runner: CliRunner, sample_minimal_path: Path):
        result = runner.invoke(cli, ["validate", str(sample_minimal_path)])
        assert result.exit_code == 0
        assert "validated successfully" in result.output.lower()

    def test_validate_shows_interfaces(
        self, runner: CliRunner, sample_agent_path: Path
    ):
        result = runner.invoke(cli, ["validate", str(sample_agent_path)])
        assert result.exit_code == 0
        assert "Interfaces:" in result.output
        assert "webchat" in result.output.lower()

    def test_validate_shows_mcp_servers(
        self, runner: CliRunner, sample_agent_path: Path
    ):
        result = runner.invoke(cli, ["validate", str(sample_agent_path)])
        assert result.exit_code == 0
        assert "MCP Servers:" in result.output
        assert "TestServer" in result.output

    def test_validate_invalid_file(self, runner: CliRunner, tmp_path: Path):
        invalid_file = tmp_path / "invalid.afm.md"
        invalid_file.write_text("""---
invalid: yaml: with: colons: everywhere
---
# Role
Test
# Instructions
Test
""")

        result = runner.invoke(cli, ["validate", str(invalid_file)])
        assert result.exit_code != 0


class TestDryRun:
    def test_dry_run_valid_file(self, runner: CliRunner, sample_agent_path: Path):
        result = runner.invoke(cli, ["run", str(sample_agent_path), "--dry-run"])
        assert result.exit_code == 0
        assert "validated successfully" in result.output.lower()
        assert "TestAgent" in result.output

    def test_dry_run_minimal_file(self, runner: CliRunner, sample_minimal_path: Path):
        result = runner.invoke(cli, ["run", str(sample_minimal_path), "--dry-run"])
        assert result.exit_code == 0
        assert "validated successfully" in result.output.lower()

    def test_dry_run_invalid_file(self, runner: CliRunner, tmp_path: Path):
        invalid_file = tmp_path / "invalid.afm.md"
        invalid_file.write_text("""---
invalid: yaml: with: colons: everywhere
---
# Role
Test
# Instructions
Test
""")

        result = runner.invoke(cli, ["run", str(invalid_file), "--dry-run"])
        assert result.exit_code != 0


class TestCreateUnifiedApp:
    def test_requires_at_least_one_interface(self, sample_minimal_path: Path):
        agent = _make_mock_agent()

        with pytest.raises(ValueError, match="At least one HTTP interface"):
            create_unified_app(agent)

    def test_creates_app_with_webchat(self, sample_agent_path: Path):
        afm = parse_afm_file(str(sample_agent_path))
        agent = _make_mock_agent()
        agent.afm = afm

        webchat = WebChatInterface()

        app = create_unified_app(agent, webchat_interface=webchat)

        assert app is not None
        assert app.title == agent.name

        # Check routes exist
        routes = [getattr(route, "path", None) for route in app.routes]
        assert "/" in routes
        assert "/health" in routes
        assert "/chat" in routes  # default webchat path

    def test_creates_app_with_webhook(self, sample_minimal_path: Path):
        agent = _make_mock_agent()

        webhook = WebhookInterface(
            subscription=Subscription(protocol="websub", hub="http://hub.example.com")
        )

        app = create_unified_app(agent, webhook_interface=webhook)

        assert app is not None

        routes = [getattr(route, "path", None) for route in app.routes]
        assert "/" in routes
        assert "/health" in routes
        assert "/webhook" in routes  # default webhook path

    def test_creates_app_with_both_interfaces(self, sample_minimal_path: Path):
        agent = _make_mock_agent()

        webchat = WebChatInterface()
        webhook = WebhookInterface(
            subscription=Subscription(protocol="websub", hub="http://hub.example.com")
        )

        app = create_unified_app(
            agent, webchat_interface=webchat, webhook_interface=webhook
        )

        routes = [getattr(route, "path", None) for route in app.routes]
        assert "/chat" in routes
        assert "/webhook" in routes


class TestCLIIntegration:
    @patch("afm.cli.uvicorn")
    @patch("afm.cli.load_runner")
    def test_cli_starts_http_server_for_webchat(
        self,
        mock_load_runner: MagicMock,
        mock_uvicorn: MagicMock,
        runner: CliRunner,
        sample_agent_path: Path,
    ):
        # Setup mocks
        mock_agent = _make_mock_agent()
        mock_runner_cls = MagicMock(return_value=mock_agent)
        mock_load_runner.return_value = mock_runner_cls

        runner.invoke(cli, ["run", str(sample_agent_path), "--port", "9000"])

        # Should have called uvicorn.run
        assert mock_uvicorn.run.called or mock_uvicorn.Config.called

    def test_verbose_flag(self, runner: CliRunner, sample_agent_path: Path):
        result = runner.invoke(
            cli, ["run", str(sample_agent_path), "--dry-run", "--verbose"]
        )
        assert result.exit_code == 0


class TestFrameworkCommand:
    @patch("afm.cli.discover_runners")
    def test_framework_list_shows_backends(
        self, mock_discover: MagicMock, runner: CliRunner
    ):
        mock_ep = MagicMock()
        mock_ep.value = "afm_langchain.backend:LangChainRunner"
        mock_discover.return_value = {"langchain": mock_ep}

        result = runner.invoke(cli, ["framework", "list"])
        assert result.exit_code == 0
        assert "langchain" in result.output
        assert "afm_langchain.backend:LangChainRunner" in result.output

    @patch("afm.cli.discover_runners")
    def test_framework_list_no_backends(
        self, mock_discover: MagicMock, runner: CliRunner
    ):
        mock_discover.return_value = {}

        result = runner.invoke(cli, ["framework", "list"])
        assert result.exit_code == 0
        assert "No runner backends found" in result.output


class TestEdgeCases:
    def test_invalid_port(self, runner: CliRunner, sample_agent_path: Path):
        result = runner.invoke(
            cli, ["run", str(sample_agent_path), "--port", "invalid"]
        )
        assert result.exit_code != 0

    def test_file_with_parse_error(self, runner: CliRunner, tmp_path: Path):
        bad_file = tmp_path / "bad.afm.md"
        bad_file.write_text(
            """---
invalid: yaml: content: here
---
# Role
Test
# Instructions
Test
"""
        )
        result = runner.invoke(cli, ["run", str(bad_file), "--dry-run"])
        assert result.exit_code != 0


class TestUnifiedAppLifespan:
    @pytest.mark.asyncio
    async def test_lifespan_cancels_subscription_task_on_shutdown(
        self, sample_agent_path: Path
    ):
        import asyncio
        from asgi_lifespan import LifespanManager

        agent = _make_mock_agent()
        agent.connect = AsyncMock()
        agent.disconnect = AsyncMock()

        webhook = WebhookInterface(
            subscription=Subscription(
                protocol="websub",
                hub="http://hub.example.com",
                topic="http://topic.example.com",
            )
        )

        app = create_unified_app(agent, webhook_interface=webhook)

        # Create an async function that blocks indefinitely (simulating a long retry sleep)
        async def blocking_subscribe(*args, **kwargs) -> None:
            await asyncio.sleep(3600)

        # Patch subscribe_with_retry to avoid real connections
        with patch("afm.cli.subscribe_with_retry", blocking_subscribe):
            # Use LifespanManager to properly manage the async lifespan
            async with LifespanManager(app):
                task = app.state.subscription_task
                assert not task.done()
                # Let it start
                await asyncio.sleep(0.01)

            # After exiting the context, task should be cancelled
            assert task.done()
            assert task.cancelled()
