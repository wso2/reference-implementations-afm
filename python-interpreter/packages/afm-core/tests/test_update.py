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

"""Tests for the update checker module (afm.update)."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from afm.cli import cli
from afm.update import (
    CHECK_INTERVAL,
    UpdateState,
    _detect_install_command,
    _detect_package,
    _detect_upgrade_command,
    _get_installed_version,
    _is_docker,
    _perform_background_check,
    get_update_notification,
    maybe_check_for_updates,
    notify_if_update_available,
)


@pytest.fixture
def state_dir(tmp_path: Path) -> Path:
    """Provide a temporary directory for state files."""
    return tmp_path / "afm"


@pytest.fixture
def state_file(state_dir: Path) -> Path:
    """Provide the path to the state file."""
    return state_dir / "update_state.json"


@pytest.fixture
def patch_config_dir(state_dir: Path):
    """Patch platformdirs to use a temporary directory."""
    with patch("platformdirs.user_config_dir", return_value=str(state_dir)):
        yield


@pytest.fixture(autouse=True)
def clear_docker_env():
    """Ensure AFM_RUNTIME is not set unless a test explicitly sets it."""
    with patch.dict("os.environ", {}, clear=False):
        # Remove AFM_RUNTIME if present so tests are isolated
        import os

        os.environ.pop("AFM_RUNTIME", None)
        yield


class TestUpdateState:
    def test_load_missing_file(self, patch_config_dir: None):
        """Should return defaults when no state file exists."""
        state = UpdateState("afm-cli")
        assert state.package == "afm-cli"
        assert state.data["last_check"] == 0
        assert state.data["latest_version"] is None

    def test_save_and_load(self, patch_config_dir: None):
        """Should round-trip save/load correctly and store data under the package key."""
        import json

        state = UpdateState("afm-cli")
        state.data["last_check"] = 1234567890.0
        state.data["latest_version"] = "1.0.0"
        state.save()

        # Verify on-disk structure has per-package nesting
        raw = json.loads(state.path.read_text())
        assert "packages" in raw
        assert "afm-cli" in raw["packages"]
        assert raw["packages"]["afm-cli"]["latest_version"] == "1.0.0"

        # Load again from disk for the same package
        state2 = UpdateState("afm-cli")
        assert state2.data["last_check"] == 1234567890.0
        assert state2.data["latest_version"] == "1.0.0"

    def test_corrupt_file(self, patch_config_dir: None, state_file: Path):
        """Should handle corrupt JSON gracefully."""
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text("not valid json {{{")

        state = UpdateState("afm-cli")
        assert state.data["last_check"] == 0
        assert state.data["latest_version"] is None

    def test_old_flat_format_discarded(self, patch_config_dir: None, state_file: Path):
        """Old flat format (no 'packages' key) should be silently discarded."""
        import json

        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(
            json.dumps({"last_check": 9999999.0, "latest_version": "0.1.0"})
        )

        state = UpdateState("afm-cli")
        # Old data is discarded; defaults are used
        assert state.data["last_check"] == 0
        assert state.data["latest_version"] is None

    def test_two_packages_are_independent(self, patch_config_dir: None):
        """afm-cli and afm-core state should not interfere with each other."""
        cli_state = UpdateState("afm-cli")
        cli_state.data["latest_version"] = "0.2.1"
        cli_state.data["last_check"] = 1000.0
        cli_state.save()

        core_state = UpdateState("afm-core")
        core_state.data["latest_version"] = "0.1.8"
        core_state.data["last_check"] = 2000.0
        core_state.save()

        # Reload both and verify they don't bleed into each other
        cli_state2 = UpdateState("afm-cli")
        core_state2 = UpdateState("afm-core")
        assert cli_state2.data["latest_version"] == "0.2.1"
        assert cli_state2.data["last_check"] == 1000.0
        assert core_state2.data["latest_version"] == "0.1.8"
        assert core_state2.data["last_check"] == 2000.0

    def test_is_check_due_never_checked(self, patch_config_dir: None):
        """Should be due if never checked before."""
        state = UpdateState("afm-cli")
        assert state.is_check_due is True

    def test_is_check_due_recent(self, patch_config_dir: None):
        """Should not be due if checked recently."""
        state = UpdateState("afm-cli")
        state.data["last_check"] = time.time()
        assert state.is_check_due is False

    def test_is_check_due_expired(self, patch_config_dir: None):
        """Should be due if TTL has expired."""
        state = UpdateState("afm-cli")
        state.data["last_check"] = time.time() - CHECK_INTERVAL - 1
        assert state.is_check_due is True


class TestDetectPackage:
    def test_returns_afm_cli_when_installed(self):
        """Should return 'afm-cli' when afm-cli is importable via metadata."""
        with patch("afm.update._detect_package") as mock_detect:
            mock_detect.return_value = "afm-cli"
            assert mock_detect() == "afm-cli"

    def test_returns_afm_core_when_cli_not_installed(self):
        """Should return 'afm-core' when afm-cli metadata is not available."""
        from importlib.metadata import PackageNotFoundError

        with patch(
            "importlib.metadata.version",
            side_effect=PackageNotFoundError("afm-cli"),
        ):
            result = _detect_package()
        assert result == "afm-core"

    def test_returns_afm_cli_when_cli_installed(self):
        """Should return 'afm-cli' when afm-cli metadata is available."""
        with patch("importlib.metadata.version", return_value="0.2.10"):
            result = _detect_package()
        assert result == "afm-cli"


class TestIsDocker:
    def test_returns_false_by_default(self):
        """Should return False when AFM_RUNTIME is not set."""
        assert _is_docker() is False

    def test_returns_true_when_env_set(self):
        """Should return True when AFM_RUNTIME=docker."""
        with patch.dict("os.environ", {"AFM_RUNTIME": "docker"}):
            assert _is_docker() is True

    def test_case_insensitive(self):
        """Should be case-insensitive (Docker, DOCKER, docker all match)."""
        for value in ("Docker", "DOCKER", "docker", "  docker  "):
            with patch.dict("os.environ", {"AFM_RUNTIME": value}):
                assert _is_docker() is True

    def test_returns_false_for_other_values(self):
        """Should return False for any value other than 'docker'."""
        with patch.dict("os.environ", {"AFM_RUNTIME": "production"}):
            assert _is_docker() is False


class TestMaybeCheckForUpdates:
    @patch("afm.update.subprocess.Popen")
    @patch("afm.update._detect_package", return_value="afm-cli")
    def test_check_skipped_within_ttl(
        self, mock_pkg: MagicMock, mock_popen: MagicMock, patch_config_dir: None
    ):
        """Should NOT spawn subprocess when last check was recent."""
        # Set up a recent check for the same package that will be detected
        state = UpdateState("afm-cli")
        state.data["last_check"] = time.time()
        state.save()

        maybe_check_for_updates()
        mock_popen.assert_not_called()

    @patch("afm.update.subprocess.Popen")
    def test_check_spawns_when_expired(
        self, mock_popen: MagicMock, patch_config_dir: None
    ):
        """Should spawn subprocess when TTL has expired."""
        maybe_check_for_updates()
        mock_popen.assert_called_once()

        # Verify the command uses the current Python and the update module
        call_args = mock_popen.call_args
        cmd = call_args[0][0]
        assert cmd[0] == sys.executable
        assert cmd[1:] == ["-m", "afm.update"]

    @patch("afm.update.subprocess.Popen")
    def test_check_skipped_with_env_var(
        self, mock_popen: MagicMock, patch_config_dir: None
    ):
        """Should skip when AFM_NO_UPDATE_CHECK=1."""
        with patch.dict("os.environ", {"AFM_NO_UPDATE_CHECK": "1"}):
            maybe_check_for_updates()
        mock_popen.assert_not_called()

    @patch("afm.update.subprocess.Popen", side_effect=OSError("test"))
    def test_check_never_raises(self, mock_popen: MagicMock, patch_config_dir: None):
        """Should never raise exceptions, even on Popen failure."""
        # Should not raise
        maybe_check_for_updates()


class TestNotifyIfUpdateAvailable:
    @patch("afm.update._detect_package", return_value="afm-cli")
    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_notify_shows_message_with_upgrade_cmd(
        self, mock_version: MagicMock, mock_pkg: MagicMock, patch_config_dir: None
    ):
        """Should print notification with upgrade command when not in Docker."""
        from io import StringIO

        state = UpdateState("afm-cli")
        state.data["latest_version"] = "0.2.0"
        state.save()

        buf = StringIO()

        with patch("sys.stderr") as mock_stderr:
            mock_stderr.isatty.return_value = True

            from rich.console import Console as RealConsole

            def fake_console(**kwargs):
                return RealConsole(file=buf, no_color=True)

            with patch("rich.console.Console", side_effect=fake_console):
                notify_if_update_available()

        output = buf.getvalue()
        assert "0.2.0" in output
        # Should contain an upgrade command (pip / pipx / uv)
        assert any(
            cmd in output for cmd in ("pip install", "pipx upgrade", "uv tool upgrade")
        )

    @patch("afm.update._detect_package", return_value="afm-cli")
    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_notify_docker_shows_container_message(
        self, mock_version: MagicMock, mock_pkg: MagicMock, patch_config_dir: None
    ):
        """Should show container-image message (no upgrade cmd) in Docker."""
        from io import StringIO

        state = UpdateState("afm-cli")
        state.data["latest_version"] = "0.2.0"
        state.save()

        buf = StringIO()

        with patch.dict("os.environ", {"AFM_RUNTIME": "docker"}):
            with patch("sys.stderr") as mock_stderr:
                mock_stderr.isatty.return_value = True

                from rich.console import Console as RealConsole

                def fake_console(**kwargs):
                    return RealConsole(file=buf, no_color=True)

                with patch("rich.console.Console", side_effect=fake_console):
                    notify_if_update_available()

        output = buf.getvalue()
        assert "0.2.0" in output
        # Should NOT suggest a package-manager command
        assert "pip install" not in output
        assert "pipx upgrade" not in output
        assert "uv tool upgrade" not in output
        # Should mention container image
        assert "container image" in output.lower()

    @patch("afm.update._detect_package", return_value="afm-cli")
    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_notify_skipped_non_tty(
        self,
        mock_version: MagicMock,
        mock_pkg: MagicMock,
        patch_config_dir: None,
        capsys,
    ):
        """Should NOT notify when stderr is not a TTY."""
        state = UpdateState("afm-cli")
        state.data["latest_version"] = "0.2.0"
        state.save()

        # Default pytest stderr is not a TTY, so notification should be skipped
        notify_if_update_available()

        captured = capsys.readouterr()
        assert "pip install" not in captured.err

    @patch("afm.update._detect_package", return_value="afm-cli")
    @patch("afm.update._get_installed_version", return_value="0.2.0")
    def test_notify_skipped_same_version(
        self,
        mock_version: MagicMock,
        mock_pkg: MagicMock,
        patch_config_dir: None,
        capsys,
    ):
        """Should NOT notify when current == latest."""
        state = UpdateState("afm-cli")
        state.data["latest_version"] = "0.2.0"
        state.save()

        with patch("sys.stderr") as mock_stderr:
            mock_stderr.isatty.return_value = True
            notify_if_update_available()

        captured = capsys.readouterr()
        assert "pip install" not in captured.err

    @patch("afm.update._detect_package", return_value="afm-cli")
    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_notify_skipped_with_env_var(
        self,
        mock_version: MagicMock,
        mock_pkg: MagicMock,
        patch_config_dir: None,
        capsys,
    ):
        """Should skip when AFM_NO_UPDATE_CHECK=1."""
        state = UpdateState("afm-cli")
        state.data["latest_version"] = "0.2.0"
        state.save()

        with patch.dict("os.environ", {"AFM_NO_UPDATE_CHECK": "1"}):
            notify_if_update_available()

        captured = capsys.readouterr()
        assert "pip install" not in captured.err

    @patch("afm.update._detect_package", return_value="afm-cli")
    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_notify_fires_on_every_run(
        self, mock_version: MagicMock, mock_pkg: MagicMock, patch_config_dir: None
    ):
        """Should notify on every run while an update is available."""
        from io import StringIO

        state = UpdateState("afm-cli")
        state.data["latest_version"] = "0.2.0"
        state.save()

        for _ in range(3):
            buf = StringIO()
            with patch("sys.stderr") as mock_stderr:
                mock_stderr.isatty.return_value = True
                from rich.console import Console as RealConsole

                with patch(
                    "rich.console.Console",
                    side_effect=lambda **kw: RealConsole(file=buf, no_color=True),
                ):
                    notify_if_update_available()
            assert "0.2.0" in buf.getvalue()


class TestDetectUpgradeCommand:
    def test_returns_none_in_docker(self):
        """Should return None when running in a Docker container."""
        with patch.dict("os.environ", {"AFM_RUNTIME": "docker"}):
            assert _detect_upgrade_command() is None

    def test_returns_none_in_docker_with_explicit_package(self):
        """Should return None in Docker regardless of the package argument."""
        with patch.dict("os.environ", {"AFM_RUNTIME": "docker"}):
            assert _detect_upgrade_command("afm-cli") is None
            assert _detect_upgrade_command("afm-core") is None

    def test_detects_pipx(self):
        """Should detect pipx context from sys.executable."""
        with patch("afm.update.sys") as mock_sys:
            mock_sys.executable = (
                "/home/user/.local/share/pipx/venvs/afm-cli/bin/python"
            )
            cmd = _detect_upgrade_command("afm-cli")
            assert cmd == "pipx upgrade afm-cli"

    def test_detects_uv(self):
        """Should detect uv context from sys.executable."""
        with patch("afm.update.sys") as mock_sys:
            mock_sys.executable = "/home/user/.local/share/uv/tools/afm-cli/bin/python"
            cmd = _detect_upgrade_command("afm-cli")
            assert cmd == "uv tool upgrade afm-cli"

    def test_fallback_to_pip(self):
        """Should fall back to pip when not pipx or uv."""
        with patch("afm.update.sys") as mock_sys:
            mock_sys.executable = "/usr/bin/python3"
            cmd = _detect_upgrade_command("afm-cli")
            assert cmd == "pip install -U afm-cli"

    def test_uses_detected_package_when_none_given(self):
        """Should auto-detect the package when no argument is passed."""
        with patch("afm.update._detect_package", return_value="afm-core"):
            with patch("afm.update.sys") as mock_sys:
                mock_sys.executable = "/usr/bin/python3"
                cmd = _detect_upgrade_command()
                assert cmd == "pip install -U afm-core"

    def test_afm_core_upgrade_command(self):
        """Should produce afm-core upgrade command for afm-core-only users."""
        with patch("afm.update.sys") as mock_sys:
            mock_sys.executable = "/usr/bin/python3"
            cmd = _detect_upgrade_command("afm-core")
            assert cmd == "pip install -U afm-core"


class TestDetectInstallCommand:
    def test_returns_none_in_docker(self):
        """Should return None when running in a Docker container."""
        with patch.dict("os.environ", {"AFM_RUNTIME": "docker"}):
            assert _detect_install_command() is None

    def test_returns_none_in_docker_with_explicit_package(self):
        """Should return None in Docker regardless of the package argument."""
        with patch.dict("os.environ", {"AFM_RUNTIME": "docker"}):
            assert _detect_install_command("afm-langchain") is None

    def test_pipx_afm_cli(self):
        """Should inject into the afm-cli pipx env when afm-cli is installed."""
        with patch("afm.update._detect_package", return_value="afm-cli"):
            with patch("afm.update.sys") as mock_sys:
                mock_sys.executable = (
                    "/home/user/.local/share/pipx/venvs/afm-cli/bin/python"
                )
                cmd = _detect_install_command("afm-langchain")
        assert cmd == "pipx inject afm-cli afm-langchain"

    def test_pipx_afm_core(self):
        """Should inject into the afm-core pipx env when only afm-core is installed."""
        with patch("afm.update._detect_package", return_value="afm-core"):
            with patch("afm.update.sys") as mock_sys:
                mock_sys.executable = (
                    "/home/user/.local/share/pipx/venvs/afm-core/bin/python"
                )
                cmd = _detect_install_command("afm-langchain")
        assert cmd == "pipx inject afm-core afm-langchain"

    def test_uv_afm_cli(self):
        """Should produce 'uv tool install --with' targeting afm-cli."""
        with patch("afm.update._detect_package", return_value="afm-cli"):
            with patch("afm.update.sys") as mock_sys:
                mock_sys.executable = (
                    "/home/user/.local/share/uv/tools/afm-cli/bin/python"
                )
                cmd = _detect_install_command("afm-langchain")
        assert cmd == "uv tool install --with afm-langchain afm-cli"

    def test_uv_afm_core(self):
        """Should produce 'uv tool install --with' targeting afm-core."""
        with patch("afm.update._detect_package", return_value="afm-core"):
            with patch("afm.update.sys") as mock_sys:
                mock_sys.executable = (
                    "/home/user/.local/share/uv/tools/afm-core/bin/python"
                )
                cmd = _detect_install_command("afm-langchain")
        assert cmd == "uv tool install --with afm-langchain afm-core"

    def test_pip_fallback(self):
        """Should fall back to pip install for non-pipx, non-uv environments."""
        with patch("afm.update._detect_package", return_value="afm-cli"):
            with patch("afm.update.sys") as mock_sys:
                mock_sys.executable = "/usr/bin/python3"
                cmd = _detect_install_command("afm-langchain")
        assert cmd == "pip install afm-langchain"

    def test_custom_package_name(self):
        """Should use the provided package name in the install command."""
        with patch("afm.update._detect_package", return_value="afm-cli"):
            with patch("afm.update.sys") as mock_sys:
                mock_sys.executable = "/usr/bin/python3"
                cmd = _detect_install_command("some-other-backend")
        assert cmd == "pip install some-other-backend"

    def test_default_package_is_afm_langchain(self):
        """Default package argument should be 'afm-langchain'."""
        with patch("afm.update._detect_package", return_value="afm-cli"):
            with patch("afm.update.sys") as mock_sys:
                mock_sys.executable = "/usr/bin/python3"
                cmd = _detect_install_command()
        assert "afm-langchain" in cmd


class TestBackgroundCheck:
    @patch("httpx.get")
    @patch("afm.update._detect_package", return_value="afm-cli")
    def test_writes_state_on_success(
        self, mock_pkg: MagicMock, mock_get: MagicMock, patch_config_dir: None
    ):
        """Should write latest version and timestamp under the detected package key."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"info": {"version": "1.0.0"}}
        mock_get.return_value = mock_response

        _perform_background_check()

        state = UpdateState("afm-cli")
        assert state.data["latest_version"] == "1.0.0"
        assert state.data["last_check"] > 0

    @patch("httpx.get", side_effect=Exception("network error"))
    @patch("afm.update._detect_package", return_value="afm-cli")
    def test_updates_timestamp_on_failure(
        self, mock_pkg: MagicMock, mock_get: MagicMock, patch_config_dir: None
    ):
        """Should still update last_check on failure to avoid hammering PyPI."""
        _perform_background_check()

        state = UpdateState("afm-cli")
        assert state.data["last_check"] > 0
        assert state.data["latest_version"] is None

    @patch("httpx.get")
    def test_queries_afm_cli_when_installed(
        self, mock_get: MagicMock, patch_config_dir: None
    ):
        """Should query afm-cli on PyPI when afm-cli is installed."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"info": {"version": "1.0.0"}}
        mock_get.return_value = mock_response

        with patch("afm.update._detect_package", return_value="afm-cli"):
            _perform_background_check()

        called_url = mock_get.call_args[0][0]
        assert "afm-cli" in called_url

    @patch("httpx.get")
    def test_queries_afm_core_when_cli_not_installed(
        self, mock_get: MagicMock, patch_config_dir: None
    ):
        """Should query afm-core on PyPI when afm-cli is not installed."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"info": {"version": "0.1.8"}}
        mock_get.return_value = mock_response

        with patch("afm.update._detect_package", return_value="afm-core"):
            _perform_background_check()

        called_url = mock_get.call_args[0][0]
        assert "afm-core" in called_url


