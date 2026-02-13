# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from afm.runner import AgentRunner
from afm.interfaces.web_chat import create_webchat_app
from afm.models import JSONSchema, Signature


@pytest.fixture
def mock_agent() -> MagicMock:
    agent = MagicMock(spec=AgentRunner)
    agent.name = "Test Agent"
    agent.description = "A test agent for unit testing"
    agent.afm = MagicMock()
    agent.afm.metadata = MagicMock()
    agent.afm.metadata.version = "1.0.0"
    agent.afm.metadata.icon_url = None
    agent.afm.metadata.interfaces = None

    # Default string signature
    agent.signature = Signature(
        input=JSONSchema(type="string"),
        output=JSONSchema(type="string"),
    )

    # Mock async run
    async def mock_arun(input_data: str, session_id: str = "default") -> str:
        return f"Response to: {input_data}"

    agent.arun = mock_arun
    return agent


@pytest.fixture
def mock_agent_with_object_output() -> MagicMock:
    agent = MagicMock(spec=AgentRunner)
    agent.name = "Object Output Agent"
    agent.description = "Returns structured data"
    agent.afm = MagicMock()
    agent.afm.metadata = MagicMock()
    agent.afm.metadata.version = "1.0.0"
    agent.afm.metadata.icon_url = None
    agent.afm.metadata.interfaces = None

    # Object output signature
    agent.signature = Signature(
        input=JSONSchema(type="string"),
        output=JSONSchema(
            type="object",
            properties={
                "response": JSONSchema(type="string"),
                "confidence": JSONSchema(type="number"),
            },
        ),
    )

    # Mock async run returning dict
    async def mock_arun(input_data: str, session_id: str = "default") -> dict:
        return {"response": f"Response to: {input_data}", "confidence": 0.95}

    agent.arun = mock_arun
    return agent


class TestStringChat:
    def test_chat_endpoint_responds(self, mock_agent: MagicMock) -> None:
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.post(
            "/chat",
            json="Hello!",
        )

        assert response.status_code == 200
        assert response.text == "Response to: Hello!"

    def test_chat_uses_session_id_header(self, mock_agent: MagicMock) -> None:
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        # Track session IDs
        sessions_used: list[str] = []

        async def tracking_arun(input_data: str, session_id: str = "default") -> str:
            sessions_used.append(session_id)
            return f"Response: {input_data}"

        mock_agent.arun = tracking_arun

        # First request without session
        client.post(
            "/chat",
            content="msg1",
            headers={"Content-Type": "text/plain"},
        )

        # Second request with session
        client.post(
            "/chat",
            content="msg2",
            headers={"X-Session-Id": "my-session-123"},
        )

        assert sessions_used[0] == "default"
        assert sessions_used[1] == "my-session-123"

    def test_chat_empty_message_returns_400(self, mock_agent: MagicMock) -> None:
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.post(
            "/chat",
            content="   ",
            headers={"Content-Type": "text/plain"},
        )

        assert response.status_code == 400

    def test_chat_invalid_json_returns_400(self, mock_agent: MagicMock) -> None:
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.post(
            "/chat",
            content="not json",
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 400

    def test_chat_json_string_accepted(self, mock_agent: MagicMock) -> None:
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.post(
            "/chat",
            json="Hello!",
        )

        assert response.status_code == 200
        assert response.text == "Response to: Hello!"

    def test_chat_json_object_rejected(self, mock_agent: MagicMock) -> None:
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.post(
            "/chat",
            json={"message": "Hello!"},
        )

        assert response.status_code == 400

    def test_chat_agent_error_returns_500(self, mock_agent: MagicMock) -> None:
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        async def failing_arun(input_data: str, session_id: str = "default") -> str:
            raise Exception("Agent failed")

        mock_agent.arun = failing_arun

        response = client.post(
            "/chat",
            json="Hello!",
        )

        assert response.status_code == 500
        data = response.json()
        assert data["detail"] == "Internal server error"


class TestObjectOutputChat:
    def test_object_output_returned(
        self, mock_agent_with_object_output: MagicMock
    ) -> None:
        app = create_webchat_app(mock_agent_with_object_output)
        client = TestClient(app)

        response = client.post(
            "/chat",
            json="Hello!",
        )

        assert response.status_code == 200
        data = response.json()
        assert data["response"] == "Response to: Hello!"
        assert data["confidence"] == 0.95


class TestObjectInputChat:
    def test_object_input_rejects_text_plain(self, mock_agent: MagicMock) -> None:
        mock_agent.signature = Signature(
            input=JSONSchema(type="object"),
            output=JSONSchema(type="string"),
        )
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.post(
            "/chat",
            content="Hello!",
            headers={"Content-Type": "text/plain"},
        )

        assert response.status_code == 400
