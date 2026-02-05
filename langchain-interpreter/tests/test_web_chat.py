# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Tests for web chat interface handler."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from langchain_interpreter import (
    JSONSchema,
    Signature,
    WebChatInterface,
)
from langchain_interpreter.agent import Agent
from langchain_interpreter.interfaces.web_chat import create_webchat_app


@pytest.fixture
def mock_agent() -> MagicMock:
    """Create a mock agent with string signature for testing."""
    agent = MagicMock(spec=Agent)
    agent.name = "Test Agent"
    agent.description = "A test agent for unit testing"
    agent.afm = MagicMock()
    agent.afm.metadata = MagicMock()
    agent.afm.metadata.version = "1.0.0"
    agent.afm.metadata.interfaces = None

    # Default string signature
    agent._signature = Signature(
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
    """Create a mock agent with object output signature."""
    agent = MagicMock(spec=Agent)
    agent.name = "Object Output Agent"
    agent.description = "Returns structured data"
    agent.afm = MagicMock()
    agent.afm.metadata = MagicMock()
    agent.afm.metadata.version = "1.0.0"
    agent.afm.metadata.interfaces = None

    # Object output signature
    agent._signature = Signature(
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


@pytest.fixture
def mock_agent_with_webchat_interface() -> MagicMock:
    """Create a mock agent with webchat interface configured."""
    agent = MagicMock(spec=Agent)
    agent.name = "Web Chat Agent"
    agent.description = "Agent with webchat interface"
    agent.afm = MagicMock()
    agent.afm.metadata = MagicMock()
    agent.afm.metadata.version = "2.0.0"

    # Configure webchat interface with custom path
    from langchain_interpreter.models import Exposure, HTTPExposure

    interface = WebChatInterface(
        type="webchat",
        signature=Signature(
            input=JSONSchema(type="string"),
            output=JSONSchema(type="string"),
        ),
        exposure=Exposure(http=HTTPExposure(path="/api/chat")),
    )
    agent.afm.metadata.interfaces = [interface]

    async def mock_arun(input_data: str, session_id: str = "default") -> str:
        return f"Web response: {input_data}"

    agent.arun = mock_arun
    return agent


class TestCreateWebchatApp:
    """Tests for create_webchat_app function."""

    def test_creates_fastapi_app(self, mock_agent: MagicMock) -> None:
        """Test that a FastAPI app is created."""
        app = create_webchat_app(mock_agent)

        assert app is not None
        assert app.title == "Test Agent"

    def test_app_has_agent_info_endpoint(self, mock_agent: MagicMock) -> None:
        """Test that GET / returns agent info."""
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.get("/")

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Test Agent"
        assert data["description"] == "A test agent for unit testing"
        assert data["version"] == "1.0.0"

    def test_app_has_health_endpoint(self, mock_agent: MagicMock) -> None:
        """Test that GET /health returns ok."""
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.get("/health")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"


class TestStringChat:
    """Tests for string-based chat endpoint."""

    def test_chat_endpoint_responds(self, mock_agent: MagicMock) -> None:
        """Test that POST /chat returns a response."""
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.post("/chat", json={"message": "Hello!"})

        assert response.status_code == 200
        data = response.json()
        assert "response" in data
        assert data["response"] == "Response to: Hello!"

    def test_chat_uses_session_id_header(self, mock_agent: MagicMock) -> None:
        """Test that X-Session-Id header is passed to agent."""
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        # Track session IDs
        sessions_used: list[str] = []

        async def tracking_arun(input_data: str, session_id: str = "default") -> str:
            sessions_used.append(session_id)
            return f"Response: {input_data}"

        mock_agent.arun = tracking_arun

        # First request without session
        client.post("/chat", json={"message": "msg1"})

        # Second request with session
        client.post(
            "/chat",
            json={"message": "msg2"},
            headers={"X-Session-Id": "my-session-123"},
        )

        assert sessions_used[0] == "default"
        assert sessions_used[1] == "my-session-123"

    def test_chat_missing_message_returns_422(self, mock_agent: MagicMock) -> None:
        """Test that missing message field returns 422."""
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.post("/chat", json={})

        assert response.status_code == 422

    def test_chat_invalid_json_returns_422(self, mock_agent: MagicMock) -> None:
        """Test that invalid JSON returns 422."""
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.post(
            "/chat",
            content="not json",
            headers={"Content-Type": "application/json"},
        )

        assert response.status_code == 422

    def test_chat_agent_error_returns_500(self, mock_agent: MagicMock) -> None:
        """Test that agent errors return 500."""
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        async def failing_arun(input_data: str, session_id: str = "default") -> str:
            raise Exception("Agent failed")

        mock_agent.arun = failing_arun

        response = client.post("/chat", json={"message": "Hello!"})

        assert response.status_code == 500
        data = response.json()
        assert "Agent failed" in data["detail"]


class TestObjectOutputChat:
    """Tests for object-output chat endpoint."""

    def test_object_output_returned(
        self, mock_agent_with_object_output: MagicMock
    ) -> None:
        """Test that object output is returned as JSON."""
        app = create_webchat_app(mock_agent_with_object_output)
        client = TestClient(app)

        response = client.post("/chat", json={"message": "Hello!"})

        assert response.status_code == 200
        data = response.json()
        assert data["response"] == "Response to: Hello!"
        assert data["confidence"] == 0.95


class TestCustomPath:
    """Tests for custom chat endpoint paths."""

    def test_custom_path_from_interface(
        self, mock_agent_with_webchat_interface: MagicMock
    ) -> None:
        """Test that custom path from interface config is used."""
        app = create_webchat_app(mock_agent_with_webchat_interface)
        client = TestClient(app)

        # Default path should not work
        response = client.post("/chat", json={"message": "Hello!"})
        assert response.status_code == 404

        # Custom path should work
        response = client.post("/api/chat", json={"message": "Hello!"})
        assert response.status_code == 200

    def test_custom_path_override(self, mock_agent: MagicMock) -> None:
        """Test that path can be overridden via parameter."""
        app = create_webchat_app(mock_agent, path="/custom/endpoint")
        client = TestClient(app)

        # Default path should not work
        response = client.post("/chat", json={"message": "Hello!"})
        assert response.status_code == 404

        # Custom path should work
        response = client.post("/custom/endpoint", json={"message": "Hello!"})
        assert response.status_code == 200


class TestCORS:
    """Tests for CORS configuration."""

    def test_cors_not_enabled_by_default(self, mock_agent: MagicMock) -> None:
        """Test that CORS is not enabled by default."""
        app = create_webchat_app(mock_agent)

        # Check middleware stack
        cors_enabled = any(
            "CORSMiddleware" in str(type(m)) for m in app.user_middleware
        )
        assert not cors_enabled

    def test_cors_enabled_with_origins(self, mock_agent: MagicMock) -> None:
        """Test that CORS is enabled when origins are specified."""
        app = create_webchat_app(mock_agent, cors_origins=["http://localhost:3000"])
        client = TestClient(app)

        # Make preflight request
        response = client.options(
            "/chat",
            headers={
                "Origin": "http://localhost:3000",
                "Access-Control-Request-Method": "POST",
            },
        )

        assert response.status_code == 200
        assert "access-control-allow-origin" in response.headers


class TestAgentInfoEndpoint:
    """Tests for the agent info endpoint."""

    def test_returns_name(self, mock_agent: MagicMock) -> None:
        """Test that name is returned."""
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.get("/")

        assert response.json()["name"] == "Test Agent"

    def test_returns_description(self, mock_agent: MagicMock) -> None:
        """Test that description is returned."""
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.get("/")

        assert response.json()["description"] == "A test agent for unit testing"

    def test_returns_version(self, mock_agent: MagicMock) -> None:
        """Test that version is returned."""
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.get("/")

        assert response.json()["version"] == "1.0.0"

    def test_handles_missing_description(self, mock_agent: MagicMock) -> None:
        """Test that missing description is handled."""
        mock_agent.description = None
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.get("/")

        assert response.status_code == 200
        assert response.json()["description"] is None

    def test_handles_missing_version(self, mock_agent: MagicMock) -> None:
        """Test that missing version is handled."""
        mock_agent.afm.metadata.version = None
        app = create_webchat_app(mock_agent)
        client = TestClient(app)

        response = client.get("/")

        assert response.status_code == 200
        assert response.json()["version"] is None
