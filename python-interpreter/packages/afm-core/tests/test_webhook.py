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

import hashlib
import hmac
import json
import asyncio
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from afm.runner import AgentRunner
from afm.interfaces.webhook import (
    WebSubSubscriber,
    create_webhook_app,
    get_provider_session_id,
    verify_webhook_signature,
)
from afm.interfaces.providers.slack import (
    get_slack_session_id,
    should_ignore_slack_event,
    verify_slack_request_signature,
)
from afm.models import (
    Exposure,
    HTTPExposure,
    JSONSchema,
    Signature,
    Subscription,
    WebhookInterface,
)


@pytest.fixture
def mock_webhook_agent() -> MagicMock:
    agent = MagicMock(spec=AgentRunner)
    agent.name = "Webhook Test Agent"
    agent.description = "A test agent for webhook testing"
    agent.afm = MagicMock()
    agent.afm.metadata = MagicMock()
    agent.afm.metadata.version = "1.0.0"

    # Configure webhook interface
    interface = WebhookInterface(
        type="webhook",
        prompt="Received event: ${http:payload.event} from ${http:header.User-Agent}",
        signature=Signature(
            input=JSONSchema(type="object"),
            output=JSONSchema(type="string"),
        ),
        subscription=Subscription(
            protocol="websub",
            hub="https://hub.example.com",
            topic="https://example.com/events",
            secret="test-secret-123",
        ),
        exposure=Exposure(http=HTTPExposure(path="/webhook")),
    )
    agent.afm.metadata.interfaces = [interface]

    # Mock async run
    async def mock_arun(input_data: str, session_id: str = "default") -> str:
        return f"Processed: {input_data[:50]}..."

    agent.arun = mock_arun
    return agent


@pytest.fixture
def mock_webhook_agent_no_template() -> MagicMock:
    agent = MagicMock(spec=AgentRunner)
    agent.name = "No Template Agent"
    agent.description = "Agent without prompt template"
    agent.afm = MagicMock()
    agent.afm.metadata = MagicMock()
    agent.afm.metadata.version = "1.0.0"

    # Configure webhook interface without prompt
    interface = WebhookInterface(
        type="webhook",
        prompt=None,
        signature=Signature(
            input=JSONSchema(type="object"),
            output=JSONSchema(type="string"),
        ),
        subscription=Subscription(
            protocol="websub",
        ),
        exposure=Exposure(http=HTTPExposure(path="/webhook")),
    )
    agent.afm.metadata.interfaces = [interface]

    async def mock_arun(input_data: str, session_id: str = "default") -> str:
        return f"Raw payload: {input_data[:30]}..."

    agent.arun = mock_arun
    return agent


@pytest.fixture
def mock_webhook_agent_no_secret() -> MagicMock:
    agent = MagicMock(spec=AgentRunner)
    agent.name = "No Secret Agent"
    agent.description = "Agent without webhook secret"
    agent.afm = MagicMock()
    agent.afm.metadata = MagicMock()
    agent.afm.metadata.version = "1.0.0"

    interface = WebhookInterface(
        type="webhook",
        prompt="Event: ${http:payload.type}",
        signature=Signature(
            input=JSONSchema(type="object"),
            output=JSONSchema(type="string"),
        ),
        subscription=Subscription(
            protocol="websub",
            secret=None,
        ),
        exposure=Exposure(http=HTTPExposure(path="/webhook")),
    )
    agent.afm.metadata.interfaces = [interface]

    async def mock_arun(input_data: str, session_id: str = "default") -> str:
        return f"Processed: {input_data}"

    agent.arun = mock_arun
    return agent


