# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from __future__ import annotations

import hashlib
import hmac
import json
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from afm.runner import AgentRunner
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

    def test_webhook_processes_payload(self, mock_webhook_agent: MagicMock) -> None:
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

        assert response.status_code == 200
        data = response.json()
        assert "result" in data
        # The template should have substituted the values
        assert "Processed:" in data["result"]

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

        assert response.status_code == 200

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

        assert response.status_code == 200
        data = response.json()
        assert "Raw payload:" in data["result"]

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

    def test_webhook_agent_error_returns_500(
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

        assert response.status_code == 500
        assert "Internal server error" in response.json()["detail"]


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
