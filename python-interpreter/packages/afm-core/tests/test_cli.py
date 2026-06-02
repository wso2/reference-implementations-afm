# Copyright (c) 2025, WSO2 LLC. (https://www.wso2.com).
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

import asyncio
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as meta_version
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from afm.cli import (
    _raise_unexpected_task_exceptions,
    cli,
    create_unified_app,
)
from afm.models import (
    Exposure,
    HTTPExposure,
    PlatformChatInterface,
    PlatformChatMode,
    Subscription,
    WebChatInterface,
    WebhookInterface,
)
from afm.parser import parse_afm_file
from afm.runner import AgentRunner
from click.testing import CliRunner


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


def _slack_platform_chat(path: str = "/slack") -> PlatformChatInterface:
    return PlatformChatInterface(
        type="platformchat",
        platform="slack",
        mode=PlatformChatMode.NOTIFICATION,
        platform_config={"signing_secret": "abc"},
        exposure=Exposure(http=HTTPExposure(path=path)),
    )


def _telegram_platform_chat(path: str = "/telegram") -> PlatformChatInterface:
    return PlatformChatInterface(
        type="platformchat",
        platform="telegram",
        mode=PlatformChatMode.NOTIFICATION,
        platform_config={"secret_token": "abc"},
        exposure=Exposure(http=HTTPExposure(path=path)),
    )


