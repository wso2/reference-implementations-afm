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

import asyncio
import hashlib
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from pydantic import ValidationError

from afm.interfaces.platform_chat import (
    create_platform_chat_app,
    get_platform_handler,
    get_platform_session_id,
    validate_platform_chat_interface_schema,
)
from afm.interfaces.platform_chat.gchat import (
    GChatConfig,
    GChatHandler,
    get_gchat_session_id,
    should_ignore_gchat_event,
    verify_gchat_request_token,
)
from afm.interfaces.platform_chat.slack import (
    SlackConfig,
    SlackHandler,
    get_slack_session_id,
    should_ignore_slack_event,
    verify_slack_request_signature,
)
from afm.models import (
    Exposure,
    HTTPExposure,
    JSONSchema,
    PlatformChatInterface,
    PlatformChatMode,
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
        platform_config={"verification_token": "test-gchat-token"},
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
        platform_config={"verification_token": "test-gchat-token"},
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
        assert verify_slack_request_signature(
            body,
            timestamp=self.TIMESTAMP,
            signature_header=sig,
            signing_secret=self.SIGNING_SECRET,
            current_time=int(self.TIMESTAMP),
        ) is True

    def test_invalid_signature(self) -> None:
        body = b'{"event":"test"}'
        assert verify_slack_request_signature(
            body,
            timestamp=self.TIMESTAMP,
            signature_header="v0=bad",
            signing_secret=self.SIGNING_SECRET,
            current_time=int(self.TIMESTAMP),
        ) is False

    def test_missing_timestamp(self) -> None:
        body = b'{"event":"test"}'
        sig = self._make_signature(body)
        assert verify_slack_request_signature(
            body,
            timestamp=None,
            signature_header=sig,
            signing_secret=self.SIGNING_SECRET,
        ) is False

    def test_missing_signature_header(self) -> None:
        body = b'{"event":"test"}'
        assert verify_slack_request_signature(
            body,
            timestamp=self.TIMESTAMP,
            signature_header=None,
            signing_secret=self.SIGNING_SECRET,
        ) is False

    def test_non_numeric_timestamp(self) -> None:
        body = b'{"event":"test"}'
        sig = self._make_signature(body, "not-a-number")
        assert verify_slack_request_signature(
            body,
            timestamp="not-a-number",
            signature_header=sig,
            signing_secret=self.SIGNING_SECRET,
        ) is False

    def test_expired_timestamp(self) -> None:
        body = b'{"event":"test"}'
        old_ts = "1000000000"
        sig = self._make_signature(body, old_ts)
        assert verify_slack_request_signature(
            body,
            timestamp=old_ts,
            signature_header=sig,
            signing_secret=self.SIGNING_SECRET,
            current_time=1000000000 + 60 * 5 + 1,
        ) is False

    def test_timestamp_within_tolerance(self) -> None:
        body = b'{"event":"test"}'
        ts = "1000000000"
        sig = self._make_signature(body, ts)
        assert verify_slack_request_signature(
            body,
            timestamp=ts,
            signature_header=sig,
            signing_secret=self.SIGNING_SECRET,
            current_time=1000000000 + 60 * 5,
        ) is True

    def test_wrong_secret(self) -> None:
        body = b'{"event":"test"}'
        sig = self._make_signature(body)
        assert verify_slack_request_signature(
            body,
            timestamp=self.TIMESTAMP,
            signature_header=sig,
            signing_secret="wrong-secret",
            current_time=int(self.TIMESTAMP),
        ) is False


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
        assert should_ignore_slack_event(
            {"type": "event_callback", "event": "not-a-dict"}
        ) is True

    def test_message_event_not_ignored(self) -> None:
        assert should_ignore_slack_event({
            "type": "event_callback",
            "event": {"type": "message"},
        }) is False

    def test_app_mention_event_not_ignored(self) -> None:
        assert should_ignore_slack_event({
            "type": "event_callback",
            "event": {"type": "app_mention"},
        }) is False

    def test_unknown_event_type_ignored(self) -> None:
        assert should_ignore_slack_event({
            "type": "event_callback",
            "event": {"type": "reaction_added"},
        }) is True

    def test_bot_message_ignored(self) -> None:
        assert should_ignore_slack_event({
            "type": "event_callback",
            "event": {"type": "message", "bot_id": "B123"},
        }) is True

    def test_own_app_message_ignored(self) -> None:
        assert should_ignore_slack_event({
            "type": "event_callback",
            "api_app_id": "A111",
            "event": {"type": "message", "app_id": "A111"},
        }) is True

    def test_other_app_message_not_ignored(self) -> None:
        assert should_ignore_slack_event({
            "type": "event_callback",
            "api_app_id": "A111",
            "event": {"type": "message", "app_id": "A222"},
        }) is False

    def test_message_changed_subtype_ignored(self) -> None:
        assert should_ignore_slack_event({
            "type": "event_callback",
            "event": {"type": "message", "subtype": "message_changed"},
        }) is True

    def test_message_deleted_subtype_ignored(self) -> None:
        assert should_ignore_slack_event({
            "type": "event_callback",
            "event": {"type": "message", "subtype": "message_deleted"},
        }) is True

    def test_bot_message_subtype_ignored(self) -> None:
        assert should_ignore_slack_event({
            "type": "event_callback",
            "event": {"type": "message", "subtype": "bot_message"},
        }) is True

    def test_message_replied_subtype_ignored(self) -> None:
        assert should_ignore_slack_event({
            "type": "event_callback",
            "event": {"type": "message", "subtype": "message_replied"},
        }) is True

    def test_unknown_subtype_not_ignored(self) -> None:
        assert should_ignore_slack_event({
            "type": "event_callback",
            "event": {"type": "message", "subtype": "file_share"},
        }) is False


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
            "message": {"thread": {"name": "spaces/AAAA/threads/DDDD"}},
        }
        result = get_platform_session_id("gchat", payload)
        assert result == "gchat:spaces/AAAA:spaces/AAAA/threads/DDDD"

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


