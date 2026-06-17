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

import asyncio
import hashlib
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from pydantic import ValidationError

from afm.interfaces.platform_chat import (
    create_platform_chat_app,
    dispatch_update,
    get_platform_handler,
    get_platform_session_id,
    run_polling_loop,
    validate_platform_chat_interface_schema,
)
from afm.interfaces.platform_chat.gchat import (
    GChatConfig,
    GChatHandler,
    HttpEndpointUrlConfig,
    ProjectNumberConfig,
    extract_bearer_token,
    get_gchat_session_id,
    get_http_config,
    should_ignore_gchat_event,
)
from afm.interfaces.platform_chat.slack import (
    SlackConfig,
    SlackHandler,
    get_slack_session_id,
    should_ignore_slack_event,
    verify_slack_request_signature,
)
from afm.interfaces.platform_chat.telegram import (
    TELEGRAM_SECRET_TOKEN_HEADER,
    TelegramConfig,
    TelegramHandler,
    get_telegram_session_id,
    should_ignore_telegram_update,
    verify_telegram_secret_token,
)
from afm.models import (
    Exposure,
    HTTPExposure,
    JSONSchema,
    PlatformChatInterface,
    PlatformChatMode,
    Polling,
    Signature,
)
from afm.runner import AgentRunner


@pytest.fixture
def mock_slack_notification_agent() -> tuple[MagicMock, asyncio.Event, list[str]]:
    agent = MagicMock(spec=AgentRunner)
    agent.name = "Slack Notification Agent"
    agent.description = "Slack platform chat agent (notification mode)"
    agent.afm = MagicMock()
    agent.afm.metadata = MagicMock()
    agent.afm.metadata.version = "1.0.0"

    interface = PlatformChatInterface(
        type="platformchat",
        platform="slack",
        mode=PlatformChatMode.NOTIFICATION,
        prompt="Async reply to ${http:payload.message.text}",
        signature=Signature(input=JSONSchema(type="object")),
        platform_config={"signing_secret": "test-secret"},
        exposure=Exposure(http=HTTPExposure(path="/slack")),
    )
    agent.afm.metadata.interfaces = [interface]

    seen_prompts: list[str] = []
    ran = asyncio.Event()

    async def mock_arun(input_data: str, session_id: str = "default") -> str:
        seen_prompts.append(input_data)
        ran.set()
        return f"Processed async prompt: {input_data}"

    agent.arun = mock_arun
    return agent, ran, seen_prompts


@pytest.fixture
def mock_gchat_notification_agent() -> tuple[MagicMock, asyncio.Event, list[str]]:
    agent = MagicMock(spec=AgentRunner)
    agent.name = "GChat Notification Agent"
    agent.description = "GChat platform chat agent (notification mode)"
    agent.afm = MagicMock()
    agent.afm.metadata = MagicMock()
    agent.afm.metadata.version = "1.0.0"

    interface = PlatformChatInterface(
        type="platformchat",
        platform="gchat",
        mode=PlatformChatMode.NOTIFICATION,
        prompt="GChat event: ${http:payload.message.text}",
        signature=Signature(input=JSONSchema(type="object")),
        platform_config={"project_number": "test-project-number"},
        exposure=Exposure(http=HTTPExposure(path="/gchat")),
    )
    agent.afm.metadata.interfaces = [interface]

    seen_prompts: list[str] = []
    ran = asyncio.Event()

    async def mock_arun(input_data: str, session_id: str = "default") -> str:
        seen_prompts.append(input_data)
        ran.set()
        return f"Processed gchat prompt: {input_data}"

    agent.arun = mock_arun
    return agent, ran, seen_prompts


@pytest.fixture
def mock_gchat_request_agent() -> MagicMock:
    agent = MagicMock(spec=AgentRunner)
    agent.name = "GChat Request Agent"
    agent.description = "GChat platform chat agent (request mode)"
    agent.afm = MagicMock()
    agent.afm.metadata = MagicMock()
    agent.afm.metadata.version = "1.0.0"

    interface = PlatformChatInterface(
        type="platformchat",
        platform="gchat",
        mode=PlatformChatMode.REQUEST,
        prompt="GChat event: ${http:payload.message.text}",
        signature=Signature(
            input=JSONSchema(type="object"),
            output=JSONSchema(type="string"),
        ),
        platform_config={"project_number": "test-project-number"},
        exposure=Exposure(http=HTTPExposure(path="/gchat")),
        has_explicit_output_schema=True,
    )
    agent.afm.metadata.interfaces = [interface]

    async def mock_arun(input_data: str, session_id: str = "default") -> str:
        return "Hello from GChat agent"

    agent.arun = mock_arun
    return agent


class TestVerifySlackRequestSignature:
    SIGNING_SECRET = "test-slack-signing-secret"
    TIMESTAMP = "1531420618"

    def _make_signature(self, body: bytes, timestamp: str | None = None) -> str:
        import hmac as _hmac

        ts = timestamp or self.TIMESTAMP
        sig_basestring = f"v0:{ts}:{body.decode('utf-8')}"
        return (
            "v0="
            + _hmac.new(
                self.SIGNING_SECRET.encode("utf-8"),
                sig_basestring.encode("utf-8"),
                hashlib.sha256,
            ).hexdigest()
        )

    def test_valid_signature(self) -> None:
        body = b'{"event":"test"}'
        sig = self._make_signature(body)
        assert (
            verify_slack_request_signature(
                body,
                timestamp=self.TIMESTAMP,
                signature_header=sig,
                signing_secret=self.SIGNING_SECRET,
                current_time=int(self.TIMESTAMP),
            )
            is True
        )

    def test_invalid_signature(self) -> None:
        body = b'{"event":"test"}'
        assert (
            verify_slack_request_signature(
                body,
                timestamp=self.TIMESTAMP,
                signature_header="v0=bad",
                signing_secret=self.SIGNING_SECRET,
                current_time=int(self.TIMESTAMP),
            )
            is False
        )

    def test_missing_timestamp(self) -> None:
        body = b'{"event":"test"}'
        sig = self._make_signature(body)
        assert (
            verify_slack_request_signature(
                body,
                timestamp=None,
                signature_header=sig,
                signing_secret=self.SIGNING_SECRET,
            )
            is False
        )

    def test_missing_signature_header(self) -> None:
        body = b'{"event":"test"}'
        assert (
            verify_slack_request_signature(
                body,
                timestamp=self.TIMESTAMP,
                signature_header=None,
                signing_secret=self.SIGNING_SECRET,
            )
            is False
        )

    def test_invalid_utf8_body(self) -> None:
        body = b"\xff\xfe\xfd"
        assert (
            verify_slack_request_signature(
                body,
                timestamp=self.TIMESTAMP,
                signature_header="v0=anything",
                signing_secret=self.SIGNING_SECRET,
                current_time=int(self.TIMESTAMP),
            )
            is False
        )

    def test_non_numeric_timestamp(self) -> None:
        body = b'{"event":"test"}'
        sig = self._make_signature(body, "not-a-number")
        assert (
            verify_slack_request_signature(
                body,
                timestamp="not-a-number",
                signature_header=sig,
                signing_secret=self.SIGNING_SECRET,
            )
            is False
        )

    def test_expired_timestamp(self) -> None:
        body = b'{"event":"test"}'
        old_ts = "1000000000"
        sig = self._make_signature(body, old_ts)
        assert (
            verify_slack_request_signature(
                body,
                timestamp=old_ts,
                signature_header=sig,
                signing_secret=self.SIGNING_SECRET,
                current_time=1000000000 + 60 * 5 + 1,
            )
            is False
        )

    def test_timestamp_within_tolerance(self) -> None:
        body = b'{"event":"test"}'
        ts = "1000000000"
        sig = self._make_signature(body, ts)
        assert (
            verify_slack_request_signature(
                body,
                timestamp=ts,
                signature_header=sig,
                signing_secret=self.SIGNING_SECRET,
                current_time=1000000000 + 60 * 5,
            )
            is True
        )

    def test_wrong_secret(self) -> None:
        body = b'{"event":"test"}'
        sig = self._make_signature(body)
        assert (
            verify_slack_request_signature(
                body,
                timestamp=self.TIMESTAMP,
                signature_header=sig,
                signing_secret="wrong-secret",
                current_time=int(self.TIMESTAMP),
            )
            is False
        )


