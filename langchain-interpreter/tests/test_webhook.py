# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Tests for webhook interface handler."""

from __future__ import annotations

import hashlib
import hmac
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from langchain_interpreter import (
    JSONSchema,
    Signature,
    Subscription,
    WebhookInterface,
)
from langchain_interpreter.agent import Agent
from langchain_interpreter.interfaces.webhook import (
    WebSubSubscriber,
    create_webhook_app,
    verify_webhook_signature,
)
from langchain_interpreter.models import Exposure, HTTPExposure


@pytest.fixture
def mock_webhook_agent() -> MagicMock:
    """Create a mock agent with webhook interface for testing."""
    agent = MagicMock(spec=Agent)
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
    """Create a mock agent with webhook interface but no prompt template."""
    agent = MagicMock(spec=Agent)
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
    """Create a mock agent with webhook interface but no secret."""
    agent = MagicMock(spec=Agent)
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
    """Tests for verify_webhook_signature function."""

    def test_valid_sha256_signature(self) -> None:
        """Test verification with valid SHA256 signature."""
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
        """Test verification with signature without algorithm prefix."""
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
        """Test verification fails with invalid signature."""
        body = b'{"event": "test"}'
        secret = "my-secret"

        result = verify_webhook_signature(
            body=body,
            signature_header="sha256=invalid-signature",
            secret=secret,
        )

        assert result is False

    def test_missing_signature_header(self) -> None:
        """Test verification fails when signature header is missing."""
        body = b'{"event": "test"}'
        secret = "my-secret"

        result = verify_webhook_signature(
            body=body,
            signature_header=None,
            secret=secret,
        )

        assert result is False

    def test_sha1_signature(self) -> None:
        """Test verification with SHA1 signature."""
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


class TestWebSubSubscriber:
    """Tests for WebSubSubscriber class."""

    def test_verify_challenge_subscribe(self) -> None:
        """Test challenge verification for subscription."""
        subscriber = WebSubSubscriber(
            hub="https://hub.example.com",
            topic="https://example.com/topic",
            callback="https://myapp.com/webhook",
        )

        result = subscriber.verify_challenge(
            mode="subscribe",
            topic="https://example.com/topic",
            challenge="test-challenge-123",
        )

        assert result == "test-challenge-123"
        assert subscriber.is_verified is True

    def test_verify_challenge_unsubscribe(self) -> None:
        """Test challenge verification for unsubscription."""
        subscriber = WebSubSubscriber(
            hub="https://hub.example.com",
            topic="https://example.com/topic",
            callback="https://myapp.com/webhook",
        )
        subscriber._verified = True  # Simulate already verified

        result = subscriber.verify_challenge(
            mode="unsubscribe",
            topic="https://example.com/topic",
            challenge="test-challenge-456",
        )

        assert result == "test-challenge-456"
        assert subscriber.is_verified is False

    def test_verify_challenge_topic_mismatch(self) -> None:
        """Test challenge verification fails on topic mismatch."""
        subscriber = WebSubSubscriber(
            hub="https://hub.example.com",
            topic="https://example.com/topic",
            callback="https://myapp.com/webhook",
        )

        result = subscriber.verify_challenge(
            mode="subscribe",
            topic="https://example.com/different-topic",
            challenge="test-challenge",
        )

        assert result is None
        assert subscriber.is_verified is False


class TestCreateWebhookApp:
    """Tests for create_webhook_app function."""

    def test_creates_fastapi_app(self, mock_webhook_agent: MagicMock) -> None:
        """Test that a FastAPI app is created."""
        app = create_webhook_app(mock_webhook_agent, auto_subscribe=False)

        assert app is not None
        assert "Webhook" in app.title

    def test_health_endpoint(self, mock_webhook_agent: MagicMock) -> None:
        """Test that GET /health returns ok."""
        app = create_webhook_app(mock_webhook_agent, auto_subscribe=False)
        client = TestClient(app)

        response = client.get("/health")

        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_webhook_processes_payload(self, mock_webhook_agent: MagicMock) -> None:
        """Test that POST /webhook processes the payload."""
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
        """Test that webhook verifies signature when configured."""
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
        """Test that webhook rejects invalid signature."""
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
        """Test that webhook uses raw payload when no template is configured."""
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
        """Test that invalid JSON returns 400."""
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
        """Test that agent errors return 500."""

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
        assert "Agent failed" in response.json()["detail"]

    def test_webhook_no_secret_skips_verification(
        self, mock_webhook_agent_no_secret: MagicMock
    ) -> None:
        """Test that webhook skips verification when no secret is configured."""
        app = create_webhook_app(
            mock_webhook_agent_no_secret,
            auto_subscribe=False,
            verify_signatures=True,  # Enabled but no secret
        )
        client = TestClient(app)

        # Should work without signature since no secret is configured
        response = client.post(
            "/webhook",
            json={"type": "test_type"},
        )

        assert response.status_code == 200