class TestVerifyGChatRequestToken:
    def test_valid_token(self) -> None:
        payload = {"type": "MESSAGE", "token": "my-token"}
        assert verify_gchat_request_token(payload, "my-token") is True

    def test_invalid_token(self) -> None:
        payload = {"type": "MESSAGE", "token": "wrong-token"}
        assert verify_gchat_request_token(payload, "my-token") is False

    def test_missing_token(self) -> None:
        payload = {"type": "MESSAGE"}
        assert verify_gchat_request_token(payload, "my-token") is False

    def test_non_string_token(self) -> None:
        payload = {"type": "MESSAGE", "token": 12345}
        assert verify_gchat_request_token(payload, "my-token") is False

    def test_non_dict_payload(self) -> None:
        assert verify_gchat_request_token("not a dict", "my-token") is False


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
    def test_space_and_thread(self) -> None:
        payload = {
            "type": "MESSAGE",
            "space": {"name": "spaces/AAAA"},
            "message": {"thread": {"name": "spaces/AAAA/threads/DDDD"}},
        }
        assert (
            get_gchat_session_id(payload)
            == "gchat:spaces/AAAA:spaces/AAAA/threads/DDDD"
        )

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
        mock_gchat_notification_agent: tuple[
            MagicMock, asyncio.Event, list[str]
        ],
    ) -> None:
        agent, ran, seen_prompts = mock_gchat_notification_agent
        app = create_platform_chat_app(agent, verify_signatures=False)

        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
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
        async with AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
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
        mock_gchat_notification_agent: tuple[
            MagicMock, asyncio.Event, list[str]
        ],
    ) -> None:
        agent, _, _ = mock_gchat_notification_agent
        app = create_platform_chat_app(agent, verify_signatures=False)

        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            response = await client.post(
                "/gchat",
                json={"type": "REMOVED_FROM_SPACE"},
            )

        assert response.status_code == 200
        assert response.json() == {}

    @pytest.mark.asyncio
    async def test_gchat_ignores_bot_sender(
        self,
        mock_gchat_notification_agent: tuple[
            MagicMock, asyncio.Event, list[str]
        ],
    ) -> None:
        agent, _, _ = mock_gchat_notification_agent
        app = create_platform_chat_app(agent, verify_signatures=False)

        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
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
    async def test_gchat_verification_rejects_bad_token(
        self,
        mock_gchat_notification_agent: tuple[
            MagicMock, asyncio.Event, list[str]
        ],
    ) -> None:
        agent, _, _ = mock_gchat_notification_agent
        app = create_platform_chat_app(agent, verify_signatures=True)

        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            response = await client.post(
                "/gchat",
                json={
                    "type": "MESSAGE",
                    "token": "wrong-token",
                    "message": {"text": "hi"},
                },
            )

        assert response.status_code == 401
        assert "Invalid GChat verification token" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_gchat_verification_accepts_valid_token(
        self,
        mock_gchat_notification_agent: tuple[
            MagicMock, asyncio.Event, list[str]
        ],
    ) -> None:
        agent, ran, _ = mock_gchat_notification_agent
        app = create_platform_chat_app(agent, verify_signatures=True)

        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport, base_url="http://test"
        ) as client:
            response = await client.post(
                "/gchat",
                json={
                    "type": "MESSAGE",
                    "token": "test-gchat-token",
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
        mock_gchat_notification_agent: tuple[
            MagicMock, asyncio.Event, list[str]
        ],
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
    def test_valid_config(self) -> None:
        config = GChatConfig.model_validate({"verification_token": "abc"})
        assert config.verification_token == "abc"

    def test_unknown_field_rejected(self) -> None:
        with pytest.raises(ValidationError) as exc_info:
            GChatConfig.model_validate({"verifcation_token": "abc"})
        assert "verifcation_token" in str(exc_info.value)

    def test_wrong_type_rejected(self) -> None:
        with pytest.raises(ValidationError):
            GChatConfig.model_validate({"verification_token": 123})


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
        iface = self._interface("gchat", {"verifcation_token": "abc"})
        with pytest.raises(ValidationError):
            validate_platform_chat_interface_schema(iface)