class TestShouldIgnoreSlackEvent:
    def test_non_dict_payload_not_ignored(self) -> None:
        assert should_ignore_slack_event("not a dict") is False

    def test_app_rate_limited_ignored(self) -> None:
        assert should_ignore_slack_event({"type": "app_rate_limited"}) is True

    def test_url_verification_not_ignored(self) -> None:
        assert should_ignore_slack_event({"type": "url_verification"}) is False

    def test_event_callback_missing_event_ignored(self) -> None:
        assert should_ignore_slack_event({"type": "event_callback"}) is True

    def test_event_callback_non_dict_event_ignored(self) -> None:
        assert (
            should_ignore_slack_event({"type": "event_callback", "event": "not-a-dict"})
            is True
        )

    def test_message_event_not_ignored(self) -> None:
        assert (
            should_ignore_slack_event(
                {
                    "type": "event_callback",
                    "event": {"type": "message"},
                }
            )
            is False
        )

    def test_app_mention_event_not_ignored(self) -> None:
        assert (
            should_ignore_slack_event(
                {
                    "type": "event_callback",
                    "event": {"type": "app_mention"},
                }
            )
            is False
        )

    def test_unknown_event_type_ignored(self) -> None:
        assert (
            should_ignore_slack_event(
                {
                    "type": "event_callback",
                    "event": {"type": "reaction_added"},
                }
            )
            is True
        )

    def test_bot_message_ignored(self) -> None:
        assert (
            should_ignore_slack_event(
                {
                    "type": "event_callback",
                    "event": {"type": "message", "bot_id": "B123"},
                }
            )
            is True
        )

    def test_own_app_message_ignored(self) -> None:
        assert (
            should_ignore_slack_event(
                {
                    "type": "event_callback",
                    "api_app_id": "A111",
                    "event": {"type": "message", "app_id": "A111"},
                }
            )
            is True
        )

    def test_other_app_message_not_ignored(self) -> None:
        assert (
            should_ignore_slack_event(
                {
                    "type": "event_callback",
                    "api_app_id": "A111",
                    "event": {"type": "message", "app_id": "A222"},
                }
            )
            is False
        )

    def test_message_changed_subtype_ignored(self) -> None:
        assert (
            should_ignore_slack_event(
                {
                    "type": "event_callback",
                    "event": {"type": "message", "subtype": "message_changed"},
                }
            )
            is True
        )

    def test_message_deleted_subtype_ignored(self) -> None:
        assert (
            should_ignore_slack_event(
                {
                    "type": "event_callback",
                    "event": {"type": "message", "subtype": "message_deleted"},
                }
            )
            is True
        )

    def test_bot_message_subtype_ignored(self) -> None:
        assert (
            should_ignore_slack_event(
                {
                    "type": "event_callback",
                    "event": {"type": "message", "subtype": "bot_message"},
                }
            )
            is True
        )

    def test_message_replied_subtype_ignored(self) -> None:
        assert (
            should_ignore_slack_event(
                {
                    "type": "event_callback",
                    "event": {"type": "message", "subtype": "message_replied"},
                }
            )
            is True
        )

    def test_unknown_subtype_not_ignored(self) -> None:
        assert (
            should_ignore_slack_event(
                {
                    "type": "event_callback",
                    "event": {"type": "message", "subtype": "file_share"},
                }
            )
            is False
        )


class TestGetPlatformSessionId:
    def test_slack_delegates_to_slack_session_id(self) -> None:
        payload = {
            "type": "event_callback",
            "team_id": "T123",
            "event": {"type": "message", "channel": "C1", "ts": "1234.5678"},
        }
        result = get_platform_session_id("slack", payload)
        assert result == "slack:T123:C1:1234.5678"

    def test_gchat_delegates_to_gchat_session_id(self) -> None:
        payload = {
            "type": "MESSAGE",
            "space": {"name": "spaces/AAAA"},
            "user": {"name": "users/CCCC"},
        }
        result = get_platform_session_id("gchat", payload)
        assert result == "gchat:spaces/AAAA:users/CCCC"

    def test_unknown_platform_returns_default(self) -> None:
        assert get_platform_session_id("unknown_platform", {}) == "default"


class TestGetSlackSessionId:
    def test_non_dict_payload(self) -> None:
        assert get_slack_session_id("not a dict") == "default"

    def test_event_callback_with_channel_and_thread_ts(self) -> None:
        payload = {
            "type": "event_callback",
            "team_id": "T123",
            "event": {
                "type": "message",
                "channel": "C1",
                "thread_ts": "111.222",
                "ts": "333.444",
            },
        }
        assert get_slack_session_id(payload) == "slack:T123:C1:111.222"

    def test_event_callback_with_channel_and_ts_fallback(self) -> None:
        payload = {
            "type": "event_callback",
            "team_id": "T123",
            "event": {"type": "message", "channel": "C1", "ts": "555.666"},
        }
        assert get_slack_session_id(payload) == "slack:T123:C1:555.666"

    def test_event_callback_with_channel_and_user_fallback(self) -> None:
        payload = {
            "type": "event_callback",
            "team_id": "T123",
            "event": {"type": "message", "channel": "C1", "user": "U789"},
        }
        assert get_slack_session_id(payload) == "slack:T123:C1:U789"

    def test_event_callback_with_authorization_user_fallback(self) -> None:
        payload = {
            "type": "event_callback",
            "team_id": "T123",
            "event": {"type": "message", "channel": "C1"},
            "authorizations": [{"user_id": "UAUTH"}],
        }
        assert get_slack_session_id(payload) == "slack:T123:C1:UAUTH"

    def test_event_callback_event_context_fallback(self) -> None:
        payload = {
            "type": "event_callback",
            "team_id": "T123",
            "event": {"type": "message"},
            "event_context": "ec_ctx",
        }
        assert get_slack_session_id(payload) == "slack:T123:ec_ctx"

    def test_event_callback_event_id_fallback(self) -> None:
        payload = {
            "type": "event_callback",
            "team_id": "T123",
            "event": {"type": "message"},
            "event_id": "Ev001",
        }
        assert get_slack_session_id(payload) == "slack:T123:Ev001"

    def test_event_callback_default_fallback(self) -> None:
        payload = {
            "type": "event_callback",
            "team_id": "T123",
            "event": {"type": "message"},
        }
        assert get_slack_session_id(payload) == "slack:T123:default"

    def test_url_verification_with_challenge(self) -> None:
        payload = {
            "type": "url_verification",
            "team_id": "T123",
            "challenge": "abc123",
        }
        assert get_slack_session_id(payload) == "slack:T123:url_verification:abc123"

    def test_unknown_team_fallback(self) -> None:
        payload = {"type": "event_callback", "event": {"type": "message"}}
        result = get_slack_session_id(payload)
        assert result.startswith("slack:unknown-team:")

    def test_context_team_id_used_when_team_id_missing(self) -> None:
        payload = {
            "type": "event_callback",
            "context_team_id": "T456",
            "event": {"type": "message", "channel": "C1", "ts": "1.2"},
        }
        assert get_slack_session_id(payload) == "slack:T456:C1:1.2"

    def test_generic_type_returns_team_default(self) -> None:
        payload = {"type": "some_other_type", "team_id": "T123"}
        assert get_slack_session_id(payload) == "slack:T123:default"


class TestSlackPlatformChatEndpoint:
    @pytest.mark.asyncio
    async def test_slack_notification_acks_and_runs_in_background(
        self,
        mock_slack_notification_agent: tuple[MagicMock, asyncio.Event, list[str]],
    ) -> None:
        agent, ran, seen_prompts = mock_slack_notification_agent
        app = create_platform_chat_app(agent, verify_signatures=False)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/slack",
                json={"message": {"text": "hello async"}},
                headers={"User-Agent": "PlatformChatTest/1.0"},
            )

        assert response.status_code == 200
        assert response.content == b""
        await asyncio.wait_for(ran.wait(), timeout=2.0)
        assert seen_prompts == ["Async reply to hello async"]