class TestCLIBasics:
    def test_version(self, runner: CliRunner):
        result = runner.invoke(cli, ["--version"])
        assert result.exit_code == 0
        assert meta_version("afm-core") in result.output
        try:
            assert meta_version("afm-cli") in result.output
        except PackageNotFoundError:
            assert f"afm-core {meta_version('afm-core')}" in result.output

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

    def test_expected_shutdown_task_exceptions_are_ignored(self):
        cancelled_task = MagicMock()
        cancelled_task.exception.side_effect = asyncio.CancelledError
        interrupt_task = MagicMock()
        interrupt_task.exception.return_value = KeyboardInterrupt()
        system_exit_task = MagicMock()
        system_exit_task.exception.return_value = SystemExit()

        _raise_unexpected_task_exceptions(
            [cancelled_task, interrupt_task, system_exit_task]
        )

    def test_unexpected_task_exceptions_are_raised(self):
        failed_task = MagicMock()
        failed_task.exception.return_value = RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            _raise_unexpected_task_exceptions([failed_task])


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

    def test_validate_flags_unknown_platform_chat_config_field(
        self, runner: CliRunner, tmp_path: Path
    ):
        bad_file = tmp_path / "bad.afm.md"
        bad_file.write_text(
            """---
spec_version: "0.4.0"
interfaces:
  - type: platformchat
    platform: slack
    mode: notification
    platform_config:
      signing_secrt: "abc"
    exposure:
      http:
        path: "/slack"
---

# Role
Role.

# Instructions
Instructions.
"""
        )
        result = runner.invoke(cli, ["validate", str(bad_file)])
        assert result.exit_code != 0
        assert "signing_secrt" in result.output or "Invalid" in result.output

    def test_validate_flags_unknown_platform(self, runner: CliRunner, tmp_path: Path):
        bad_file = tmp_path / "bad.afm.md"
        bad_file.write_text(
            """---
spec_version: "0.4.0"
interfaces:
  - type: platformchat
    platform: teams
    mode: notification
    platform_config: {}
    exposure:
      http:
        path: "/teams"
---

# Role
Role.

# Instructions
Instructions.
"""
        )
        result = runner.invoke(cli, ["validate", str(bad_file)])
        assert result.exit_code != 0
        assert "teams" in result.output or "not supported" in result.output

    def test_validate_accepts_polling_mode(self, runner: CliRunner, tmp_path: Path):
        afm_file = tmp_path / "agent.afm.md"
        afm_file.write_text(
            """---
spec_version: "0.4.0"
interfaces:
  - type: platformchat
    platform: telegram
    mode: polling
    polling:
      interval: 30
---

# Role
Role.

# Instructions
Instructions.
"""
        )
        result = runner.invoke(cli, ["validate", str(afm_file)])
        assert result.exit_code == 0
        assert "validated successfully" in result.output.lower()

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

    def test_dry_run_accepts_polling_mode_without_runtime_config(
        self, runner: CliRunner, tmp_path: Path
    ):
        afm_file = tmp_path / "agent.afm.md"
        afm_file.write_text(
            """---
spec_version: "0.4.0"
interfaces:
  - type: platformchat
    platform: telegram
    mode: polling
---

# Role
Role.

# Instructions
Instructions.
"""
        )
        # Dry-run is schema-only; runtime requirements like bot_token are
        # checked when the interface actually starts.
        result = runner.invoke(cli, ["run", str(afm_file), "--dry-run"])
        assert result.exit_code == 0
        assert "validated successfully" in result.output.lower()
        assert "platformchat (telegram, polling)" in result.output

    def test_dry_run_accepts_multiple_platformchat_interfaces(
        self, runner: CliRunner, tmp_path: Path
    ):
        afm_file = tmp_path / "agent.afm.md"
        afm_file.write_text(
            """---
spec_version: "0.4.0"
interfaces:
  - type: platformchat
    platform: slack
    mode: notification
    platform_config:
      signing_secret: "abc"
    exposure:
      http:
        path: "/slack"
  - type: platformchat
    platform: telegram
    mode: polling
---

# Role
Role.

# Instructions
Instructions.
"""
        )
        result = runner.invoke(cli, ["run", str(afm_file), "--dry-run"])
        assert result.exit_code == 0
        assert "platformchat (slack, notification) at /slack" in result.output
        assert "platformchat (telegram, polling)" in result.output

    def test_dry_run_rejects_duplicate_http_paths(
        self, runner: CliRunner, tmp_path: Path
    ):
        afm_file = tmp_path / "agent.afm.md"
        afm_file.write_text(
            """---
spec_version: "0.4.0"
interfaces:
  - type: webchat
    exposure:
      http:
        path: "/chat"
  - type: platformchat
    platform: slack
    mode: notification
    platform_config:
      signing_secret: "abc"
    exposure:
      http:
        path: "/chat"
---

# Role
Role.

# Instructions
Instructions.
"""
        )
        result = runner.invoke(cli, ["run", str(afm_file), "--dry-run"])
        assert result.exit_code != 0
        assert "HTTP path '/chat'" in result.output

    def test_dry_run_rejects_unknown_platform_chat_config_field(
        self, runner: CliRunner, tmp_path: Path
    ):
        bad_file = tmp_path / "bad.afm.md"
        bad_file.write_text(
            """---
spec_version: "0.4.0"
interfaces:
  - type: platformchat
    platform: slack
    mode: notification
    platform_config:
      signing_secrt: "abc"
    exposure:
      http:
        path: "/slack"
---

# Role
Role.

# Instructions
Instructions.
"""
        )
        result = runner.invoke(cli, ["run", str(bad_file), "--dry-run"])
        assert result.exit_code != 0
        assert "signing_secrt" in result.output or "Invalid" in result.output

    def test_dry_run_rejects_unknown_platform(self, runner: CliRunner, tmp_path: Path):
        bad_file = tmp_path / "bad.afm.md"
        bad_file.write_text(
            """---
spec_version: "0.4.0"
interfaces:
  - type: platformchat
    platform: teams
    mode: notification
    platform_config: {}
    exposure:
      http:
        path: "/teams"
---

# Role
Role.

# Instructions
Instructions.
"""
        )
        result = runner.invoke(cli, ["run", str(bad_file), "--dry-run"])
        assert result.exit_code != 0
        assert "teams" in result.output or "not supported" in result.output

    def test_dry_run_rejects_unsupported_platform_mode(
        self, runner: CliRunner, tmp_path: Path
    ):
        bad_file = tmp_path / "bad.afm.md"
        bad_file.write_text(
            """---
spec_version: "0.4.0"
interfaces:
  - type: platformchat
    platform: telegram
    mode: request
    platform_config: {}
    exposure:
      http:
        path: "/telegram"
---

# Role
Role.

# Instructions
Instructions.
"""
        )
        result = runner.invoke(cli, ["run", str(bad_file), "--dry-run"])
        assert result.exit_code != 0
        assert "telegram" in result.output
        assert "request" in result.output

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

    def test_creates_app_with_multiple_platformchat_interfaces(self) -> None:
        agent = _make_mock_agent()

        app = create_unified_app(
            agent,
            platform_chat_interface=[
                _slack_platform_chat(),
                _telegram_platform_chat(),
            ],
        )

        routes = [getattr(route, "path", None) for route in app.routes]
        assert "/slack" in routes
        assert "/telegram" in routes

        response = TestClient(app).get("/")
        assert response.status_code == 200
        interfaces = response.json()["interfaces"]
        assert interfaces["platformchat"] == "/slack"
        assert interfaces["platformchats"] == ["/slack", "/telegram"]

    def test_rejects_duplicate_http_paths(self) -> None:
        agent = _make_mock_agent()

        with pytest.raises(ValueError, match="/chat"):
            create_unified_app(
                agent,
                webchat_interface=WebChatInterface(),
                platform_chat_interface=[_slack_platform_chat(path="/chat")],
            )

    def test_rejects_polling_platformchat_routes(self) -> None:
        agent = _make_mock_agent()
        polling_interface = PlatformChatInterface(
            type="platformchat",
            platform="telegram",
            mode=PlatformChatMode.POLLING,
            platform_config={"bot_token": "123:abc"},
        )

        with pytest.raises(ValueError, match="run_polling_loop"):
            create_unified_app(agent, platform_chat_interface=[polling_interface])


