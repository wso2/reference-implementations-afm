# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Tests for the Pydantic models."""

import pytest
from pydantic import ValidationError

from langchain_interpreter import (
    AgentMetadata,
    ClientAuthentication,
    ConsoleChatInterface,
    Exposure,
    HTTPExposure,
    JSONSchema,
    Provider,
    Signature,
    Subscription,
    ToolFilter,
    Transport,
    WebChatInterface,
    WebhookInterface,
    get_filtered_tools,
)


class TestProvider:
    """Tests for the Provider model."""

    def test_empty_provider(self) -> None:
        """Test creating an empty provider."""
        provider = Provider()
        assert provider.name is None
        assert provider.url is None

    def test_full_provider(self) -> None:
        """Test creating a full provider."""
        provider = Provider(name="Test Org", url="https://example.com")
        assert provider.name == "Test Org"
        assert provider.url == "https://example.com"


class TestClientAuthentication:
    """Tests for the ClientAuthentication model."""

    def test_bearer_auth(self) -> None:
        """Test bearer token authentication."""
        auth = ClientAuthentication(type="bearer", token="my-token")
        assert auth.type == "bearer"
        # Extra fields are allowed
        assert auth.model_dump()["token"] == "my-token"

    def test_basic_auth(self) -> None:
        """Test basic authentication."""
        auth = ClientAuthentication(type="basic", username="user", password="pass")
        assert auth.type == "basic"

    def test_api_key_auth(self) -> None:
        """Test API key authentication."""
        auth = ClientAuthentication(type="api-key", api_key="key123")
        assert auth.type == "api-key"

    def test_missing_type_fails(self) -> None:
        """Test that missing type field fails validation."""
        with pytest.raises(ValidationError):
            ClientAuthentication()


class TestTransport:
    """Tests for the Transport model."""

    def test_http_transport(self) -> None:
        """Test HTTP transport configuration."""
        transport = Transport(url="https://api.example.com/mcp")
        assert transport.type == "http"
        assert transport.url == "https://api.example.com/mcp"
        assert transport.authentication is None

    def test_transport_with_auth(self) -> None:
        """Test transport with authentication."""
        auth = ClientAuthentication(type="bearer", token="token123")
        transport = Transport(url="https://api.example.com", authentication=auth)
        assert transport.authentication is not None
        assert transport.authentication.type == "bearer"


class TestToolFilter:
    """Tests for the ToolFilter model."""

    def test_empty_filter(self) -> None:
        """Test empty tool filter."""
        filter = ToolFilter()
        assert filter.allow is None
        assert filter.deny is None

    def test_allow_only(self) -> None:
        """Test filter with only allow list."""
        filter = ToolFilter(allow=["tool1", "tool2"])
        assert filter.allow == ["tool1", "tool2"]
        assert filter.deny is None

    def test_deny_only(self) -> None:
        """Test filter with only deny list."""
        filter = ToolFilter(deny=["tool3"])
        assert filter.deny == ["tool3"]
        assert filter.allow is None

    def test_allow_and_deny(self) -> None:
        """Test filter with both allow and deny lists."""
        filter = ToolFilter(allow=["tool1", "tool2", "tool3"], deny=["tool2"])
        assert filter.allow == ["tool1", "tool2", "tool3"]
        assert filter.deny == ["tool2"]


class TestGetFilteredTools:
    """Tests for the get_filtered_tools helper function."""

    def test_no_filter(self) -> None:
        """Test with no filter."""
        result = get_filtered_tools(None)
        assert result is None

    def test_empty_filter(self) -> None:
        """Test with empty filter."""
        filter = ToolFilter()
        result = get_filtered_tools(filter)
        assert result is None

    def test_allow_only(self) -> None:
        """Test with only allow list."""
        filter = ToolFilter(allow=["tool1", "tool2"])
        result = get_filtered_tools(filter)
        assert result == ["tool1", "tool2"]

    def test_deny_only(self) -> None:
        """Test with only deny list returns None."""
        filter = ToolFilter(deny=["tool1"])
        result = get_filtered_tools(filter)
        assert result is None

    def test_allow_and_deny(self) -> None:
        """Test with both allow and deny lists."""
        filter = ToolFilter(
            allow=["tool1", "tool2", "tool3"],
            deny=["tool2"],
        )
        result = get_filtered_tools(filter)
        assert result is not None
        assert "tool1" in result
        assert "tool3" in result
        assert "tool2" not in result


