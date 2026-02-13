# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

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
    PYPI_PACKAGE,
    UpdateState,
    _detect_upgrade_command,
    _get_installed_version,
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


class TestUpdateState:
    def test_load_missing_file(self, patch_config_dir: None):
        """Should return defaults when no state file exists."""
        state = UpdateState()
        assert state.data["last_check"] == 0
        assert state.data["latest_version"] is None
        assert state.data["notified_version"] is None

    def test_save_and_load(self, patch_config_dir: None):
        """Should round-trip save/load correctly."""
        state = UpdateState()
        state.data["last_check"] = 1234567890.0
        state.data["latest_version"] = "1.0.0"
        state.data["notified_version"] = "0.9.0"
        state.save()

        # Load again from disk
        state2 = UpdateState()
        assert state2.data["last_check"] == 1234567890.0
        assert state2.data["latest_version"] == "1.0.0"
        assert state2.data["notified_version"] == "0.9.0"

    def test_corrupt_file(self, patch_config_dir: None, state_file: Path):
        """Should handle corrupt JSON gracefully."""
        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text("not valid json {{{")

        state = UpdateState()
        assert state.data["last_check"] == 0
        assert state.data["latest_version"] is None

    def test_is_check_due_never_checked(self, patch_config_dir: None):
        """Should be due if never checked before."""
        state = UpdateState()
        assert state.is_check_due is True

    def test_is_check_due_recent(self, patch_config_dir: None):
        """Should not be due if checked recently."""
        state = UpdateState()
        state.data["last_check"] = time.time()
        assert state.is_check_due is False

    def test_is_check_due_expired(self, patch_config_dir: None):
        """Should be due if TTL has expired."""
        state = UpdateState()
        state.data["last_check"] = time.time() - CHECK_INTERVAL - 1
        assert state.is_check_due is True


class TestMaybeCheckForUpdates:
    @patch("afm.update.subprocess.Popen")
    def test_check_skipped_within_ttl(
        self, mock_popen: MagicMock, patch_config_dir: None
    ):
        """Should NOT spawn subprocess when last check was recent."""
        # Set up a recent check
        state = UpdateState()
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
    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_notify_shows_message(
        self, mock_version: MagicMock, patch_config_dir: None
    ):
        """Should print notification when update is available and stderr is TTY."""
        from io import StringIO

        state = UpdateState()
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
        assert "afm-cli" in output

    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_notify_skipped_non_tty(
        self, mock_version: MagicMock, patch_config_dir: None, capsys
    ):
        """Should NOT notify when stderr is not a TTY."""
        state = UpdateState()
        state.data["latest_version"] = "0.2.0"
        state.save()

        # Default pytest stderr is not a TTY, so notification should be skipped
        notify_if_update_available()

        captured = capsys.readouterr()
        assert "pip install" not in captured.err

    @patch("afm.update._get_installed_version", return_value="0.2.0")
    def test_notify_skipped_same_version(
        self, mock_version: MagicMock, patch_config_dir: None, capsys
    ):
        """Should NOT notify when current == latest."""
        state = UpdateState()
        state.data["latest_version"] = "0.2.0"
        state.save()

        with patch("sys.stderr") as mock_stderr:
            mock_stderr.isatty.return_value = True
            notify_if_update_available()

        captured = capsys.readouterr()
        assert "pip install" not in captured.err

    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_notify_skipped_already_notified(
        self, mock_version: MagicMock, patch_config_dir: None, capsys
    ):
        """Should NOT re-notify for the same version."""
        state = UpdateState()
        state.data["latest_version"] = "0.2.0"
        state.data["notified_version"] = "0.2.0"
        state.save()

        with patch("sys.stderr") as mock_stderr:
            mock_stderr.isatty.return_value = True
            notify_if_update_available()

        captured = capsys.readouterr()
        assert "pip install" not in captured.err

    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_notify_skipped_with_env_var(
        self, mock_version: MagicMock, patch_config_dir: None, capsys
    ):
        """Should skip when AFM_NO_UPDATE_CHECK=1."""
        state = UpdateState()
        state.data["latest_version"] = "0.2.0"
        state.save()

        with patch.dict("os.environ", {"AFM_NO_UPDATE_CHECK": "1"}):
            notify_if_update_available()

        captured = capsys.readouterr()
        assert "pip install" not in captured.err


