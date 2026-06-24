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

from ...models import PlatformChatMode

if TYPE_CHECKING:
    from ...models import PlatformChatInterface


class PlatformHandler(ABC):
    """Per-platform behavior for the platformchat interface.

    One handler is constructed per platformchat interface in
    ``new_platform_handler``; the handler caches per-interface state
    (signing secrets, bot tokens, HTTP clients) so it does not have to be
    re-derived on every request or poll iteration.
    """

    name: ClassVar[str]
    supported_modes: ClassVar[frozenset[PlatformChatMode]]
    config_cls: ClassVar[type[BaseModel]]

    def __init__(
        self,
        interface: PlatformChatInterface,
        *,
        verify_signatures: bool = True,
    ) -> None:
        self._interface = interface
        self._verify_signatures = verify_signatures

    @classmethod
    def validate_config_schema(cls, raw_config: Mapping[str, Any] | None) -> BaseModel:
        """Schema-only validation of ``platform_config`` without instantiating
        the handler. Safe to call at AFM-validate time."""
        return cls.config_cls.model_validate(dict(raw_config or {}))

    @abstractmethod
    def verify_raw_request(
        self,
        body: bytes,
        headers: Mapping[str, str],
    ) -> None:
        """Raise HTTPException on failure. Called before JSON parsing."""

    @abstractmethod
    def verify_parsed_payload(self, payload: Any) -> None:
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

    @classmethod
    @abstractmethod
    def get_session_id(cls, payload: Any) -> str:
        """Derive a per-conversation session identifier from the payload."""

    def create_notification_ack(self) -> Response:
        """Response body for notification-mode acknowledgement.

        Default raises: only platforms that include
        ``PlatformChatMode.NOTIFICATION`` in ``supported_modes`` need to
        override this.
        """
        raise NotImplementedError(
            f"Platform {self.name!r} does not support notification mode"
        )

    def create_request_response(self, result: str | object) -> Response:
        """Response body wrapping the agent's output in request mode.

        Default raises: only platforms that include ``PlatformChatMode.REQUEST``
        in ``supported_modes`` need to override this.
        """
        raise NotImplementedError(
            f"Platform {self.name!r} does not support request mode"
        )

    async def poll_updates(
        self, state: dict[str, Any]
    ) -> tuple[list[Any], dict[str, Any]]:
        """Fetch one batch of updates from the platform.

        Returns ``(updates, next_state)``. ``state`` is passed through
        opaquely between calls so the handler can track cursors / offsets;
        the framework persists it across iterations within a single
        process (no disk persistence in this implementation).

        Default raises: only platforms that include
        ``PlatformChatMode.POLLING`` in ``supported_modes`` need to override
        this.
        """
        raise NotImplementedError(
            f"Platform {self.name!r} does not support polling mode"
        )

    async def aclose(self) -> None:
        """Release per-interface resources (HTTP clients, etc.). Default no-op."""