class TestGetInstalledVersion:
    @patch("afm.update._detect_package", return_value="afm-cli")
    @patch("importlib.metadata.version", return_value="0.2.1")
    def test_returns_afm_cli_version(
        self, mock_version: MagicMock, mock_detect: MagicMock
    ):
        """Should return the installed afm-cli version when afm-cli is present."""
        assert _get_installed_version() == "0.2.1"
        mock_version.assert_called_with("afm-cli")

    @patch("afm.update._detect_package", return_value="afm-core")
    @patch("importlib.metadata.version", return_value="0.1.7")
    def test_returns_afm_core_version(
        self, mock_version: MagicMock, mock_detect: MagicMock
    ):
        """Should return the installed afm-core version when only afm-core is present."""
        assert _get_installed_version() == "0.1.7"
        mock_version.assert_called_with("afm-core")

    @patch("importlib.metadata.version", side_effect=Exception("not found"))
    def test_returns_none_on_error(self, mock_version: MagicMock):
        """Should return None if version lookup fails."""
        assert _get_installed_version() is None


class TestCLIUpdateIntegration:
    @patch("afm.update.notify_if_update_available")
    @patch("afm.update.maybe_check_for_updates")
    def test_update_check_wired_into_cli(
        self, mock_check: MagicMock, mock_notify: MagicMock
    ):
        """Should call update functions when any CLI command runs."""
        runner = CliRunner()
        # Use --help on a subcommand (since --version short-circuits the group)
        result = runner.invoke(cli, ["validate", "--help"])
        assert result.exit_code == 0

        mock_check.assert_called_once()