class TestExtractBearerToken:
    def test_valid_bearer(self) -> None:
        assert extract_bearer_token("Bearer abc123") == "abc123"

    def test_scheme_is_case_insensitive(self) -> None:
        assert extract_bearer_token("bearer abc123") == "abc123"
        assert extract_bearer_token("BEARER abc123") == "abc123"
        assert extract_bearer_token("BeArEr abc123") == "abc123"

    def test_trims_whitespace(self) -> None:
        assert extract_bearer_token("Bearer   abc123  ") == "abc123"

    def test_missing_header(self) -> None:
        assert extract_bearer_token(None) is None

    def test_wrong_scheme(self) -> None:
        assert extract_bearer_token("Basic abc123") is None

    def test_empty_token(self) -> None:
        assert extract_bearer_token("Bearer ") is None


class TestGetHttpConfig:
    def test_endpoint_url(self) -> None:
        config = GChatConfig.model_validate({"endpoint_url": "https://example.com/x"})
        http = get_http_config(config)
        assert isinstance(http, HttpEndpointUrlConfig)
        assert http.endpoint_url == "https://example.com/x"

    def test_project_number_string(self) -> None:
        config = GChatConfig.model_validate({"project_number": "1234567890"})
        http = get_http_config(config)
        assert isinstance(http, ProjectNumberConfig)
        assert http.project_number == "1234567890"

    def test_project_number_int_is_coerced(self) -> None:
        config = GChatConfig.model_validate({"project_number": 1234567890})
        http = get_http_config(config)
        assert isinstance(http, ProjectNumberConfig)
        assert http.project_number == "1234567890"

    def test_missing_returns_none(self) -> None:
        config = GChatConfig.model_validate({})
        assert get_http_config(config) is None

    def test_both_set_rejected_at_validation(self) -> None:
        with pytest.raises(ValidationError):
            GChatConfig.model_validate(
                {"endpoint_url": "https://example.com/x", "project_number": "12345"}
            )


class TestShouldIgnoreGChatEvent:
    def test_message_event_not_ignored(self) -> None:
        payload = {
            "type": "MESSAGE",
            "message": {"sender": {"type": "HUMAN"}},
        }
        assert should_ignore_gchat_event(payload) is False

    def test_added_to_space_not_ignored(self) -> None:
        payload = {"type": "ADDED_TO_SPACE"}
        assert should_ignore_gchat_event(payload) is False

    def test_removed_from_space_ignored(self) -> None:
        payload = {"type": "REMOVED_FROM_SPACE"}
        assert should_ignore_gchat_event(payload) is True

    def test_card_clicked_ignored(self) -> None:
        payload = {"type": "CARD_CLICKED"}
        assert should_ignore_gchat_event(payload) is True

    def test_unknown_event_type_ignored(self) -> None:
        payload = {"type": "SOME_FUTURE_EVENT"}
        assert should_ignore_gchat_event(payload) is True

    def test_bot_sender_ignored(self) -> None:
        payload = {
            "type": "MESSAGE",
            "message": {"sender": {"type": "BOT"}},
        }
        assert should_ignore_gchat_event(payload) is True

    def test_non_dict_payload_not_ignored(self) -> None:
        assert should_ignore_gchat_event("not a dict") is False

    def test_missing_type_ignored(self) -> None:
        assert should_ignore_gchat_event({}) is True


class TestGetGChatSessionId:
    def test_space_and_user_fallback(self) -> None:
        payload = {
            "type": "MESSAGE",
            "space": {"name": "spaces/AAAA"},
            "message": {"text": "hello"},
            "user": {"name": "users/CCCC"},
        }
        assert get_gchat_session_id(payload) == "gchat:spaces/AAAA:users/CCCC"

    def test_space_only_fallback(self) -> None:
        payload = {
            "type": "MESSAGE",
            "space": {"name": "spaces/AAAA"},
        }
        assert get_gchat_session_id(payload) == "gchat:spaces/AAAA:default"

    def test_no_space(self) -> None:
        payload = {"type": "MESSAGE"}
        assert get_gchat_session_id(payload) == "gchat:unknown-space:default"

    def test_non_dict_payload(self) -> None:
        assert get_gchat_session_id("not a dict") == "default"

    def test_empty_space_name(self) -> None:
        payload = {"type": "MESSAGE", "space": {"name": ""}}
        assert get_gchat_session_id(payload) == "gchat:unknown-space:default"


class TestGChatPlatformChatEndpoint:
    @pytest.mark.asyncio
    async def test_gchat_notification_returns_202(
        self,
        mock_gchat_notification_agent: tuple[MagicMock, asyncio.Event, list[str]],
    ) -> None:
        agent, ran, seen_prompts = mock_gchat_notification_agent
        app = create_platform_chat_app(agent, verify_signatures=False)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/gchat",
                json={
                    "type": "MESSAGE",
                    "message": {
                        "text": "hello gchat",
                        "sender": {"type": "HUMAN"},
                    },
                },
            )

        assert response.status_code == 202
        assert response.json()["status"] == "accepted"
        await asyncio.wait_for(ran.wait(), timeout=2.0)
        assert seen_prompts == ["GChat event: hello gchat"]

    @pytest.mark.asyncio
    async def test_gchat_request_returns_json_text(
        self,
        mock_gchat_request_agent: MagicMock,
    ) -> None:
        app = create_platform_chat_app(
            mock_gchat_request_agent, verify_signatures=False
        )

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/gchat",
                json={
                    "type": "MESSAGE",
                    "message": {
                        "text": "hello sync",
                        "sender": {"type": "HUMAN"},
                    },
                },
            )

        assert response.status_code == 200
        assert response.json() == {"text": "Hello from GChat agent"}

    @pytest.mark.asyncio
    async def test_gchat_ignores_removed_from_space(
        self,
        mock_gchat_notification_agent: tuple[MagicMock, asyncio.Event, list[str]],
    ) -> None:
        agent, _, _ = mock_gchat_notification_agent
        app = create_platform_chat_app(agent, verify_signatures=False)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/gchat",
                json={"type": "REMOVED_FROM_SPACE"},
            )

        assert response.status_code == 200
        assert response.json() == {}

    @pytest.mark.asyncio
    async def test_gchat_ignores_bot_sender(
        self,
        mock_gchat_notification_agent: tuple[MagicMock, asyncio.Event, list[str]],
    ) -> None:
        agent, _, _ = mock_gchat_notification_agent
        app = create_platform_chat_app(agent, verify_signatures=False)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/gchat",
                json={
                    "type": "MESSAGE",
                    "message": {"sender": {"type": "BOT"}},
                },
            )

        assert response.status_code == 200
        assert response.json() == {}

    @pytest.mark.asyncio
    async def test_gchat_verification_rejects_missing_auth_header(
        self,
        mock_gchat_notification_agent: tuple[MagicMock, asyncio.Event, list[str]],
    ) -> None:
        agent, _, _ = mock_gchat_notification_agent
        app = create_platform_chat_app(agent, verify_signatures=True)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/gchat",
                json={"type": "MESSAGE", "message": {"text": "hi"}},
            )

        assert response.status_code == 401
        assert "Invalid GChat bearer token" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_gchat_verification_rejects_bad_bearer(
        self,
        mock_gchat_notification_agent: tuple[MagicMock, asyncio.Event, list[str]],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(
            "afm.interfaces.platform_chat.gchat._verify_project_number_jwt",
            lambda *_args, **_kwargs: False,
        )
        agent, _, _ = mock_gchat_notification_agent
        app = create_platform_chat_app(agent, verify_signatures=True)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/gchat",
                headers={"Authorization": "Bearer bad-jwt"},
                json={"type": "MESSAGE", "message": {"text": "hi"}},
            )

        assert response.status_code == 401
        assert "Invalid GChat bearer token" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_gchat_verification_accepts_valid_bearer(
        self,
        mock_gchat_notification_agent: tuple[MagicMock, asyncio.Event, list[str]],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(
            "afm.interfaces.platform_chat.gchat._verify_project_number_jwt",
            lambda *_args, **_kwargs: True,
        )
        agent, ran, _ = mock_gchat_notification_agent
        app = create_platform_chat_app(agent, verify_signatures=True)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/gchat",
                headers={"Authorization": "Bearer pretend-jwt"},
                json={
                    "type": "MESSAGE",
                    "message": {
                        "text": "verified msg",
                        "sender": {"type": "HUMAN"},
                    },
                },
            )

        assert response.status_code == 202
        await asyncio.wait_for(ran.wait(), timeout=2.0)

    def test_gchat_does_not_register_websub_get_endpoint(
        self,
        mock_gchat_notification_agent: tuple[MagicMock, asyncio.Event, list[str]],
    ) -> None:
        agent, _, _ = mock_gchat_notification_agent
        app = create_platform_chat_app(agent, verify_signatures=False)
        client = TestClient(app)

        response = client.get(
            "/gchat",
            params={
                "hub.mode": "subscribe",
                "hub.topic": "https://example.com/events",
                "hub.challenge": "test-challenge",
            },
        )

        assert response.status_code == 405


