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
from typing import TYPE_CHECKING, Any, ClassVar, Mapping, cast

import httpx
from fastapi import HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, field_validator

from ...models import PlatformChatMode
from ._handler import PlatformHandler

if TYPE_CHECKING:
    from ...models import PlatformChatInterface

logger = logging.getLogger(__name__)

# Header Telegram echoes from `setWebhook?secret_token=...` on every webhook
# delivery. Used as a shared-secret check in lieu of HMAC signing.
TELEGRAM_SECRET_TOKEN_HEADER = "x-telegram-bot-api-secret-token"

TELEGRAM_API_BASE = "https://api.telegram.org"

# Telegram caps getUpdates long-poll at 50s; we add headroom for client/server
# clock drift before the HTTP read times out.
_GET_UPDATES_HTTP_TIMEOUT_PADDING = 10.0

# Telegram's documented upper bound on the getUpdates `timeout` parameter
# (https://core.telegram.org/bots/api#getupdates). Values above this are
# rejected by the API; we reject them at validate time instead.
TELEGRAM_GET_UPDATES_MAX_TIMEOUT = 50


class TelegramConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Required for polling mode (used as the bot's API credential in the
    # getUpdates URL). Optional for notification mode, which only needs
    # secret_token for inbound verification.
    bot_token: str | None = None
    secret_token: str | None = None

    @field_validator("bot_token", "secret_token", mode="before")
    @classmethod
    def _empty_or_whitespace_is_none(cls, value: object) -> object:
        """Normalize credential strings before runtime validation.

        Telegram bot tokens and webhook secret tokens never legitimately
        contain leading/trailing whitespace — both follow tight character
        sets (``<bot_id>:<hash>`` for tokens, ``[A-Za-z0-9_-]`` for secret
        tokens). A blank or whitespace-only value almost certainly means
        an unset env var (``${env:UNSET_VAR}`` → ``""``) or a templating
        mistake. Treat them as missing so the regular ``not config.X``
        checks in validate_runtime_config / verify_raw_request / poll catch
        missing credentials in one place.
        """
        if isinstance(value, str):
            stripped = value.strip()
            if not stripped:
                return None
            return stripped
        return value


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

    payload_dict = cast(dict[str, Any], payload)
    message = payload_dict.get("message")
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

    payload_dict = cast(dict[str, Any], payload)
    message = payload_dict.get("message")
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
        {PlatformChatMode.NOTIFICATION, PlatformChatMode.POLLING}
    )

    def parse_config(self, raw_config: Mapping[str, Any] | None) -> TelegramConfig:
        return TelegramConfig.model_validate(dict(raw_config or {}))

    def validate_runtime_config(
        self,
        interface: PlatformChatInterface,
        *,
        verify_signatures: bool,
    ) -> None:
        config = self.parse_config(interface.platform_config)

        if interface.mode == PlatformChatMode.POLLING:
            if not config.bot_token:
                raise ValueError(
                    "Telegram platform chat in polling mode requires a "
                    "non-empty platform_config.bot_token."
                )
            polling = interface.polling
            if (
                polling
                and polling.timeout is not None
                and polling.timeout > TELEGRAM_GET_UPDATES_MAX_TIMEOUT
            ):
                raise ValueError(
                    f"Telegram getUpdates timeout must be at most "
                    f"{TELEGRAM_GET_UPDATES_MAX_TIMEOUT} seconds; "
                    f"got {polling.timeout}."
                )
            return

        # Notification mode (request mode is rejected at schema validation).
        if verify_signatures and not config.secret_token:
            raise ValueError(
                "Telegram platform chat requires a non-empty "
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
        if not config.secret_token:
            raise HTTPException(
                status_code=500,
                detail="Telegram secret token is not configured",
            )

        received = headers.get(TELEGRAM_SECRET_TOKEN_HEADER) or headers.get(
            "X-Telegram-Bot-Api-Secret-Token"
        )
        if not verify_telegram_secret_token(received, config.secret_token):
            logger.warning(
                "Telegram webhook rejected: secret token mismatch (header_present=%s)",
                received is not None,
            )
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

    async def poll_updates(
        self,
        interface: PlatformChatInterface,
        state: dict[str, Any],
    ) -> tuple[list[Any], dict[str, Any]]:
        config = self.parse_config(interface.platform_config)
        if not config.bot_token:
            # validate_runtime_config should have caught this; defensive.
            raise RuntimeError(
                "Telegram polling requires a non-empty platform_config.bot_token"
            )

        polling = interface.polling
        long_poll_timeout = polling.timeout if polling and polling.timeout else 0

        params: dict[str, Any] = {"timeout": long_poll_timeout}
        offset = state.get("offset")
        if offset is not None:
            params["offset"] = offset

        url = f"{TELEGRAM_API_BASE}/bot{config.bot_token}/getUpdates"

        # Read timeout must outlast Telegram's long-poll window or every call
        # would abort early with a client-side timeout.
        read_timeout = long_poll_timeout + _GET_UPDATES_HTTP_TIMEOUT_PADDING
        timeout = httpx.Timeout(read_timeout, connect=10.0)

        # Catch httpx errors explicitly: the default exception chain
        # includes the request URL, which contains the bot token. Sanitize
        # the error and suppress the original chain (``from None``) so the
        # token does not leak through ``logger.exception`` in the polling
        # loop.
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(url, params=params)
                response.raise_for_status()
                body = response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(
                f"Telegram getUpdates returned HTTP {e.response.status_code}"
            ) from None
        except httpx.HTTPError as e:
            raise RuntimeError(
                f"Telegram getUpdates request failed: {type(e).__name__}"
            ) from None

        if not body.get("ok"):
            raise RuntimeError(
                f"Telegram getUpdates returned not-ok: "
                f"{body.get('description', 'no description')}"
            )

        raw_result = body.get("result")
        if raw_result is None:
            updates = []
        elif not isinstance(raw_result, list):
            raise RuntimeError(
                f"Telegram getUpdates returned unexpected result shape: "
                f"{type(raw_result).__name__}"
            )
        else:
            updates = raw_result

        next_state = dict(state)
        if updates:
            max_id = max(
                (u.get("update_id", 0) for u in updates if isinstance(u, dict)),
                default=0,
            )
            next_state["offset"] = max_id + 1

        return updates, next_state


def _stringify_id(value: object) -> str | None:
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str) and value != "":
        return value
    return None
