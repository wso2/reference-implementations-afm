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

import hashlib
import hmac
import logging
import time
from typing import TYPE_CHECKING, Any, ClassVar, Mapping

from fastapi import HTTPException
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, ConfigDict

from ...models import PlatformChatMode
from ._handler import PlatformHandler

if TYPE_CHECKING:
    from ...models import PlatformChatInterface

logger = logging.getLogger(__name__)

SLACK_SIGNATURE_VERSION = "v0"
SLACK_SIGNATURE_MAX_AGE_SECONDS = 60 * 5


class SlackConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    signing_secret: str | None = None


def verify_slack_request_signature(
    body: bytes,
    *,
    timestamp: str | None,
    signature_header: str | None,
    signing_secret: str,
    current_time: int | None = None,
) -> bool:
    if timestamp is None or signature_header is None:
        return False

    try:
        timestamp_int = int(timestamp)
    except ValueError:
        return False

    now = current_time if current_time is not None else int(time.time())
    if abs(now - timestamp_int) > SLACK_SIGNATURE_MAX_AGE_SECONDS:
        return False

    try:
        body_str = body.decode("utf-8")
    except UnicodeDecodeError:
        return False

    sig_basestring = f"{SLACK_SIGNATURE_VERSION}:{timestamp}:{body_str}"
    expected_sig = (
        f"{SLACK_SIGNATURE_VERSION}="
        + hmac.new(
            signing_secret.encode("utf-8"),
            sig_basestring.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
    )

    return hmac.compare_digest(expected_sig, signature_header)


def get_slack_session_id(payload: object) -> str:
    if not isinstance(payload, dict):
        return "default"

    team_id = _non_empty_string(payload.get("team_id")) or _non_empty_string(
        payload.get("context_team_id")
    )
    if team_id is None:
        team_id = "unknown-team"

    payload_type = _non_empty_string(payload.get("type"))
    if payload_type == "event_callback":
        event = payload.get("event")
        if isinstance(event, dict):
            channel = _non_empty_string(event.get("channel"))
            thread_id = _non_empty_string(event.get("thread_ts")) or _non_empty_string(
                event.get("ts")
            )
            if channel and thread_id:
                return f"slack:{team_id}:{channel}:{thread_id}"

            user_id = _non_empty_string(event.get("user")) or _get_authorization_user(
                payload
            )
            if channel and user_id:
                return f"slack:{team_id}:{channel}:{user_id}"

        event_context = _non_empty_string(payload.get("event_context"))
        if event_context:
            return f"slack:{team_id}:{event_context}"

        event_id = _non_empty_string(payload.get("event_id"))
        if event_id:
            return f"slack:{team_id}:{event_id}"

    if payload_type == "url_verification":
        challenge = _non_empty_string(payload.get("challenge"))
        if challenge:
            return f"slack:{team_id}:url_verification:{challenge}"

    return f"slack:{team_id}:default"


def should_ignore_slack_event(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False

    if payload.get("type") != "event_callback":
        return payload.get("type") == "app_rate_limited"

    event = payload.get("event")
    if not isinstance(event, dict):
        logger.warning(
            "Ignoring event_callback with missing or malformed 'event' field"
        )
        return True

    # Only process event types the agent can act on.
    # Everything else (e.g. function_executed_success) is ignored.
    event_type = event.get("type")
    if event_type not in {"message", "app_mention"}:
        return True

    if event.get("bot_id") is not None:
        return True

    # Messages sent via an app (e.g. through the Slack MCP server using a
    # user token) carry an ``app_id`` but no ``bot_id``.  Without this
    # check the bot's own replies re-trigger the agent in a loop.
    # Only ignore messages from our own app (matched via the envelope's
    # ``api_app_id``) so that messages from other apps can still be handled.
    event_app_id = event.get("app_id")
    if event_app_id is not None and event_app_id == payload.get("api_app_id"):
        return True

    subtype = event.get("subtype")
    return isinstance(subtype, str) and subtype in {
        "bot_message",
        "message_changed",
        "message_deleted",
        "message_replied",
    }


class SlackHandler(PlatformHandler):
    name: ClassVar[str] = "slack"
    supported_modes: ClassVar[frozenset[PlatformChatMode]] = frozenset(
        {PlatformChatMode.NOTIFICATION}
    )

    def parse_config(self, raw_config: Mapping[str, Any] | None) -> SlackConfig:
        return SlackConfig.model_validate(dict(raw_config or {}))

    def validate_runtime_config(
        self,
        interface: PlatformChatInterface,
        *,
        verify_signatures: bool,
    ) -> None:
        if not verify_signatures:
            return
        config = self.parse_config(interface.platform_config)
        if config.signing_secret is None:
            raise ValueError(
                "Slack platform chat requires "
                "platform_config.signing_secret when signature "
                "verification is enabled."
            )

    def verify_raw_request(
        self,
        body: bytes,
        headers: Mapping[str, str],
        interface: PlatformChatInterface,
    ) -> None:
        config = self.parse_config(interface.platform_config)
        if config.signing_secret is None:
            raise HTTPException(
                status_code=500,
                detail="Slack signing secret is not configured",
            )

        if not verify_slack_request_signature(
            body,
            timestamp=headers.get("x-slack-request-timestamp")
            or headers.get("X-Slack-Request-Timestamp"),
            signature_header=headers.get("x-slack-signature")
            or headers.get("X-Slack-Signature"),
            signing_secret=config.signing_secret,
        ):
            raise HTTPException(
                status_code=401,
                detail="Invalid Slack signature",
            )

    def verify_parsed_payload(
        self,
        payload: Any,
        interface: PlatformChatInterface,
    ) -> None:
        # Slack signature is verified pre-parse; nothing extra needed here.
        return

    def handle_pre_dispatch(self, payload: Any) -> Response | None:
        if isinstance(payload, dict) and payload.get("type") == "url_verification":
            challenge = payload.get("challenge")
            if not isinstance(challenge, str):
                raise HTTPException(
                    status_code=400,
                    detail="Slack URL verification payload must contain a challenge",
                )
            return PlainTextResponse(content=challenge)
        return None

    def should_ignore(self, payload: Any) -> bool:
        return should_ignore_slack_event(payload)

    def create_ignored_response(self) -> Response:
        return Response(status_code=200)

    def get_session_id(self, payload: Any) -> str:
        return get_slack_session_id(payload)

    def create_notification_ack(self) -> Response:
        return Response(status_code=200)


def _non_empty_string(value: object) -> str | None:
    return value if isinstance(value, str) and value != "" else None


def _get_authorization_user(payload: dict[str, Any]) -> str | None:
    authorizations = payload.get("authorizations")
    if not isinstance(authorizations, list):
        return None

    for authorization in authorizations:
        if not isinstance(authorization, dict):
            continue
        user_id = authorization.get("user_id")
        if isinstance(user_id, str) and user_id:
            return user_id

    return None