class TestPlatformHandlerRegistry:
    def test_get_known_platform_returns_handler(self) -> None:
        assert isinstance(get_platform_handler("slack"), SlackHandler)
        assert isinstance(get_platform_handler("gchat"), GChatHandler)
        assert isinstance(get_platform_handler("telegram"), TelegramHandler)

    def test_get_unknown_platform_raises(self) -> None:
        with pytest.raises(ValueError) as exc_info:
            get_platform_handler("teams")
        assert "not supported" in str(exc_info.value)


class TestSlackConfig:
    def test_valid_config(self) -> None:
        config = SlackConfig.model_validate({"signing_secret": "abc"})
        assert config.signing_secret == "abc"

    def test_unknown_field_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc_info:
            SlackConfig.model_validate({"signing_secrt": "abc"})
        assert "signing_secrt" in str(exc_info.value)

    def test_wrong_type_rejected(self) -> None:
        with pytest.raises(ValidationError):
            SlackConfig.model_validate({"signing_secret": 123})

    def test_empty_config_allowed(self) -> None:
        # Schema-level: signing_secret is optional. Runtime check enforces
        # its presence only when signature verification is enabled.
        config = SlackConfig.model_validate({})
        assert config.signing_secret is None


class TestGChatConfig:
    def test_valid_project_number(self) -> None:
        config = GChatConfig.model_validate({"project_number": "abc"})
        assert config.project_number == "abc"
        assert config.endpoint_url is None

    def test_valid_endpoint_url(self) -> None:
        config = GChatConfig.model_validate({"endpoint_url": "https://example.com/x"})
        assert config.endpoint_url == "https://example.com/x"
        assert config.project_number is None

    def test_unknown_field_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc_info:
            GChatConfig.model_validate({"verification_token": "abc"})
        assert "verification_token" in str(exc_info.value)

    def test_both_audience_fields_rejected(self) -> None:
        with pytest.raises(ValidationError):
            GChatConfig.model_validate(
                {"endpoint_url": "https://example.com/x", "project_number": "12345"}
            )

    def test_empty_config_allowed(self) -> None:
        # Schema-level: both fields are optional. Runtime check enforces
        # presence of at least one when signature verification is enabled.
        config = GChatConfig.model_validate({})
        assert config.project_number is None
        assert config.endpoint_url is None


class TestValidatePlatformChatInterfaceSchema:
    def _interface(
        self, platform: str, platform_config: dict | None
    ) -> PlatformChatInterface:
        return PlatformChatInterface(
            type="platformchat",
            platform=platform,
            mode=PlatformChatMode.NOTIFICATION,
            platform_config=platform_config,
            exposure=Exposure(http=HTTPExposure(path="/x")),
        )

    def test_valid_slack_config_passes(self) -> None:
        iface = self._interface("slack", {"signing_secret": "abc"})
        validate_platform_chat_interface_schema(iface)

    def test_unknown_platform_raises(self) -> None:
        iface = self._interface("teams", {"foo": "bar"})
        with pytest.raises(ValueError):
            validate_platform_chat_interface_schema(iface)

    def test_typo_in_slack_config_raises(self) -> None:
        iface = self._interface("slack", {"signing_secrt": "abc"})
        with pytest.raises(ValidationError):
            validate_platform_chat_interface_schema(iface)

    def test_typo_in_gchat_config_raises(self) -> None:
        iface = self._interface("gchat", {"project_numbr": "abc"})
        with pytest.raises(ValidationError):
            validate_platform_chat_interface_schema(iface)

    def test_valid_gchat_project_number_passes(self) -> None:
        iface = self._interface("gchat", {"project_number": "1234567890"})
        validate_platform_chat_interface_schema(iface)

    def test_valid_gchat_endpoint_url_passes(self) -> None:
        iface = self._interface("gchat", {"endpoint_url": "https://example.com/x"})
        validate_platform_chat_interface_schema(iface)

    def test_slack_request_mode_rejected(self) -> None:
        iface = PlatformChatInterface(
            type="platformchat",
            platform="slack",
            mode=PlatformChatMode.REQUEST,
            platform_config={"signing_secret": "abc"},
            exposure=Exposure(http=HTTPExposure(path="/x")),
        )
        with pytest.raises(ValueError, match="does not support mode 'request'"):
            validate_platform_chat_interface_schema(iface)

    def test_unsupported_mode_reported_even_with_bad_config(self) -> None:
        # Slack does not support REQUEST mode AND the platform_config has
        # an unknown field. The unsupported-mode error is the clearer
        # failure for the user — surface that one, not a downstream
        # pydantic ValidationError about the typo'd field.
        iface = PlatformChatInterface(
            type="platformchat",
            platform="slack",
            mode=PlatformChatMode.REQUEST,
            platform_config={"signing_secrt": "abc"},
            exposure=Exposure(http=HTTPExposure(path="/x")),
        )
        with pytest.raises(ValueError, match="does not support mode 'request'"):
            validate_platform_chat_interface_schema(iface)

    def test_gchat_request_mode_passes(self) -> None:
        iface = PlatformChatInterface(
            type="platformchat",
            platform="gchat",
            mode=PlatformChatMode.REQUEST,
            platform_config={"project_number": "1234567890"},
            exposure=Exposure(http=HTTPExposure(path="/x")),
        )
        validate_platform_chat_interface_schema(iface)

    def test_telegram_notification_mode_passes(self) -> None:
        iface = self._interface("telegram", {"secret_token": "shh"})
        validate_platform_chat_interface_schema(iface)

    def test_telegram_request_mode_rejected(self) -> None:
        iface = PlatformChatInterface(
            type="platformchat",
            platform="telegram",
            mode=PlatformChatMode.REQUEST,
            platform_config={"secret_token": "shh"},
            exposure=Exposure(http=HTTPExposure(path="/x")),
        )
        with pytest.raises(ValueError, match="does not support mode 'request'"):
            validate_platform_chat_interface_schema(iface)

    def test_telegram_polling_mode_passes(self) -> None:
        iface = PlatformChatInterface(
            type="platformchat",
            platform="telegram",
            mode=PlatformChatMode.POLLING,
            platform_config={"bot_token": "123:abc"},
            polling=Polling(),
        )
        validate_platform_chat_interface_schema(iface)

    def test_slack_polling_mode_rejected(self) -> None:
        iface = PlatformChatInterface(
            type="platformchat",
            platform="slack",
            mode=PlatformChatMode.POLLING,
            platform_config={"signing_secret": "abc"},
            polling=Polling(),
        )
        with pytest.raises(ValueError, match="does not support mode 'polling'"):
            validate_platform_chat_interface_schema(iface)


class TestTelegramConfig:
    def test_empty_config_allowed(self) -> None:
        # Schema-level: both fields are optional. Runtime checks enforce
        # bot_token (polling) and secret_token (verifying) only as needed.
        config = TelegramConfig.model_validate({})
        assert config.bot_token is None
        assert config.secret_token is None

    def test_valid_config_with_secret_token(self) -> None:
        config = TelegramConfig.model_validate({"secret_token": "xyz"})
        assert config.secret_token == "xyz"

    def test_valid_config_with_bot_token(self) -> None:
        config = TelegramConfig.model_validate({"bot_token": "123:abc"})
        assert config.bot_token == "123:abc"

    def test_valid_config_with_both_tokens(self) -> None:
        config = TelegramConfig.model_validate(
            {"bot_token": "123:abc", "secret_token": "shh"}
        )
        assert config.bot_token == "123:abc"
        assert config.secret_token == "shh"

    def test_unknown_field_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc_info:
            TelegramConfig.model_validate({"api_id": "1"})
        assert "api_id" in str(exc_info.value)

    def test_wrong_type_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TelegramConfig.model_validate({"secret_token": 123})

    def test_wrong_bot_token_type_rejected(self) -> None:
        with pytest.raises(ValidationError):
            TelegramConfig.model_validate({"bot_token": 123})

    def test_empty_string_bot_token_normalized_to_none(self) -> None:
        config = TelegramConfig.model_validate({"bot_token": ""})
        assert config.bot_token is None

    def test_whitespace_only_bot_token_normalized_to_none(self) -> None:
        config = TelegramConfig.model_validate({"bot_token": "   "})
        assert config.bot_token is None

    def test_whitespace_only_secret_token_normalized_to_none(self) -> None:
        config = TelegramConfig.model_validate({"secret_token": "\t\n "})
        assert config.secret_token is None

    def test_token_with_surrounding_whitespace_is_stripped(self) -> None:
        config = TelegramConfig.model_validate({"bot_token": " 123:abc "})
        assert config.bot_token == "123:abc"


