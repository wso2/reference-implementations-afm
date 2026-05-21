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

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, ClassVar, Mapping

from fastapi.responses import Response
from pydantic import BaseModel

if TYPE_CHECKING:
    from ...models import PlatformChatInterface


class PlatformHandler(ABC):
    """Per-platform behavior for the platformchat interface.

    Implementations live in sibling modules (slack.py, gchat.py, ...) and
    are registered in __init__.py's _HANDLERS map keyed by `name`.
    """

    name: ClassVar[str]

    @abstractmethod
    def parse_config(self, raw_config: Mapping[str, Any] | None) -> BaseModel:
        """Validate and parse platform_config into a typed model.

        Catches typos, wrong types, and unknown fields at AFM-validate time.
        Returns the typed config (caller may discard it).
        """

    def validate_runtime_config(
        self,
        interface: PlatformChatInterface,
        *,
        verify_signatures: bool,
    ) -> None:
        """Optional runtime-only checks (e.g. signature secret required when verifying).

        Default: no-op. Override per platform if needed.
        """

    @abstractmethod
    def verify_raw_request(
        self,
        body: bytes,
        headers: Mapping[str, str],
        interface: PlatformChatInterface,
    ) -> None:
        """Raise HTTPException on failure. Called before JSON parsing."""

    @abstractmethod
    def verify_parsed_payload(
        self,
        payload: Any,
        interface: PlatformChatInterface,
    ) -> None:
        """Raise HTTPException on failure. Called after JSON parsing."""

    def handle_pre_dispatch(self, payload: Any) -> Response | None:
        """Short-circuit response before should_ignore (e.g. Slack url_verification).

        Default: no-op. Override per platform if needed.
        """
        return None

    @abstractmethod
    def should_ignore(self, payload: Any) -> bool:
        """Return True to ack without invoking the agent."""

    @abstractmethod
    def create_ignored_response(self) -> Response:
        """Response body to send when an event is ignored."""

    @abstractmethod
    def get_session_id(self, payload: Any) -> str:
        """Derive a per-conversation session identifier from the payload."""

    @abstractmethod
    def create_notification_ack(self) -> Response:
        """Response body for notification-mode acknowledgement."""

    @abstractmethod
    def create_request_response(self, result: str | object) -> Response:
        """Response body wrapping the agent's output in request mode."""