class TestJSONSchema:
    """Tests for the JSONSchema model."""

    def test_simple_string_schema(self) -> None:
        """Test simple string schema."""
        schema = JSONSchema(type="string")
        assert schema.type == "string"
        assert schema.properties is None

    def test_object_schema(self) -> None:
        """Test object schema with properties."""
        schema = JSONSchema(
            type="object",
            properties={
                "name": JSONSchema(type="string", description="User name"),
            },
            required=["name"],
        )
        assert schema.type == "object"
        assert schema.properties is not None
        assert "name" in schema.properties
        assert schema.required == ["name"]

    def test_array_schema(self) -> None:
        """Test array schema with items."""
        schema = JSONSchema(
            type="array",
            items=JSONSchema(type="string"),
        )
        assert schema.type == "array"
        assert schema.items is not None
        assert schema.items.type == "string"


class TestSignature:
    """Tests for the Signature model."""

    def test_default_signature(self) -> None:
        """Test default signature is string in/out."""
        sig = Signature()
        assert sig.input.type == "string"
        assert sig.output.type == "string"

    def test_custom_signature(self) -> None:
        """Test custom signature."""
        sig = Signature(
            input=JSONSchema(type="object"),
            output=JSONSchema(type="object"),
        )
        assert sig.input.type == "object"
        assert sig.output.type == "object"


class TestInterfaces:
    """Tests for interface models."""

    def test_consolechat_defaults(self) -> None:
        """Test ConsoleChatInterface defaults."""
        interface = ConsoleChatInterface()
        assert interface.type == "consolechat"
        assert interface.signature.input.type == "string"

    def test_webchat_defaults(self) -> None:
        """Test WebChatInterface defaults."""
        interface = WebChatInterface()
        assert interface.type == "webchat"
        assert interface.exposure.http is not None
        assert interface.exposure.http.path == "/chat"

    def test_webchat_custom_path(self) -> None:
        """Test WebChatInterface with custom path."""
        interface = WebChatInterface(
            exposure=Exposure(http=HTTPExposure(path="/custom"))
        )
        assert interface.exposure.http.path == "/custom"

    def test_webhook_interface(self) -> None:
        """Test WebhookInterface creation."""
        interface = WebhookInterface(
            prompt="Event: ${http:payload.event}",
            subscription=Subscription(protocol="websub"),
        )
        assert interface.type == "webhook"
        assert interface.prompt == "Event: ${http:payload.event}"
        assert interface.subscription.protocol == "websub"
        assert interface.exposure.http is not None
        assert interface.exposure.http.path == "/webhook"

    def test_webhook_requires_subscription(self) -> None:
        """Test that webhook requires subscription."""
        with pytest.raises(ValidationError):
            WebhookInterface()


class TestAgentMetadata:
    """Tests for the AgentMetadata model."""

    def test_empty_metadata(self) -> None:
        """Test creating empty metadata."""
        metadata = AgentMetadata()
        assert metadata.spec_version is None
        assert metadata.name is None

    def test_full_metadata(self) -> None:
        """Test creating full metadata."""
        metadata = AgentMetadata(
            spec_version="0.3.0",
            name="TestAgent",
            description="A test agent",
            version="1.0.0",
            authors=["Author1", "Author2"],
            max_iterations=10,
        )
        assert metadata.spec_version == "0.3.0"
        assert metadata.name == "TestAgent"
        assert metadata.authors == ["Author1", "Author2"]
        assert metadata.max_iterations == 10

    def test_author_vs_authors(self) -> None:
        """Test both author and authors fields."""
        metadata = AgentMetadata(
            author="Single Author",
            authors=["Author1", "Author2"],
        )
        assert metadata.author == "Single Author"
        assert metadata.authors == ["Author1", "Author2"]

    def test_invalid_max_iterations(self) -> None:
        """Test invalid max_iterations type."""
        with pytest.raises(ValidationError):
            AgentMetadata(max_iterations="invalid")