class TestVerifyTelegramSecretToken:
    def test_matching_token_passes(self) -> None:
        assert verify_telegram_secret_token("abc", "abc") is True

    def test_mismatched_token_fails(self) -> None:
        assert verify_telegram_secret_token("abc", "xyz") is False

    def test_missing_header_fails(self) -> None:
        assert verify_telegram_secret_token(None, "abc") is False

    def test_empty_received_fails(self) -> None:
        assert verify_telegram_secret_token("", "abc") is False


class TestShouldIgnoreTelegramUpdate:
    def test_non_dict_payload_not_ignored(self) -> None:
        assert should_ignore_telegram_update("not a dict") is False

    def test_message_from_user_not_ignored(self) -> None:
        payload = {
            "update_id": 1,
            "message": {
                "message_id": 1,
                "from": {"id": 42, "is_bot": False},
                "chat": {"id": 42, "type": "private"},
                "text": "hi",
            },
        }
        assert should_ignore_telegram_update(payload) is False

    def test_message_from_bot_ignored(self) -> None:
        payload = {
            "update_id": 1,
            "message": {
                "message_id": 1,
                "from": {"id": 42, "is_bot": True},
                "chat": {"id": 42, "type": "private"},
                "text": "hi",
            },
        }
        assert should_ignore_telegram_update(payload) is True

    def test_edited_message_ignored(self) -> None:
        # Updates without a "message" field (edited_message, channel_post,
        # callback_query, etc.) are not handled by the default flow.
        payload = {
            "update_id": 1,
            "edited_message": {
                "message_id": 1,
                "from": {"id": 42, "is_bot": False},
                "chat": {"id": 42, "type": "private"},
                "text": "hi (edited)",
            },
        }
        assert should_ignore_telegram_update(payload) is True

    def test_callback_query_ignored(self) -> None:
        payload = {"update_id": 1, "callback_query": {"id": "1"}}
        assert should_ignore_telegram_update(payload) is True


class TestGetTelegramSessionId:
    def test_non_dict_payload(self) -> None:
        assert get_telegram_session_id("not a dict") == "default"

    def test_private_chat_with_user(self) -> None:
        payload = {
            "message": {
                "from": {"id": 42},
                "chat": {"id": 42, "type": "private"},
            }
        }
        assert get_telegram_session_id(payload) == "telegram:42:42"

    def test_group_chat_with_user(self) -> None:
        payload = {
            "message": {
                "from": {"id": 99},
                "chat": {"id": -1001234, "type": "supergroup"},
            }
        }
        assert get_telegram_session_id(payload) == "telegram:-1001234:99"

    def test_missing_user_falls_back_to_default(self) -> None:
        payload = {
            "message": {
                "chat": {"id": -1001234, "type": "channel"},
            }
        }
        assert get_telegram_session_id(payload) == "telegram:-1001234:default"

    def test_missing_chat_uses_unknown(self) -> None:
        payload = {"message": {"from": {"id": 42}}}
        assert get_telegram_session_id(payload) == "telegram:unknown-chat:42"

    def test_missing_message_returns_unknown(self) -> None:
        assert get_telegram_session_id({}) == "telegram:unknown-chat:default"

    def test_string_id_passes_through(self) -> None:
        payload = {
            "message": {
                "from": {"id": "user-42"},
                "chat": {"id": "chat-42"},
            }
        }
        assert get_telegram_session_id(payload) == "telegram:chat-42:user-42"