class TestWebSubVerification:
    """Tests for WebSub verification endpoint."""

    def test_websub_verification_returns_challenge(
        self, mock_webhook_agent: MagicMock
    ) -> None:
        """Test that WebSub verification returns the challenge."""
        app = create_webhook_app(
            mock_webhook_agent,
            auto_subscribe=False,  # Disable auto-subscribe for testing
        )
        # Manually set up subscriber for testing
        from langchain_interpreter.interfaces.webhook import WebSubSubscriber

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
        """Test that WebSub verification fails for wrong topic."""
        app = create_webhook_app(
            mock_webhook_agent,
            auto_subscribe=False,
        )
        from langchain_interpreter.interfaces.webhook import WebSubSubscriber

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
        """Test that verification fails when no subscriber is configured."""
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


class TestCustomPath:
    """Tests for custom webhook paths."""

    def test_custom_path_from_interface(self, mock_webhook_agent: MagicMock) -> None:
        """Test that custom path from interface is used."""
        # Modify the interface to use a custom path
        mock_webhook_agent.afm.metadata.interfaces[0].exposure = Exposure(
            http=HTTPExposure(path="/custom/hook")
        )

        app = create_webhook_app(
            mock_webhook_agent,
            auto_subscribe=False,
            verify_signatures=False,
        )
        client = TestClient(app)

        # Default path should not work
        response = client.post("/webhook", json={"event": "test"})
        assert response.status_code == 404

        # Custom path should work
        response = client.post("/custom/hook", json={"event": "test"})
        assert response.status_code == 200

    def test_custom_path_override(self, mock_webhook_agent: MagicMock) -> None:
        """Test that path can be overridden via parameter."""
        app = create_webhook_app(
            mock_webhook_agent,
            auto_subscribe=False,
            verify_signatures=False,
            path="/api/events",
        )
        client = TestClient(app)

        # Interface path should not work
        response = client.post("/webhook", json={"event": "test"})
        assert response.status_code == 404

        # Override path should work
        response = client.post("/api/events", json={"event": "test"})
        assert response.status_code == 200


class TestWebSubSubscriberAsync:
    """Async tests for WebSubSubscriber."""

    @pytest.mark.asyncio
    async def test_subscribe_sends_request(self) -> None:
        """Test that subscribe sends request to hub."""
        subscriber = WebSubSubscriber(
            hub="https://hub.example.com",
            topic="https://example.com/topic",
            callback="https://myapp.com/webhook",
            secret="my-secret",
        )

        with patch("httpx.AsyncClient") as mock_client:
            mock_response = MagicMock()
            mock_response.status_code = 202

            mock_instance = AsyncMock()
            mock_instance.post = AsyncMock(return_value=mock_response)
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=None)
            mock_client.return_value = mock_instance

            result = await subscriber.subscribe()

            assert result is True
            mock_instance.post.assert_called_once()
            call_args = mock_instance.post.call_args
            assert call_args[0][0] == "https://hub.example.com"

    @pytest.mark.asyncio
    async def test_subscribe_handles_failure(self) -> None:
        """Test that subscribe handles failures gracefully."""
        subscriber = WebSubSubscriber(
            hub="https://hub.example.com",
            topic="https://example.com/topic",
            callback="https://myapp.com/webhook",
        )

        with patch("httpx.AsyncClient") as mock_client:
            mock_response = MagicMock()
            mock_response.status_code = 500
            mock_response.text = "Internal Server Error"

            mock_instance = AsyncMock()
            mock_instance.post = AsyncMock(return_value=mock_response)
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=None)
            mock_client.return_value = mock_instance

            result = await subscriber.subscribe()

            assert result is False

    @pytest.mark.asyncio
    async def test_unsubscribe_sends_request(self) -> None:
        """Test that unsubscribe sends request to hub."""
        subscriber = WebSubSubscriber(
            hub="https://hub.example.com",
            topic="https://example.com/topic",
            callback="https://myapp.com/webhook",
        )

        with patch("httpx.AsyncClient") as mock_client:
            mock_response = MagicMock()
            mock_response.status_code = 202

            mock_instance = AsyncMock()
            mock_instance.post = AsyncMock(return_value=mock_response)
            mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
            mock_instance.__aexit__ = AsyncMock(return_value=None)
            mock_client.return_value = mock_instance

            result = await subscriber.unsubscribe()

            assert result is True
            call_args = mock_instance.post.call_args
            data = call_args[1]["data"]
            assert data["hub.mode"] == "unsubscribe"