class TestCLIIntegration:
    @patch("afm.cli.load_runner")
    def test_cli_run_polling_without_bot_token_fails_at_runtime(
        self,
        mock_load_runner: MagicMock,
        runner: CliRunner,
        tmp_path: Path,
    ):
        afm_file = tmp_path / "agent.afm.md"
        afm_file.write_text(
            """---
spec_version: "0.4.0"
interfaces:
  - type: platformchat
    platform: telegram
    mode: polling
---

# Role
Role.

# Instructions
Instructions.
"""
        )

        class FakeRunner:
            name = "TestAgent"
            description = None

            def __init__(self, afm):
                self.afm = afm

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

        mock_load_runner.return_value = FakeRunner

        result = runner.invoke(cli, ["run", str(afm_file)])

        assert result.exit_code != 0
        assert isinstance(result.exception, ValueError)
        assert "bot_token" in str(result.exception)

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
        """Basic smoke test: always shows 'No runner backends found'."""
        mock_discover.return_value = {}

        result = runner.invoke(cli, ["framework", "list"])
        assert result.exit_code == 0
        assert "No runner backends found" in result.output

    @patch("afm.cli.discover_runners")
    @patch("afm.update._detect_package", return_value="afm-cli")
    def test_framework_list_no_backends_uv(
        self,
        mock_pkg: MagicMock,
        mock_discover: MagicMock,
        runner: CliRunner,
    ):
        """uv installation shows 'uv tool install --with afm-langchain afm-cli'."""
        mock_discover.return_value = {}

        with patch("afm.update.sys") as mock_sys:
            mock_sys.executable = "/home/user/.local/share/uv/tools/afm-cli/bin/python"
            result = runner.invoke(cli, ["framework", "list"])

        assert result.exit_code == 0
        assert "uv tool install --with afm-langchain afm-cli" in result.output

    @patch("afm.cli.discover_runners")
    @patch("afm.update._detect_package", return_value="afm-cli")
    def test_framework_list_no_backends_pipx(
        self,
        mock_pkg: MagicMock,
        mock_discover: MagicMock,
        runner: CliRunner,
    ):
        """pipx installation shows 'pipx inject afm-cli afm-langchain'."""
        mock_discover.return_value = {}

        with patch("afm.update.sys") as mock_sys:
            mock_sys.executable = (
                "/home/user/.local/share/pipx/venvs/afm-cli/bin/python"
            )
            result = runner.invoke(cli, ["framework", "list"])

        assert result.exit_code == 0
        assert "pipx inject afm-cli afm-langchain" in result.output

    @patch("afm.cli.discover_runners")
    @patch("afm.update._detect_package", return_value="afm-core")
    def test_framework_list_no_backends_pip(
        self,
        mock_pkg: MagicMock,
        mock_discover: MagicMock,
        runner: CliRunner,
    ):
        """pip installation shows 'pip install afm-langchain'."""
        mock_discover.return_value = {}

        with patch("afm.update.sys") as mock_sys:
            mock_sys.executable = "/usr/bin/python3"
            result = runner.invoke(cli, ["framework", "list"])

        assert result.exit_code == 0
        assert "pip install afm-langchain" in result.output

    @patch("afm.cli.discover_runners")
    def test_framework_list_no_backends_docker(
        self,
        mock_discover: MagicMock,
        runner: CliRunner,
    ):
        """Docker shows container image message with no install command."""
        mock_discover.return_value = {}

        with patch.dict("os.environ", {"AFM_RUNTIME": "docker"}):
            result = runner.invoke(cli, ["framework", "list"])

        assert result.exit_code == 0
        assert "No runner backends found" in result.output
        assert "container image" in result.output.lower()
        assert "uv tool install" not in result.output
        assert "pipx inject" not in result.output
        assert "pip install" not in result.output


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