class TestTelegramHandlerVerifyRawRequest:
    def _interface(self, secret_token: str | None) -> PlatformChatInterface:
        config: dict = {}
        if secret_token is not None:
            config["secret_token"] = secret_token
        return PlatformChatInterface(
            type="platformchat",
            platform="telegram",
            mode=PlatformChatMode.NOTIFICATION,
            platform_config=config,
            exposure=Exposure(http=HTTPExposure(path="/telegram")),
        )

    def test_valid_secret_token_passes(self) -> None:
        handler = TelegramHandler()
        handler.verify_raw_request(
            body=b"{}",
            headers={TELEGRAM_SECRET_TOKEN_HEADER: "shh"},
            interface=self._interface("shh"),
        )

    def test_invalid_secret_token_rejected(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        handler = TelegramHandler()
        with caplog.at_level("WARNING"):
            with pytest.raises(HTTPException) as exc_info:
                handler.verify_raw_request(
                    body=b"{}",
                    headers={TELEGRAM_SECRET_TOKEN_HEADER: "wrong"},
                    interface=self._interface("shh"),
                )
        assert exc_info.value.status_code == 401
        # Mismatch path emits a sanitized warning — header was present
        # but did not match. We never log either side of the token.
        mismatch_logs = [
            r for r in caplog.records if "secret token mismatch" in r.message
        ]
        assert len(mismatch_logs) == 1
        rendered = mismatch_logs[0].getMessage()
        assert "header_present=True" in rendered
        assert "wrong" not in rendered
        assert "shh" not in rendered

    def test_missing_secret_token_header_rejected(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        handler = TelegramHandler()
        with caplog.at_level("WARNING"):
            with pytest.raises(HTTPException) as exc_info:
                handler.verify_raw_request(
                    body=b"{}",
                    headers={},
                    interface=self._interface("shh"),
                )
        assert exc_info.value.status_code == 401
        mismatch_logs = [
            r for r in caplog.records if "secret token mismatch" in r.message
        ]
        assert len(mismatch_logs) == 1
        # No header at all is distinguishable in the log from a wrong one.
        assert "header_present=False" in mismatch_logs[0].getMessage()

    def test_handler_without_configured_secret_returns_500(self) -> None:
        handler = TelegramHandler()
        with pytest.raises(HTTPException) as exc_info:
            handler.verify_raw_request(
                body=b"{}",
                headers={TELEGRAM_SECRET_TOKEN_HEADER: "shh"},
                interface=self._interface(None),
            )
        assert exc_info.value.status_code == 500


class TestTelegramHandlerValidateRuntimeConfig:
    def _interface(self, secret_token: str | None) -> PlatformChatInterface:
        config: dict = {}
        if secret_token is not None:
            config["secret_token"] = secret_token
        return PlatformChatInterface(
            type="platformchat",
            platform="telegram",
            mode=PlatformChatMode.NOTIFICATION,
            platform_config=config,
            exposure=Exposure(http=HTTPExposure(path="/telegram")),
        )

    def test_secret_required_when_verifying(self) -> None:
        with pytest.raises(ValueError, match="secret_token"):
            TelegramHandler().validate_runtime_config(
                self._interface(None), verify_signatures=True
            )

    def test_secret_not_required_when_not_verifying(self) -> None:
        TelegramHandler().validate_runtime_config(
            self._interface(None), verify_signatures=False
        )

    def test_secret_present_passes(self) -> None:
        TelegramHandler().validate_runtime_config(
            self._interface("shh"), verify_signatures=True
        )

    def _polling_interface(self, *, bot_token: str | None) -> PlatformChatInterface:
        config: dict = {}
        if bot_token is not None:
            config["bot_token"] = bot_token
        return PlatformChatInterface(
            type="platformchat",
            platform="telegram",
            mode=PlatformChatMode.POLLING,
            platform_config=config,
            polling=Polling(),
        )

    def test_polling_requires_bot_token(self) -> None:
        with pytest.raises(ValueError, match="bot_token"):
            TelegramHandler().validate_runtime_config(
                self._polling_interface(bot_token=None),
                verify_signatures=False,
            )

    def test_polling_with_bot_token_passes(self) -> None:
        TelegramHandler().validate_runtime_config(
            self._polling_interface(bot_token="123:abc"),
            verify_signatures=False,
        )

    def test_polling_does_not_require_secret_token(self) -> None:
        # Polling pulls from the bot's authenticated session — no inbound
        # webhook to verify, so secret_token is irrelevant.
        TelegramHandler().validate_runtime_config(
            self._polling_interface(bot_token="123:abc"),
            verify_signatures=True,
        )

    def test_polling_rejects_empty_bot_token(self) -> None:
        with pytest.raises(ValueError, match="bot_token"):
            TelegramHandler().validate_runtime_config(
                self._polling_interface(bot_token=""),
                verify_signatures=False,
            )

    def test_polling_rejects_whitespace_only_bot_token(self) -> None:
        with pytest.raises(ValueError, match="bot_token"):
            TelegramHandler().validate_runtime_config(
                self._polling_interface(bot_token="   "),
                verify_signatures=False,
            )

    def test_notification_rejects_empty_secret_token(self) -> None:
        with pytest.raises(ValueError, match="secret_token"):
            TelegramHandler().validate_runtime_config(
                self._interface(secret_token=""),
                verify_signatures=True,
            )

    def test_notification_rejects_whitespace_only_secret_token(self) -> None:
        with pytest.raises(ValueError, match="secret_token"):
            TelegramHandler().validate_runtime_config(
                self._interface(secret_token="\t \n"),
                verify_signatures=True,
            )

    def test_polling_rejects_timeout_above_telegram_cap(self) -> None:
        iface = PlatformChatInterface(
            type="platformchat",
            platform="telegram",
            mode=PlatformChatMode.POLLING,
            platform_config={"bot_token": "123:abc"},
            polling=Polling(timeout=60),
        )
        with pytest.raises(ValueError, match="at most 50"):
            TelegramHandler().validate_runtime_config(iface, verify_signatures=False)

    def test_polling_accepts_timeout_at_telegram_cap(self) -> None:
        iface = PlatformChatInterface(
            type="platformchat",
            platform="telegram",
            mode=PlatformChatMode.POLLING,
            platform_config={"bot_token": "123:abc"},
            polling=Polling(timeout=50),
        )
        TelegramHandler().validate_runtime_config(iface, verify_signatures=False)


class TestPollingModelValidation:
    def test_negative_interval_rejected(self) -> None:
        with pytest.raises(ValidationError):
            Polling.model_validate({"interval": -1})

    def test_zero_interval_allowed(self) -> None:
        # interval=0 is meaningful: "no sleep between cycles", typical
        # when timeout is set and the platform long-polls.
        config = Polling.model_validate({"interval": 0})
        assert config.interval == 0

    def test_negative_timeout_rejected(self) -> None:
        with pytest.raises(ValidationError):
            Polling.model_validate({"timeout": -1})


def _make_telegram_polling_interface(
    bot_token: str = "123:abc",
) -> PlatformChatInterface:
    return PlatformChatInterface(
        type="platformchat",
        platform="telegram",
        mode=PlatformChatMode.POLLING,
        platform_config={"bot_token": bot_token},
        polling=Polling(interval=0, timeout=0),
    )


def _mock_async_client_factory(
    monkeypatch: pytest.MonkeyPatch,
    get_responses: list[dict | Exception],
) -> list[dict]:
    """Patch httpx.AsyncClient in telegram.py to return successive canned
    JSON bodies from ``get_responses``. Returns a list that records each
    GET call's (url, params) for assertion."""
    calls: list[dict] = []
    iterator = iter(get_responses)

    def make_response(body: dict) -> MagicMock:
        resp = MagicMock()
        resp.json.return_value = body
        resp.raise_for_status.return_value = None
        return resp

    async def fake_get(url: str, params: dict | None = None) -> MagicMock:
        # Yield so the polling loop's surrounding tasks (stoppers) get
        # scheduled — without this, the loop spins synchronously and
        # the stop signal is never delivered.
        await asyncio.sleep(0)
        calls.append({"url": url, "params": dict(params) if params else None})
        try:
            body = next(iterator)
        except StopIteration:
            body = {"ok": True, "result": []}
        if isinstance(body, Exception):
            raise body
        return make_response(body)

    mock_client = MagicMock()
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)
    mock_client.get = fake_get

    def factory(*args: object, **kwargs: object) -> MagicMock:
        return mock_client

    monkeypatch.setattr(
        "afm.interfaces.platform_chat.telegram.httpx.AsyncClient", factory
    )
    return calls


class TestTelegramHandlerPollUpdates:
    @pytest.mark.asyncio
    async def test_first_call_omits_offset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = _mock_async_client_factory(monkeypatch, [{"ok": True, "result": []}])
        updates, state = await TelegramHandler().poll_updates(
            _make_telegram_polling_interface(), {}
        )
        assert updates == []
        assert state == {}
        assert calls[0]["params"] == {"timeout": 0}

    @pytest.mark.asyncio
    async def test_returned_updates_and_offset_progression(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = _mock_async_client_factory(
            monkeypatch,
            [
                {
                    "ok": True,
                    "result": [
                        {"update_id": 10, "message": {"text": "a"}},
                        {"update_id": 12, "message": {"text": "b"}},
                    ],
                }
            ],
        )
        updates, state = await TelegramHandler().poll_updates(
            _make_telegram_polling_interface(), {}
        )
        assert len(updates) == 2
        assert state == {"offset": 13}
        assert calls[0]["params"] == {"timeout": 0}

    @pytest.mark.asyncio
    async def test_subsequent_call_passes_offset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = _mock_async_client_factory(monkeypatch, [{"ok": True, "result": []}])
        await TelegramHandler().poll_updates(
            _make_telegram_polling_interface(), {"offset": 99}
        )
        assert calls[0]["params"] == {"timeout": 0, "offset": 99}

    @pytest.mark.asyncio
    async def test_empty_batch_preserves_offset(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _mock_async_client_factory(monkeypatch, [{"ok": True, "result": []}])
        updates, state = await TelegramHandler().poll_updates(
            _make_telegram_polling_interface(), {"offset": 42}
        )
        assert updates == []
        assert state == {"offset": 42}

    @pytest.mark.asyncio
    async def test_not_ok_response_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _mock_async_client_factory(
            monkeypatch, [{"ok": False, "description": "Unauthorized"}]
        )
        with pytest.raises(RuntimeError, match="Unauthorized"):
            await TelegramHandler().poll_updates(_make_telegram_polling_interface(), {})

    @pytest.mark.asyncio
    async def test_non_list_result_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _mock_async_client_factory(monkeypatch, [{"ok": True, "result": "not a list"}])
        with pytest.raises(RuntimeError, match="unexpected result shape") as exc_info:
            await TelegramHandler().poll_updates(_make_telegram_polling_interface(), {})
        assert "not a list" not in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_falsy_non_list_result_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _mock_async_client_factory(monkeypatch, [{"ok": True, "result": 0}])
        with pytest.raises(RuntimeError, match="unexpected result shape"):
            await TelegramHandler().poll_updates(_make_telegram_polling_interface(), {})

    @pytest.mark.asyncio
    async def test_http_status_error_is_sanitized(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        request = httpx.Request(
            "GET",
            "https://api.telegram.org/bot123:secret-token/getUpdates",
        )
        response = httpx.Response(429, request=request)
        _mock_async_client_factory(
            monkeypatch,
            [
                httpx.HTTPStatusError(
                    "rate limited",
                    request=request,
                    response=response,
                )
            ],
        )

        with pytest.raises(RuntimeError) as exc_info:
            await TelegramHandler().poll_updates(_make_telegram_polling_interface(), {})

        assert str(exc_info.value) == "Telegram getUpdates returned HTTP 429"
        assert "123:secret-token" not in str(exc_info.value)
        assert exc_info.value.__suppress_context__ is True

    @pytest.mark.asyncio
    async def test_http_transport_error_is_sanitized(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        request = httpx.Request(
            "GET",
            "https://api.telegram.org/bot123:secret-token/getUpdates",
        )
        _mock_async_client_factory(
            monkeypatch,
            [httpx.ConnectError("connect failed", request=request)],
        )

        with pytest.raises(RuntimeError) as exc_info:
            await TelegramHandler().poll_updates(_make_telegram_polling_interface(), {})

        assert str(exc_info.value) == (
            "Telegram getUpdates request failed: ConnectError"
        )
        assert "123:secret-token" not in str(exc_info.value)
        assert exc_info.value.__suppress_context__ is True

    @pytest.mark.asyncio
    async def test_missing_bot_token_raises(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        iface = PlatformChatInterface(
            type="platformchat",
            platform="telegram",
            mode=PlatformChatMode.POLLING,
            platform_config={},
            polling=Polling(),
        )
        with pytest.raises(RuntimeError, match="bot_token"):
            await TelegramHandler().poll_updates(iface, {})

    @pytest.mark.asyncio
    async def test_long_poll_timeout_passed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = _mock_async_client_factory(monkeypatch, [{"ok": True, "result": []}])
        iface = PlatformChatInterface(
            type="platformchat",
            platform="telegram",
            mode=PlatformChatMode.POLLING,
            platform_config={"bot_token": "123:abc"},
            polling=Polling(interval=1, timeout=30),
        )
        await TelegramHandler().poll_updates(iface, {})
        assert calls[0]["params"] == {"timeout": 30}


class TestDispatchUpdate:
    def _interface(self) -> PlatformChatInterface:
        return PlatformChatInterface(
            type="platformchat",
            platform="telegram",
            mode=PlatformChatMode.NOTIFICATION,
            platform_config={"secret_token": "shh"},
            prompt="Reply to ${http:payload.message.text}",
            exposure=Exposure(http=HTTPExposure(path="/telegram")),
        )

    def _agent(self) -> tuple[MagicMock, list[tuple[str, str]]]:
        seen: list[tuple[str, str]] = []

        async def arun(prompt: str, session_id: str = "default") -> str:
            seen.append((prompt, session_id))
            return "ok"

        agent = MagicMock()
        agent.arun = arun
        return agent, seen

    @pytest.mark.asyncio
    async def test_dispatches_with_session_id(self) -> None:
        from afm.templates import compile_template

        agent, seen = self._agent()
        compiled = compile_template("Reply to ${http:payload.message.text}")
        await dispatch_update(
            handler=TelegramHandler(),
            agent=agent,
            payload={
                "update_id": 1,
                "message": {
                    "from": {"id": 99, "is_bot": False},
                    "chat": {"id": 99, "type": "private"},
                    "text": "hi",
                },
            },
            headers={},
            compiled_prompt=compiled,
        )
        assert len(seen) == 1
        prompt, session_id = seen[0]
        assert "hi" in prompt
        assert session_id == "telegram:99:99"

    @pytest.mark.asyncio
    async def test_template_error_skips_agent(self) -> None:
        from afm.templates import compile_template

        agent, seen = self._agent()
        compiled = compile_template("Refers to ${http:payload.nope.absent}")
        await dispatch_update(
            handler=TelegramHandler(),
            agent=agent,
            payload={
                "update_id": 1,
                "message": {
                    "from": {"id": 99, "is_bot": False},
                    "chat": {"id": 99, "type": "private"},
                    "text": "hi",
                },
            },
            headers={},
            compiled_prompt=compiled,
        )
        assert seen == []

    @pytest.mark.asyncio
    async def test_agent_exception_is_logged_not_raised(self) -> None:
        async def failing_arun(prompt: str, session_id: str = "default") -> str:
            raise RuntimeError("boom")

        agent = MagicMock()
        agent.arun = failing_arun

        # Should not raise — dispatch_update logs and returns.
        await dispatch_update(
            handler=TelegramHandler(),
            agent=agent,
            payload={
                "update_id": 1,
                "message": {
                    "from": {"id": 99, "is_bot": False},
                    "chat": {"id": 99, "type": "private"},
                    "text": "hi",
                },
            },
            headers={},
            compiled_prompt=None,
        )

    @pytest.mark.asyncio
    async def test_agent_cancellation_is_not_swallowed(self) -> None:
        async def cancelled_arun(prompt: str, session_id: str = "default") -> str:
            raise asyncio.CancelledError

        agent = MagicMock()
        agent.arun = cancelled_arun

        with pytest.raises(asyncio.CancelledError):
            await dispatch_update(
                handler=TelegramHandler(),
                agent=agent,
                payload={
                    "update_id": 1,
                    "message": {
                        "from": {"id": 99, "is_bot": False},
                        "chat": {"id": 99, "type": "private"},
                        "text": "hi",
                    },
                },
                headers={},
                compiled_prompt=None,
            )


class TestRunPollingLoop:
    @pytest.mark.asyncio
    async def test_loop_stops_when_event_set(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _mock_async_client_factory(
            monkeypatch,
            [
                {"ok": True, "result": []},
                {"ok": True, "result": []},
            ],
        )

        agent = MagicMock()
        agent.arun = AsyncMock(return_value="ok")

        stop_event = asyncio.Event()
        iface = _make_telegram_polling_interface()

        async def stop_after_brief_run() -> None:
            await asyncio.sleep(0.05)
            stop_event.set()

        await asyncio.gather(
            run_polling_loop(agent, iface, stop_event=stop_event),
            stop_after_brief_run(),
        )
        # No assertion on call count — just that the loop exits cleanly.

    @pytest.mark.asyncio
    async def test_loop_dispatches_updates_to_agent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _mock_async_client_factory(
            monkeypatch,
            [
                {
                    "ok": True,
                    "result": [
                        {
                            "update_id": 1,
                            "message": {
                                "from": {"id": 99, "is_bot": False},
                                "chat": {"id": 99, "type": "private"},
                                "text": "hello",
                            },
                        }
                    ],
                },
                # Stop after this batch by returning empty forever.
                {"ok": True, "result": []},
            ],
        )

        seen: list[tuple[str, str]] = []

        async def arun(prompt: str, session_id: str = "default") -> str:
            seen.append((prompt, session_id))
            return "ok"

        agent = MagicMock()
        agent.arun = arun

        stop_event = asyncio.Event()
        iface = _make_telegram_polling_interface()

        async def stop_after_one_dispatch() -> None:
            while not seen:
                await asyncio.sleep(0.01)
            stop_event.set()

        await asyncio.gather(
            run_polling_loop(agent, iface, stop_event=stop_event),
            stop_after_one_dispatch(),
        )

        assert len(seen) >= 1
        prompt, session_id = seen[0]
        assert session_id == "telegram:99:99"

    @pytest.mark.asyncio
    async def test_loop_continues_after_poll_exception(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        call_counter = {"n": 0}

        class FlakyHandler(TelegramHandler):
            async def poll_updates(
                self, interface: PlatformChatInterface, state: dict
            ) -> tuple[list, dict]:
                call_counter["n"] += 1
                if call_counter["n"] == 1:
                    raise RuntimeError("transient")
                return [], state

        monkeypatch.setitem(
            __import__(
                "afm.interfaces.platform_chat", fromlist=["_HANDLERS"]
            )._HANDLERS,
            "telegram",
            FlakyHandler(),
        )

        agent = MagicMock()
        agent.arun = AsyncMock(return_value="ok")
        stop_event = asyncio.Event()
        iface = _make_telegram_polling_interface()

        async def stop_after_recovery() -> None:
            while call_counter["n"] < 2:
                await asyncio.sleep(0.01)
            stop_event.set()

        await asyncio.gather(
            run_polling_loop(agent, iface, stop_event=stop_event),
            stop_after_recovery(),
        )
        assert call_counter["n"] >= 2

    @pytest.mark.asyncio
    async def test_loop_filters_should_ignore_updates(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _mock_async_client_factory(
            monkeypatch,
            [
                {
                    "ok": True,
                    "result": [
                        # Bot sender — should be filtered out
                        {
                            "update_id": 1,
                            "message": {
                                "from": {"id": 99, "is_bot": True},
                                "chat": {"id": 99, "type": "private"},
                                "text": "from a bot",
                            },
                        },
                        # Real user — should reach the agent
                        {
                            "update_id": 2,
                            "message": {
                                "from": {"id": 99, "is_bot": False},
                                "chat": {"id": 99, "type": "private"},
                                "text": "from a human",
                            },
                        },
                    ],
                },
                {"ok": True, "result": []},
            ],
        )

        seen: list[tuple[str, str]] = []

        async def arun(prompt: str, session_id: str = "default") -> str:
            seen.append((prompt, session_id))
            return "ok"

        agent = MagicMock()
        agent.arun = arun

        stop_event = asyncio.Event()

        async def stop_after_human_dispatch() -> None:
            while not any("human" in p for p, _ in seen):
                await asyncio.sleep(0.01)
            stop_event.set()

        await asyncio.gather(
            run_polling_loop(
                agent, _make_telegram_polling_interface(), stop_event=stop_event
            ),
            stop_after_human_dispatch(),
        )

        # The bot-sender update should never reach the agent.
        texts = [json.loads(prompt)["message"]["text"] for prompt, _ in seen]
        assert texts == ["from a human"]

    @pytest.mark.asyncio
    async def test_non_polling_interface_raises(self) -> None:
        iface = PlatformChatInterface(
            type="platformchat",
            platform="telegram",
            mode=PlatformChatMode.NOTIFICATION,
            platform_config={"secret_token": "shh"},
            exposure=Exposure(http=HTTPExposure(path="/telegram")),
        )
        agent = MagicMock()
        with pytest.raises(ValueError, match="expected 'polling'"):
            await run_polling_loop(agent, iface)

    @pytest.mark.asyncio
    async def test_unsupported_platform_raises(self) -> None:
        # Construct a polling-mode interface for a platform that has not
        # opted into polling (slack).
        iface = PlatformChatInterface(
            type="platformchat",
            platform="slack",
            mode=PlatformChatMode.POLLING,
            platform_config={"signing_secret": "abc"},
            polling=Polling(),
        )
        agent = MagicMock()
        with pytest.raises(ValueError, match="does not support polling"):
            await run_polling_loop(agent, iface)

    @pytest.mark.asyncio
    async def test_transient_failure_recovered_within_retry_budget(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Zero backoff keeps the test snappy without changing behavior.
        monkeypatch.setattr(
            "afm.interfaces.platform_chat.DISPATCH_BACKOFF_SECONDS", 0.0
        )
        _mock_async_client_factory(
            monkeypatch,
            [
                {
                    "ok": True,
                    "result": [
                        {
                            "update_id": 1,
                            "message": {
                                "from": {"id": 99, "is_bot": False},
                                "chat": {"id": 99, "type": "private"},
                                "text": "hello",
                            },
                        }
                    ],
                },
                {"ok": True, "result": []},
            ],
        )

        attempts: list[int] = []

        async def flaky_arun(prompt: str, session_id: str = "default") -> str:
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("transient LLM blip")
            return "ok"

        agent = MagicMock()
        agent.arun = flaky_arun

        stop_event = asyncio.Event()

        async def stop_after_success() -> None:
            while len(attempts) < 2:
                await asyncio.sleep(0.01)
            stop_event.set()

        await asyncio.gather(
            run_polling_loop(
                agent,
                _make_telegram_polling_interface(),
                stop_event=stop_event,
            ),
            stop_after_success(),
        )

        # First attempt failed, second attempt succeeded — total 2 calls.
        assert len(attempts) == 2

    @pytest.mark.asyncio
    async def test_permanent_failure_dropped_after_max_attempts(
        self,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        monkeypatch.setattr(
            "afm.interfaces.platform_chat.DISPATCH_BACKOFF_SECONDS", 0.0
        )
        _mock_async_client_factory(
            monkeypatch,
            [
                {
                    "ok": True,
                    "result": [
                        {
                            "update_id": 42,
                            "message": {
                                "from": {"id": 99, "is_bot": False},
                                "chat": {"id": 777, "type": "private"},
                                "text": "permanently broken",
                            },
                        }
                    ],
                },
                {"ok": True, "result": []},
            ],
        )

        attempts: list[int] = []

        async def always_fails(prompt: str, session_id: str = "default") -> str:
            attempts.append(1)
            raise RuntimeError("permanent agent bug")

        agent = MagicMock()
        agent.arun = always_fails

        stop_event = asyncio.Event()

        async def stop_after_exhaustion() -> None:
            # Wait until MAX_DISPATCH_ATTEMPTS attempts have been made
            # and the drop log has been emitted.
            while not any("Dropping update" in r.message for r in caplog.records):
                await asyncio.sleep(0.01)
            stop_event.set()

        with caplog.at_level("ERROR"):
            await asyncio.gather(
                run_polling_loop(
                    agent,
                    _make_telegram_polling_interface(),
                    stop_event=stop_event,
                ),
                stop_after_exhaustion(),
            )

        from afm.interfaces.platform_chat import MAX_DISPATCH_ATTEMPTS

        assert len(attempts) == MAX_DISPATCH_ATTEMPTS
        drop_logs = [r for r in caplog.records if "Dropping update" in r.message]
        assert len(drop_logs) == 1
        # Drop log carries the Telegram update id without stable user/chat ids.
        rendered = drop_logs[0].getMessage()
        assert "update_id=42" in rendered
        assert "session_id" not in rendered
        assert "chat_id" not in rendered

    @pytest.mark.asyncio
    async def test_subsequent_update_processed_after_a_dropped_one(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A permanently-bad update in the middle of a batch must not stop
        # later updates from being attempted.
        monkeypatch.setattr(
            "afm.interfaces.platform_chat.DISPATCH_BACKOFF_SECONDS", 0.0
        )
        _mock_async_client_factory(
            monkeypatch,
            [
                {
                    "ok": True,
                    "result": [
                        {
                            "update_id": 1,
                            "message": {
                                "from": {"id": 99, "is_bot": False},
                                "chat": {"id": 99, "type": "private"},
                                "text": "broken",
                            },
                        },
                        {
                            "update_id": 2,
                            "message": {
                                "from": {"id": 99, "is_bot": False},
                                "chat": {"id": 99, "type": "private"},
                                "text": "good",
                            },
                        },
                    ],
                },
                {"ok": True, "result": []},
            ],
        )

        seen_prompts: list[str] = []

        async def selective_arun(prompt: str, session_id: str = "default") -> str:
            # Fail every call for "broken", succeed for "good".
            if '"broken"' in prompt:
                raise RuntimeError("permanent")
            seen_prompts.append(prompt)
            return "ok"

        agent = MagicMock()
        agent.arun = selective_arun

        stop_event = asyncio.Event()

        async def stop_after_good_dispatched() -> None:
            while not seen_prompts:
                await asyncio.sleep(0.01)
            stop_event.set()

        await asyncio.gather(
            run_polling_loop(
                agent,
                _make_telegram_polling_interface(),
                stop_event=stop_event,
            ),
            stop_after_good_dispatched(),
        )

        assert len(seen_prompts) == 1
        assert '"good"' in seen_prompts[0]

    @pytest.mark.asyncio
    async def test_interrupted_batch_does_not_advance_polling_state(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        platform_chat_module = __import__(
            "afm.interfaces.platform_chat",
            fromlist=["_HANDLERS", "_sleep_or_stop"],
        )

        class RecordingHandler(TelegramHandler):
            def __init__(self) -> None:
                self.seen_states: list[dict] = []

            async def poll_updates(
                self, interface: PlatformChatInterface, state: dict
            ) -> tuple[list, dict]:
                self.seen_states.append(dict(state))
                if len(self.seen_states) == 1:
                    return [
                        {
                            "update_id": 1,
                            "message": {
                                "from": {"id": 99, "is_bot": False},
                                "chat": {"id": 99, "type": "private"},
                                "text": "first",
                            },
                        },
                        {
                            "update_id": 2,
                            "message": {
                                "from": {"id": 99, "is_bot": False},
                                "chat": {"id": 99, "type": "private"},
                                "text": "second",
                            },
                        },
                    ], {"offset": 3}

                stop_event.set()
                return [], state

        handler = RecordingHandler()
        monkeypatch.setitem(platform_chat_module._HANDLERS, "telegram", handler)

        cleared_stop_once = False

        async def clear_stop_once(interval: float, stop: asyncio.Event) -> None:
            # Let the test observe one more poll with the loop's retained state.
            nonlocal cleared_stop_once
            if stop.is_set() and not cleared_stop_once:
                cleared_stop_once = True
                stop.clear()

        monkeypatch.setattr(platform_chat_module, "_sleep_or_stop", clear_stop_once)

        seen_prompts: list[str] = []
        stop_event = asyncio.Event()

        async def arun(prompt: str, session_id: str = "default") -> str:
            seen_prompts.append(prompt)
            stop_event.set()
            return "ok"

        agent = MagicMock()
        agent.arun = arun

        await run_polling_loop(
            agent,
            _make_telegram_polling_interface(),
            stop_event=stop_event,
        )

        assert handler.seen_states == [{}, {}]
        assert len(seen_prompts) == 1
        assert '"first"' in seen_prompts[0]
