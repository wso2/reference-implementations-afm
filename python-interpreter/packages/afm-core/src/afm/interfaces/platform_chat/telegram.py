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

import hmac
import logging
from typing import TYPE_CHECKING, Any, ClassVar, Mapping

from fastapi import HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict

from ...models import PlatformChatMode
from ._handler import PlatformHandler

if TYPE_CHECKING:
    from ...models import PlatformChatInterface

logger = logging.getLogger(__name__)

# Header Telegram echoes from `setWebhook?secret_token=...` on every webhook
# delivery. Used as a shared-secret check in lieu of HMAC signing.
TELEGRAM_SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token"


class TelegramConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    secret_token: str | None = None


def verify_telegram_secret_token(
    received: str | None,
    expected: str,
) -> bool:
    if received is None:
        return False
    return hmac.compare_digest(received, expected)


def get_telegram_session_id(payload: object) -> str:
    if not isinstance(payload, dict):
        return "default"

    message = payload.get("message")
    if not isinstance(message, dict):
        return "telegram:unknown-chat:default"

    chat = message.get("chat")
    chat_id = (
        _stringify_id(chat.get("id")) if isinstance(chat, dict) else None
    ) or "unknown-chat"

    sender = message.get("from")
    user_id = _stringify_id(sender.get("id")) if isinstance(sender, dict) else None
    if user_id:
        return f"telegram:{chat_id}:{user_id}"
    return f"telegram:{chat_id}:default"


def should_ignore_telegram_update(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False

    message = payload.get("message")
    if not isinstance(message, dict):
        # No "message" field: edited_message, channel_post, callback_query,
        # etc. Not actionable by the default text-reply flow.
        return True

    sender = message.get("from")
    if isinstance(sender, dict) and sender.get("is_bot") is True:
        return True

    return False


class TelegramHandler(PlatformHandler):
    name: ClassVar[str] = "telegram"
    supported_modes: ClassVar[frozenset[PlatformChatMode]] = frozenset(
        {PlatformChatMode.NOTIFICATION}
    )

    def parse_config(self, raw_config: Mapping[str, Any] | None) -> TelegramConfig:
        return TelegramConfig.model_validate(dict(raw_config or {}))

    def validate_runtime_config(
        self,
        interface: PlatformChatInterface,
        *,
        verify_signatures: bool,
    ) -> None:
        if not verify_signatures:
            return
        config = self.parse_config(interface.platform_config)
        if config.secret_token is None:
            raise ValueError(
                "Telegram platform chat requires "
                "platform_config.secret_token when signature "
                "verification is enabled."
            )

    def verify_raw_request(
        self,
        body: bytes,
        headers: Mapping[str, str],
        interface: PlatformChatInterface,
    ) -> None:
        config = self.parse_config(interface.platform_config)
        if config.secret_token is None:
            raise HTTPException(
                status_code=500,
                detail="Telegram secret token is not configured",
            )

        received = headers.get(TELEGRAM_SECRET_TOKEN_HEADER) or headers.get(
            "X-Telegram-Bot-Api-Secret-Token"
        )
        if not verify_telegram_secret_token(received, config.secret_token):
            raise HTTPException(
                status_code=401,
                detail="Invalid Telegram secret token",
            )

    def verify_parsed_payload(
        self,
        payload: Any,
        interface: PlatformChatInterface,
    ) -> None:
        return

    def should_ignore(self, payload: Any) -> bool:
        return should_ignore_telegram_update(payload)

    def create_ignored_response(self) -> Response:
        return Response(status_code=200)

    def get_session_id(self, payload: Any) -> str:
        return get_telegram_session_id(payload)

    def create_notification_ack(self) -> Response:
        return Response(status_code=200)


def _stringify_id(value: object) -> str | None:
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str) and value != "":
        return value
    return None