class TestValidateWithEnvVariables:
    def test_validate_with_env_variables_succeeds_without_env_set(
        self, runner: CliRunner, tmp_path: Path
    ):
        """Test that validate succeeds even when env variables are not set."""
        # Create an AFM file with unresolved environment variables
        afm_with_env_var = tmp_path / "agent_with_env.afm.md"
        afm_with_env_var.write_text(
            """---
spec_version: "0.4.0"
name: "EnvTestAgent"
model:
  provider: "openai"
  name: "gpt-4"
  authentication:
    type: "bearer"
    token: "${env:UNSET_API_TOKEN_FOR_VALIDATE_TEST}"
---

# Role
Test role

# Instructions
Test instructions
"""
        )

        # Validate should succeed without requiring env var to be set
        result = runner.invoke(cli, ["validate", str(afm_with_env_var)])
        assert result.exit_code == 0
        assert "validated successfully" in result.output.lower()
        assert "EnvTestAgent" in result.output

    def test_dry_run_with_env_variables_fails_without_env_set(
        self, runner: CliRunner, tmp_path: Path
    ):
        """Test that run --dry-run fails when env variables are not set."""
        # Create the same AFM file with unresolved environment variables
        afm_with_env_var = tmp_path / "agent_with_env.afm.md"
        afm_with_env_var.write_text(
            """---
spec_version: "0.4.0"
name: "EnvTestAgent"
model:
  provider: "openai"
  name: "gpt-4"
  authentication:
    type: "bearer"
    token: "${env:UNSET_API_TOKEN_FOR_DRYRUN_TEST}"
---

# Role
Test role

# Instructions
Test instructions
"""
        )

        # Dry-run should fail because it tries to resolve env variables
        result = runner.invoke(cli, ["run", str(afm_with_env_var), "--dry-run"])
        assert result.exit_code != 0
        assert (
            "UNSET_API_TOKEN_FOR_DRYRUN_TEST" in result.output
            or "Environment variable" in result.output
            or "variable" in result.output.lower()
        )
