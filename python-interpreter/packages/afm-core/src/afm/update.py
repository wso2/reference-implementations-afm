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

"""Asynchronous background update checker for the AFM CLI.

This module implements the "Async Discovery + Notify on Next Run" pattern:
1. On each CLI invocation, check a local state file (24h TTL).
2. If due, spawn a detached background process to query PyPI.
3. On the next invocation, show a notification if a newer version exists.

The notification is only shown in interactive terminals (TTY) and can be
disabled via the AFM_NO_UPDATE_CHECK=1 environment variable.

Three installation scenarios are handled:

* **afm-cli installed**: Check ``afm-cli`` on PyPI and suggest the
  appropriate package-manager upgrade command (pipx / uv / pip).
* **afm-core only **: Check ``afm-core`` on PyPI and
  suggest the appropriate upgrade command for ``afm-core``.
* **Docker / container** (detected via ``AFM_RUNTIME=docker``): Check
  ``afm-core`` on PyPI but show only a "version available" notice without
  an upgrade command, since image updates are handled externally.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

logger = logging.getLogger(__name__)

# How often to check for updates (seconds) — 24 hours
CHECK_INTERVAL = 86400


def _detect_package() -> str:
    """Return the PyPI package name that should be used for update checks."""
    try:
        from importlib.metadata import version

        version("afm-cli")
        return "afm-cli"
    except Exception:
        return "afm-core"


def _is_docker() -> bool:
    """Return True when running inside a Docker / container environment."""
    return os.environ.get("AFM_RUNTIME", "").strip().lower() == "docker"


def _get_installed_version() -> str | None:
    """Get the installed version of the relevant AFM package."""
    try:
        from importlib.metadata import version

        package = _detect_package()
        return version(package)
    except Exception:
        return None


class UpdateState:
    """Manages persistent state for update checks.

    State is stored as JSON at <user_config_dir>/afm/update_state.json with
    a per-package structure so that ``afm-cli`` and ``afm-core`` version data
    are tracked independently:

    .. code-block:: json

        {
            "packages": {
                "afm-cli":  {"last_check": 1740000000.0, "latest_version": "0.2.1"},
                "afm-core": {"last_check": 1739900000.0, "latest_version": "0.1.8"}
            }
        }

    Args:
        package: The PyPI package name whose state should be read/written
                 (e.g. ``"afm-cli"`` or ``"afm-core"``).
    """

    _PACKAGE_DEFAULTS: dict = {"last_check": 0, "latest_version": None}

    def __init__(self, package: str) -> None:
        from platformdirs import user_config_dir

        self.package = package
        self.path = Path(user_config_dir("afm")) / "update_state.json"
        logger.debug("Update state file path: %s", self.path)
        self._root = self._load_root()
        self.data: dict = self._root["packages"].setdefault(
            package, dict(self._PACKAGE_DEFAULTS)
        )

    def _load_root(self) -> dict:
        """Load the root state dict from disk, returning an empty root on any problem."""
        try:
            if self.path.exists():
                with open(self.path) as f:
                    data = json.load(f)
                if (
                    isinstance(data, dict)
                    and "packages" in data
                    and isinstance(data["packages"], dict)
                ):
                    logger.debug("Loaded update state: %s", data)
                    return data
                else:
                    logger.debug(
                        "Update state file has unrecognised format, discarding: %s",
                        data,
                    )
            else:
                logger.debug("No update state file found at %s", self.path)
        except (json.JSONDecodeError, OSError, ValueError) as exc:
            logger.debug("Failed to load update state: %s", exc)
        return {"packages": {}}

    def save(self) -> None:
        """Persist current state to disk."""
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(self.path, "w") as f:
                json.dump(self._root, f)
            logger.debug("Saved update state to %s: %s", self.path, self._root)
        except OSError as exc:
            logger.debug("Failed to save update state: %s", exc)

    @property
    def is_check_due(self) -> bool:
        """True if the TTL has expired and a new check should run."""
        last = self.data.get("last_check", 0)
        return (time.time() - last) >= CHECK_INTERVAL


def _detect_install_command(package: str = "afm-langchain") -> str | None:
    """Return the appropriate install command for a new plugin package."""
    if _is_docker():
        return None

    host_pkg = _detect_package()  # "afm-cli" or "afm-core"
    executable = sys.executable or ""

    if "pipx" in executable:
        return f"pipx inject {host_pkg} {package}"
    elif "uv" in executable:
        return f"uv tool install --with {package} {host_pkg}"
    else:
        return f"pip install {package}"


def _detect_upgrade_command(package: str | None = None) -> str | None:
    """Return the appropriate upgrade command string, or None in containers."""
    if _is_docker():
        return None

    if package is None:
        package = _detect_package()

    executable = sys.executable or ""

    if "pipx" in executable:
        return f"pipx upgrade {package}"
    elif "uv" in executable:
        return f"uv tool upgrade {package}"
    else:
        return f"pip install -U {package}"


def maybe_check_for_updates() -> None:
    """Spawn a background process to check PyPI if the TTL has expired.

    This function is designed to be called early in the CLI lifecycle.
    It adds negligible overhead (microseconds) to the main command.
    """
    # Opt-out via environment variable
    if os.environ.get("AFM_NO_UPDATE_CHECK", "").strip() == "1":
        logger.debug("Update check disabled via AFM_NO_UPDATE_CHECK")
        return

    try:
        state = UpdateState(_detect_package())
        if not state.is_check_due:
            logger.debug(
                "Update check not due yet (last: %.0f)", state.data.get("last_check", 0)
            )
            return

        # Spawn detached background process
        cmd = [sys.executable, "-m", "afm.update"]
        logger.debug("Spawning background update check: %s", cmd)

        kwargs: dict = {
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "stdin": subprocess.DEVNULL,
        }

        # Platform-specific flags for silent backgrounding
        if sys.platform == "win32":
            kwargs["creationflags"] = 0x00000008  # DETACHED_PROCESS
        else:
            kwargs["close_fds"] = True
            kwargs["start_new_session"] = True

        subprocess.Popen(cmd, **kwargs)  # noqa: S603
    except Exception as exc:
        logger.debug("Failed to spawn update check: %s", exc)


def get_update_notification() -> str | None:
    """Return a plain-text update notification string, or None if no update."""

    if os.environ.get("AFM_NO_UPDATE_CHECK", "").strip() == "1":
        logger.debug("Update notification disabled via AFM_NO_UPDATE_CHECK")
        return None

    try:
        from packaging.version import Version

        pkg = _detect_package()
        state = UpdateState(pkg)
        latest = state.data.get("latest_version")
        if not latest:
            logger.debug("No latest version in state, skipping toast")
            return None

        current = _get_installed_version()
        if not current:
            logger.debug("Could not determine installed version")
            return None

        try:
            if Version(latest) <= Version(current):
                logger.debug("Already up to date: %s >= %s", current, latest)
                return None
        except Exception:
            return None

        upgrade_cmd = _detect_upgrade_command(pkg)
        if upgrade_cmd is None:
            # Docker / container: no package-manager command to suggest
            msg = f"Update available: {current} \u2192 {latest}."
        else:
            msg = (
                f"Update available: {current} \u2192 {latest}. "
                f"Run '{upgrade_cmd}' to update."
            )
        logger.debug("Returning toast notification: %s", msg)
        return msg
    except Exception as exc:
        logger.debug("Error in get_update_notification: %s", exc)
        return None


def notify_if_update_available() -> None:
    """Show a notification if a newer version is available."""
    # Opt-out via environment variable
    if os.environ.get("AFM_NO_UPDATE_CHECK", "").strip() == "1":
        logger.debug("Update notification disabled via AFM_NO_UPDATE_CHECK")
        return

    # Only notify in interactive terminals
    try:
        if not sys.stderr.isatty():
            logger.debug("stderr is not a TTY, skipping notification")
            return
    except Exception:
        return

    try:
        from packaging.version import Version

        pkg = _detect_package()
        state = UpdateState(pkg)
        latest = state.data.get("latest_version")
        if not latest:
            logger.debug("No latest version in state, skipping notification")
            return

        current = _get_installed_version()
        if not current:
            logger.debug("Could not determine installed version")
            return

        # Compare versions properly (handles pre-releases, etc.)
        try:
            if Version(latest) <= Version(current):
                logger.debug("Already up to date: %s >= %s", current, latest)
                return
        except Exception:
            return

        # Print notification to stderr using Rich
        from rich.console import Console

        upgrade_cmd = _detect_upgrade_command(pkg)
        logger.debug("Showing update notification: %s -> %s", current, latest)
        console = Console(stderr=True)
        console.print(
            f"\n[yellow bold]A new version of afm is available: "
            f"{current} → {latest}[/]",
        )
        if upgrade_cmd is not None:
            console.print(
                f"[yellow]Run '[bold]{upgrade_cmd}[/bold]' to update.[/]\n",
            )
        else:
            console.print(
                "[yellow]Update your container image to get the latest version.[/]\n",
            )

    except Exception:
        pass  # Never let notification logic break the CLI


def _perform_background_check() -> None:
    """Query PyPI for the latest version and write it to the state file."""
    package = _detect_package()
    try:
        import httpx

        url = f"https://pypi.org/pypi/{package}/json"
        logger.debug("Querying PyPI: %s", url)
        response = httpx.get(
            url,
            timeout=10,
            follow_redirects=True,
        )
        if response.status_code == 200:
            latest = response.json()["info"]["version"]
            logger.debug("PyPI reports latest version: %s", latest)
            state = UpdateState(package)
            state.data["last_check"] = time.time()
            state.data["latest_version"] = latest
            state.save()
        else:
            logger.debug("PyPI returned status %s", response.status_code)
    except Exception as exc:
        logger.debug("Background check failed: %s", exc)
        # Update the last_check even on failure to avoid hammering PyPI
        try:
            state = UpdateState(package)
            state.data["last_check"] = time.time()
            state.save()
        except Exception:
            pass


if __name__ == "__main__":
    _perform_background_check()
