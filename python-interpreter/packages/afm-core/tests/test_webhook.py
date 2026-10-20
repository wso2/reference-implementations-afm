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
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs

import httpx
import pytest
from afm.authentication import ClientAuthentication
from afm.exceptions import AuthenticationError
from afm.http_auth import HeaderAuth, JwtAuth, build_httpx_auth
from afm.interfaces.webhook import (
    WebSubSubscriber,
    create_webhook_app,
    verify_webhook_signature,
)
from afm.models import (
    Exposure,
    HTTPExposure,
    JSONSchema,
    Signature,
    Subscription,
    WebhookInterface,
)
from afm.parser import parse_afm
from afm.runner import AgentRunner
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from pydantic import TypeAdapter


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


class TestWebSubSubscriberAuthentication:
    @staticmethod
    def hub(statuses: list[int] | None = None):
        requests: list[httpx.Request] = []
        answers = list(statuses or [202])

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(answers.pop(0) if len(answers) > 1 else answers[0])

        return requests, httpx.MockTransport(handler)

    @staticmethod
    def subscriber(auth, transport) -> WebSubSubscriber:
        subscriber = WebSubSubscriber(
            hub="https://hub.example.com/",
            topic="https://example.com/topic",
            callback="https://agent.example.com/webhook",
            secret="hub-secret",
            auth=auth,
        )
        real_client = httpx.AsyncClient
        patcher = patch(
            "afm.interfaces.webhook.httpx.AsyncClient",
            lambda *args, **kwargs: real_client(
                *args, **{"transport": transport, **kwargs}
            ),
        )
        patcher.start()
        subscriber._patcher = patcher  # type: ignore[attr-defined]
        return subscriber

    @pytest.fixture(autouse=True)
    def _stop_patches(self):
        yield
        patch.stopall()

    @pytest.mark.parametrize(
        ("authentication", "header", "value"),
        [
            ({"type": "bearer", "token": "abc"}, "Authorization", "Bearer abc"),
            (
                {"type": "api-key", "api_key": "k", "header_name": "X-API-Key"},
                "X-API-Key",
                "k",
            ),
            (
                {"type": "basic", "username": "u", "password": "p"},
                "Authorization",
                "Basic dTpw",
            ),
        ],
    )
    async def test_the_authentication_is_sent_on_subscribe_and_unsubscribe(
        self, authentication: dict, header: str, value: str
    ) -> None:
        requests, transport = self.hub()
        auth = build_httpx_auth(
            TypeAdapter(ClientAuthentication).validate_python(authentication)
        )
        subscriber = self.subscriber(auth, transport)

        assert await subscriber.subscribe() is True
        assert await subscriber.unsubscribe() is True

        assert [r.headers[header] for r in requests] == [
            value,
            value,
        ]
        assert [parse_qs(r.content.decode())["hub.mode"] for r in requests] == [
            ["subscribe"],
            ["unsubscribe"],
        ]

    async def test_without_authentication_nothing_is_added(self) -> None:
        requests, transport = self.hub()
        subscriber = self.subscriber(None, transport)

        await subscriber.subscribe()

        assert "Authorization" not in requests[0].headers

    async def test_oauth2_renews_the_token_after_a_401_from_the_hub(self) -> None:
        tokens = iter(["old", "new"])
        token_requests: list[httpx.Request] = []

        def token_endpoint(request: httpx.Request) -> httpx.Response:
            token_requests.append(request)
            return httpx.Response(
                200, json={"access_token": next(tokens), "token_type": "Bearer"}
            )

        def hub_handler(request: httpx.Request) -> httpx.Response:
            token = request.headers["Authorization"].removeprefix("Bearer ")
            return httpx.Response(202 if token == "new" else 401)

        auth = build_httpx_auth(
            TypeAdapter(ClientAuthentication).validate_python(
                {
                    "type": "oauth2",
                    "grant_type": "client_credentials",
                    "token_url": "https://idp.example.com/token",
                    "client_id": "c",
                    "client_secret": "s",
                }
            )
        )
        auth._transport = httpx.MockTransport(token_endpoint)
        subscriber = self.subscriber(auth, httpx.MockTransport(hub_handler))

        assert await subscriber.subscribe() is True
        assert len(token_requests) == 2


class TestWebhookAppAuthentication:
    def agent_for(self, front_matter: str, source_dir: Path | None = None) -> MagicMock:
        afm = parse_afm(f"---\n{front_matter}---\n# Role\nr\n# Instructions\ni\n")
        afm.source_dir = source_dir
        agent = MagicMock(spec=AgentRunner)
        agent.name = "Agent"
        agent.description = "Agent"
        agent.afm = afm
        return agent

    SUBSCRIPTION = (
        "interfaces:\n  - type: webhook\n    subscription:\n      protocol: websub\n"
        "      hub: https://hub.example.com\n      topic: https://example.com/topic\n"
        "      callback: https://agent.example.com/webhook\n"
    )

    def test_the_subscription_authentication_reaches_the_subscriber(self) -> None:
        agent = self.agent_for(
            self.SUBSCRIPTION
            + "      authentication:\n        type: bearer\n        token: abc\n"
        )

        app = create_webhook_app(agent)

        assert isinstance(app.state.websub_subscriber.auth, HeaderAuth)

    def test_a_relative_signing_key_is_resolved_against_the_afm_directory(
        self, tmp_path: Path
    ) -> None:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        (tmp_path / "signing.pem").write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        agent = self.agent_for(
            self.SUBSCRIPTION
            + "      authentication:\n        type: jwt\n        issuer: i\n"
            "        audience: a\n        signing_key: signing.pem\n",
            tmp_path,
        )

        app = create_webhook_app(agent)

        assert isinstance(app.state.websub_subscriber.auth, JwtAuth)

    def test_an_unusable_signing_key_fails_before_any_request(
        self, tmp_path: Path
    ) -> None:
        agent = self.agent_for(
            self.SUBSCRIPTION
            + "      authentication:\n        type: jwt\n        issuer: i\n"
            "        audience: a\n        signing_key: missing.pem\n",
            tmp_path,
        )

        with pytest.raises(AuthenticationError, match="cannot be read"):
            create_webhook_app(agent)

    def test_no_authentication_means_no_auth(self) -> None:
        app = create_webhook_app(self.agent_for(self.SUBSCRIPTION))
        assert app.state.websub_subscriber.auth is None