class TestDetectUpgradeCommand:
    def test_detects_pipx(self):
        """Should detect pipx context from sys.executable."""
        with patch("afm.update.sys") as mock_sys:
            mock_sys.executable = (
                "/home/user/.local/share/pipx/venvs/afm-cli/bin/python"
            )
            cmd = _detect_upgrade_command()
            assert cmd == f"pipx upgrade {PYPI_PACKAGE}"

    def test_detects_uv(self):
        """Should detect uv context from sys.executable."""
        with patch("afm.update.sys") as mock_sys:
            mock_sys.executable = "/home/user/.local/share/uv/tools/afm-cli/bin/python"
            cmd = _detect_upgrade_command()
            assert cmd == f"uv tool upgrade {PYPI_PACKAGE}"

    def test_fallback_to_pip(self):
        """Should fall back to pip when not pipx or uv."""
        with patch("afm.update.sys") as mock_sys:
            mock_sys.executable = "/usr/bin/python3"
            cmd = _detect_upgrade_command()
            assert cmd == f"pip install -U {PYPI_PACKAGE}"


class TestBackgroundCheck:
    @patch("httpx.get")
    def test_writes_state_on_success(self, mock_get: MagicMock, patch_config_dir: None):
        """Should write latest version and timestamp to state file."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"info": {"version": "1.0.0"}}
        mock_get.return_value = mock_response

        _perform_background_check()

        state = UpdateState()
        assert state.data["latest_version"] == "1.0.0"
        assert state.data["last_check"] > 0

    @patch("httpx.get", side_effect=Exception("network error"))
    def test_updates_timestamp_on_failure(
        self, mock_get: MagicMock, patch_config_dir: None
    ):
        """Should still update last_check on failure to avoid hammering PyPI."""
        _perform_background_check()

        state = UpdateState()
        assert state.data["last_check"] > 0
        assert state.data["latest_version"] is None


class TestGetInstalledVersion:
    @patch("importlib.metadata.version", return_value="0.2.1")
    def test_returns_version(self, mock_version: MagicMock):
        """Should return the installed version."""
        assert _get_installed_version() == "0.2.1"

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
    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_returns_message_when_update_available(
        self, mock_version: MagicMock, patch_config_dir: None
    ):
        """Should return notification string when update is available."""
        state = UpdateState()
        state.data["latest_version"] = "0.2.0"
        state.save()

        result = get_update_notification()
        assert result is not None
        assert "0.1.0" in result
        assert "0.2.0" in result
        assert "afm-cli" in result

    @patch("afm.update._get_installed_version", return_value="0.2.0")
    def test_returns_none_when_up_to_date(
        self, mock_version: MagicMock, patch_config_dir: None
    ):
        """Should return None when current version matches latest."""
        state = UpdateState()
        state.data["latest_version"] = "0.2.0"
        state.save()

        assert get_update_notification() is None

    @patch("afm.update._get_installed_version", return_value="0.1.0")
    def test_returns_none_with_env_var(
        self, mock_version: MagicMock, patch_config_dir: None
    ):
        """Should return None when AFM_NO_UPDATE_CHECK=1."""
        state = UpdateState()
        state.data["latest_version"] = "0.2.0"
        state.save()

        with patch.dict("os.environ", {"AFM_NO_UPDATE_CHECK": "1"}):
            assert get_update_notification() is None

    def test_returns_none_when_no_state(self, patch_config_dir: None):
        """Should return None when no update state exists."""
        assert get_update_notification() is None