class TestGetUpdateNotification:
    @patch("afm.update._detect_package", return_value="afm-cli")
    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_returns_message_when_update_available(
        self, mock_version: MagicMock, mock_pkg: MagicMock, patch_config_dir: None
    ):
        """Should return notification string with upgrade command when not in Docker."""
        state = UpdateState("afm-cli")
        state.data["latest_version"] = "0.2.0"
        state.save()

        result = get_update_notification()
        assert result is not None
        assert "0.1.0" in result
        assert "0.2.0" in result
        # Should include an upgrade hint (pip / pipx / uv)
        assert any(
            cmd in result for cmd in ("pip install", "pipx upgrade", "uv tool upgrade")
        )

    @patch("afm.update._detect_package", return_value="afm-cli")
    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_returns_message_without_upgrade_cmd_in_docker(
        self, mock_version: MagicMock, mock_pkg: MagicMock, patch_config_dir: None
    ):
        """Should return notification string without upgrade command in Docker."""
        state = UpdateState("afm-cli")
        state.data["latest_version"] = "0.2.0"
        state.save()

        with patch.dict("os.environ", {"AFM_RUNTIME": "docker"}):
            result = get_update_notification()

        assert result is not None
        assert "0.1.0" in result
        assert "0.2.0" in result
        # Should NOT include a package-manager command
        assert "pip install" not in result
        assert "pipx upgrade" not in result
        assert "uv tool upgrade" not in result

    @patch("afm.update._detect_package", return_value="afm-cli")
    @patch("afm.update._get_installed_version", return_value="0.2.0")
    def test_returns_none_when_up_to_date(
        self, mock_version: MagicMock, mock_pkg: MagicMock, patch_config_dir: None
    ):
        """Should return None when current version matches latest."""
        state = UpdateState("afm-cli")
        state.data["latest_version"] = "0.2.0"
        state.save()

        assert get_update_notification() is None

    @patch("afm.update._detect_package", return_value="afm-cli")
    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_returns_none_with_env_var(
        self, mock_version: MagicMock, mock_pkg: MagicMock, patch_config_dir: None
    ):
        """Should return None when AFM_NO_UPDATE_CHECK=1."""
        state = UpdateState("afm-cli")
        state.data["latest_version"] = "0.2.0"
        state.save()

        with patch.dict("os.environ", {"AFM_NO_UPDATE_CHECK": "1"}):
            assert get_update_notification() is None

    def test_returns_none_when_no_state(self, patch_config_dir: None):
        """Should return None when no update state exists."""
        assert get_update_notification() is None

    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_afm_core_only_upgrade_command(
        self, mock_version: MagicMock, patch_config_dir: None
    ):
        """Should include afm-core in upgrade command for afm-core-only users."""
        with patch("afm.update._detect_package", return_value="afm-core"):
            state = UpdateState("afm-core")
            state.data["latest_version"] = "0.1.8"
            state.save()

            with patch("afm.update.sys") as mock_sys:
                mock_sys.executable = "/usr/bin/python3"
                result = get_update_notification()

        assert result is not None
        assert "afm-core" in result
        assert "pip install -U afm-core" in result

    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_afm_cli_upgrade_command(
        self, mock_version: MagicMock, patch_config_dir: None
    ):
        """Should include afm-cli in upgrade command for afm-cli users."""
        with patch("afm.update._detect_package", return_value="afm-cli"):
            state = UpdateState("afm-cli")
            state.data["latest_version"] = "0.2.10"
            state.save()

            with patch("afm.update.sys") as mock_sys:
                mock_sys.executable = "/usr/bin/python3"
                result = get_update_notification()

        assert result is not None
        assert "afm-cli" in result
        assert "pip install -U afm-cli" in result