@pytest.fixture
def mock_provider_webhook_agent_async() -> tuple[MagicMock, asyncio.Event, list[str]]:
    agent = MagicMock(spec=AgentRunner)
    agent.name = "Provider Async Agent"
    agent.description = "Provider webhook agent with background acknowledgement"
    agent.afm = MagicMock()
    agent.afm.metadata = MagicMock()
    agent.afm.metadata.version = "1.0.0"

    interface = WebhookInterface(
        type="webhook",
        prompt="Async reply to ${http:payload.message.text}",
        signature=Signature(input=JSONSchema(type="object")),
        subscription=Subscription(
            protocol="provider",
            provider="slack",
            provider_config={"signing_secret": "test-secret"},
        ),
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


class TestVerifyWebhookSignature:
    def test_valid_sha256_signature(self) -> None:
        body = b'{"event": "test"}'
        secret = "my-secret"
        expected_sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

        result = verify_webhook_signature(
            body=body,
            signature_header=f"sha256={expected_sig}",
            secret=secret,
        )

        assert result is True

    def test_valid_signature_without_prefix(self) -> None:
        body = b'{"event": "test"}'
        secret = "my-secret"
        expected_sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

        result = verify_webhook_signature(
            body=body,
            signature_header=expected_sig,
            secret=secret,
        )

        assert result is True

    def test_invalid_signature(self) -> None:
        body = b'{"event": "test"}'
        secret = "my-secret"

        result = verify_webhook_signature(
            body=body,
            signature_header="sha256=invalid-signature",
            secret=secret,
        )

        assert result is False

    def test_missing_signature_header(self) -> None:
        body = b'{"event": "test"}'
        secret = "my-secret"

        result = verify_webhook_signature(
            body=body,
            signature_header=None,
            secret=secret,
        )

        assert result is False

    def test_sha1_signature(self) -> None:
        body = b'{"event": "test"}'
        secret = "my-secret"
        expected_sig = hmac.new(secret.encode(), body, hashlib.sha1).hexdigest()

        result = verify_webhook_signature(
            body=body,
            signature_header=f"sha1={expected_sig}",
            secret=secret,
            algorithm="sha1",
        )

        assert result is True


class TestCreateWebhookApp:
    def test_creates_fastapi_app(self, mock_webhook_agent: MagicMock) -> None:
        app = create_webhook_app(mock_webhook_agent, auto_subscribe=False)

        assert app is not None
        assert "Webhook" in app.title

    def test_health_endpoint(self, mock_webhook_agent: MagicMock) -> None:
        app = create_webhook_app(mock_webhook_agent, auto_subscribe=False)
        client = TestClient(app)

        response = client.get("/health")

        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_webhook_accepts_payload(self, mock_webhook_agent: MagicMock) -> None:
        app = create_webhook_app(
            mock_webhook_agent,
            auto_subscribe=False,
            verify_signatures=False,
        )
        client = TestClient(app)

        response = client.post(
            "/webhook",
            json={"event": "test_event", "data": "test_data"},
            headers={"User-Agent": "TestClient/1.0"},
        )

        assert response.status_code == 202
        data = response.json()
        assert data["status"] == "accepted"

    def test_webhook_with_signature_verification(
        self, mock_webhook_agent: MagicMock
    ) -> None:
        app = create_webhook_app(
            mock_webhook_agent,
            auto_subscribe=False,
            verify_signatures=True,
        )
        client = TestClient(app)

        payload = {"event": "test_event"}
        body = json.dumps(payload).encode()
        secret = "test-secret-123"
        signature = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

        response = client.post(
            "/webhook",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Hub-Signature-256": f"sha256={signature}",
                "User-Agent": "TestClient/1.0",
            },
        )

        assert response.status_code == 202

    def test_webhook_rejects_invalid_signature(
        self, mock_webhook_agent: MagicMock
    ) -> None:
        app = create_webhook_app(
            mock_webhook_agent,
            auto_subscribe=False,
            verify_signatures=True,
        )
        client = TestClient(app)

        response = client.post(
            "/webhook",
            json={"event": "test_event"},
            headers={"X-Hub-Signature-256": "sha256=invalid"},
        )

        assert response.status_code == 401
        assert "Invalid signature" in response.json()["detail"]

    def test_webhook_without_template_uses_raw_payload(
        self, mock_webhook_agent_no_template: MagicMock
    ) -> None:
        app = create_webhook_app(
            mock_webhook_agent_no_template,
            auto_subscribe=False,
            verify_signatures=False,
        )
        client = TestClient(app)

        response = client.post(
            "/webhook",
            json={"type": "notification", "message": "Hello"},
        )

        assert response.status_code == 202
        data = response.json()
        assert data["status"] == "accepted"

    def test_webhook_invalid_json_returns_400(
        self, mock_webhook_agent: MagicMock
    ) -> None:
        app = create_webhook_app(
            mock_webhook_agent,
            auto_subscribe=False,
            verify_signatures=False,
        )
        client = TestClient(app)

        response = client.post(
            "/webhook",
            content=b"not json",
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 400
        assert "Invalid JSON" in response.json()["detail"]

    def test_webhook_agent_error_still_returns_202(
        self, mock_webhook_agent: MagicMock
    ) -> None:

        async def failing_arun(input_data: str, session_id: str = "default") -> str:
            raise Exception("Agent failed")

        mock_webhook_agent.arun = failing_arun

        app = create_webhook_app(
            mock_webhook_agent,
            auto_subscribe=False,
            verify_signatures=False,
        )
        client = TestClient(app)

        response = client.post(
            "/webhook",
            json={"event": "test"},
        )

        # Fire-and-forget: always returns 202, agent errors are logged in background
        assert response.status_code == 202
        assert response.json()["status"] == "accepted"

    @pytest.mark.asyncio
    async def test_provider_webhook_without_explicit_output_returns_ack_and_runs_in_background(
        self,
        mock_provider_webhook_agent_async: tuple[MagicMock, asyncio.Event, list[str]],
    ) -> None:
        agent, ran, seen_prompts = mock_provider_webhook_agent_async
        app = create_webhook_app(
            agent,
            auto_subscribe=False,
            verify_signatures=False,
        )

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/slack",
                json={"message": {"text": "hello async"}},
                headers={"User-Agent": "ProviderTest/1.0"},
            )

        assert response.status_code == 200
        assert response.content == b""
        await asyncio.wait_for(ran.wait(), timeout=2.0)
        assert seen_prompts == ["Async reply to hello async"]

    def test_provider_webhook_does_not_register_websub_verification_endpoint(
        self,
        mock_provider_webhook_agent_async: tuple[MagicMock, asyncio.Event, list[str]],
    ) -> None:
        agent, _, _ = mock_provider_webhook_agent_async
        app = create_webhook_app(
            agent,
            auto_subscribe=False,
            verify_signatures=False,
        )
        client = TestClient(app)

        response = client.get(
            "/slack",
            params={
                "hub.mode": "subscribe",
                "hub.topic": "https://example.com/events",
                "hub.challenge": "test-challenge",
            },
        )

        assert response.status_code == 405


