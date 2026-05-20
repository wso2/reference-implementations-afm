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

from __future__ import annotations

import hmac
import logging
from typing import TYPE_CHECKING, Any, ClassVar, Mapping

from fastapi import HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict

from ._handler import PlatformHandler

if TYPE_CHECKING:
    from ...models import PlatformChatInterface

logger = logging.getLogger(__name__)

# Event types that the agent can act on.
_ACTIONABLE_EVENT_TYPES: frozenset[str] = frozenset({"MESSAGE", "ADDED_TO_SPACE"})


class GChatConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verification_token: str | None = None


def verify_gchat_request_token(
    payload: object,
    verification_token: str,
) -> bool:
    if not isinstance(payload, dict):
        return False

    token = payload.get("token")
    if not isinstance(token, str):
        return False

    return hmac.compare_digest(token, verification_token)


def get_gchat_session_id(payload: object) -> str:
    if not isinstance(payload, dict):
        return "default"

    space = payload.get("space")
    space_name = (
        _non_empty_string(space.get("name")) if isinstance(space, dict) else None
    )
    if space_name is None:
        return "gchat:unknown-space:default"

    message = payload.get("message")
    if isinstance(message, dict):
        thread = message.get("thread")
        if isinstance(thread, dict):
            thread_name = _non_empty_string(thread.get("name"))
            if thread_name:
                return f"gchat:{space_name}:{thread_name}"

    user = payload.get("user")
    if isinstance(user, dict):
        user_name = _non_empty_string(user.get("name"))
        if user_name:
            return f"gchat:{space_name}:{user_name}"

    return f"gchat:{space_name}:default"


def should_ignore_gchat_event(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False

    event_type = payload.get("type")
    if not isinstance(event_type, str) or event_type not in _ACTIONABLE_EVENT_TYPES:
        return True

    # Prevent bot loops: ignore messages from bot senders.
    message = payload.get("message")
    if isinstance(message, dict):
        sender = message.get("sender")
        if isinstance(sender, dict) and sender.get("type") == "BOT":
            return True

    return False


class GChatHandler(PlatformHandler):
    name: ClassVar[str] = "gchat"

    def parse_config(self, raw_config: Mapping[str, Any] | None) -> GChatConfig:
        return GChatConfig.model_validate(dict(raw_config or {}))

    def validate_runtime_config(
        self,
        interface: PlatformChatInterface,
        *,
        verify_signatures: bool,
    ) -> None:
        if not verify_signatures:
            return
        config = self.parse_config(interface.platform_config)
        if config.verification_token is None:
            raise ValueError(
                "GChat platform chat requires "
                "platform_config.verification_token when "
                "signature verification is enabled."
            )

    def verify_raw_request(
        self,
        body: bytes,
        headers: Mapping[str, str],
        interface: PlatformChatInterface,
    ) -> None:
        # GChat verification is on the parsed payload's `token` field.
        return

    def verify_parsed_payload(
        self,
        payload: Any,
        interface: PlatformChatInterface,
    ) -> None:
        config = self.parse_config(interface.platform_config)
        if config.verification_token is None:
            raise HTTPException(
                status_code=500,
                detail="GChat verification token is not configured",
            )
        if not verify_gchat_request_token(payload, config.verification_token):
            raise HTTPException(
                status_code=401,
                detail="Invalid GChat verification token",
            )

    def should_ignore(self, payload: Any) -> bool:
        return should_ignore_gchat_event(payload)

    def create_ignored_response(self) -> Response:
        return JSONResponse(status_code=200, content={})

    def get_session_id(self, payload: Any) -> str:
        return get_gchat_session_id(payload)

    def create_notification_ack(self) -> Response:
        return JSONResponse(status_code=202, content={"status": "accepted"})

    def create_request_response(self, result: str | object) -> Response:
        # If the result is already a dict (e.g. from output schema coercion),
        # return it directly — it should already contain the expected structure.
        if isinstance(result, dict):
            return JSONResponse(content=result)
        return JSONResponse(content={"text": result})


def _non_empty_string(value: object) -> str | None:
    return value if isinstance(value, str) and value != "" else None