class TestWebSubVerification:
    def test_websub_verification_returns_challenge(
        self, mock_webhook_agent: MagicMock
    ) -> None:
        app = create_webhook_app(
            mock_webhook_agent,
            auto_subscribe=False,
        )
        # Manually set up subscriber for testing
        app.state.websub_subscriber = WebSubSubscriber(
            hub="https://hub.example.com",
            topic="https://example.com/events",
            callback="http://localhost/webhook",
        )

        client = TestClient(app)

        response = client.get(
            "/webhook",
            params={
                "hub.mode": "subscribe",
                "hub.topic": "https://example.com/events",
                "hub.challenge": "test-challenge-abc",
            },
        )

        assert response.status_code == 200
        assert response.text == "test-challenge-abc"

    def test_websub_verification_fails_wrong_topic(
        self, mock_webhook_agent: MagicMock
    ) -> None:
        app = create_webhook_app(
            mock_webhook_agent,
            auto_subscribe=False,
        )
        app.state.websub_subscriber = WebSubSubscriber(
            hub="https://hub.example.com",
            topic="https://example.com/events",
            callback="http://localhost/webhook",
        )

        client = TestClient(app)

        response = client.get(
            "/webhook",
            params={
                "hub.mode": "subscribe",
                "hub.topic": "https://example.com/wrong-topic",
                "hub.challenge": "test-challenge",
            },
        )

        assert response.status_code == 404

    def test_websub_verification_no_subscriber(
        self, mock_webhook_agent_no_secret: MagicMock
    ) -> None:
        app = create_webhook_app(
            mock_webhook_agent_no_secret,
            auto_subscribe=False,
        )
        # Don't set up subscriber
        app.state.websub_subscriber = None

        client = TestClient(app)

        response = client.get(
            "/webhook",
            params={
                "hub.mode": "subscribe",
                "hub.topic": "https://example.com/topic",
                "hub.challenge": "test-challenge",
            },
        )

        assert response.status_code == 404


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


class TestGetProviderSessionId:
    def test_slack_delegates_to_slack_session_id(self) -> None:
        payload = {
            "type": "event_callback",
            "team_id": "T123",
            "event": {"type": "message", "channel": "C1", "ts": "1234.5678"},
        }
        result = get_provider_session_id("slack", payload)
        assert result == "slack:T123:C1:1234.5678"

    def test_unknown_provider_returns_default(self) -> None:
        assert get_provider_session_id("unknown_provider", {}) == "default"

    def test_none_provider_returns_default(self) -> None:
        assert get_provider_session_id(None, {}) == "default"


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
