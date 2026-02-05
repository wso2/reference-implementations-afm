# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Pydantic models for AFM (Agent-Flavored Markdown) specification v0.3.0."""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


# =============================================================================
# Provider and Model Configuration
# =============================================================================


class Provider(BaseModel):
    """Agent provider information."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    url: str | None = None


class ClientAuthentication(BaseModel):
    """Authentication configuration for client connections.

    The 'type' field determines which additional fields are needed:
    - bearer: requires 'token' field
    - basic: requires 'username' and 'password' fields
    - api-key: requires 'api_key' field
    - oauth2, jwt: implementation-specific fields
    """

    model_config = ConfigDict(extra="allow")

    type: str
    token: str | None = None
    username: str | None = None
    password: str | None = None
    api_key: str | None = None

    @model_validator(mode="after")
    def validate_type_fields(self) -> Self:
        """Validate that the required fields for each type are present."""
        match self.type:
            case "bearer":
                if self.token is None:
                    raise ValueError("type 'bearer' requires 'token' field")
            case "basic":
                if self.username is None or self.password is None:
                    raise ValueError(
                        "type 'basic' requires 'username' and 'password' fields"
                    )
            case "api-key":
                if self.api_key is None:
                    raise ValueError("type 'api-key' requires 'api_key' field")
        return self


class Model(BaseModel):
    """AI model configuration that powers the agent."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    provider: str | None = None
    url: str | None = None
    authentication: ClientAuthentication | None = None


# =============================================================================
# Transport and MCP Tools
# =============================================================================


class TransportType(str, Enum):
    """Supported transport types for MCP connections."""

    HTTP = "http"


class Transport(BaseModel):
    """MCP server transport configuration."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["http"] = "http"
    url: str
    authentication: ClientAuthentication | None = None


class ToolFilter(BaseModel):
    """Tool filtering configuration for MCP servers."""

    model_config = ConfigDict(extra="forbid")

    allow: list[str] | None = None
    deny: list[str] | None = None


class MCPServer(BaseModel):
    """MCP server connection configuration."""

    model_config = ConfigDict(extra="forbid")

    name: str
    transport: Transport
    tool_filter: ToolFilter | None = None


class Tools(BaseModel):
    """Container for tool configurations."""

    model_config = ConfigDict(extra="forbid")

    mcp: list[MCPServer] | None = None


# =============================================================================
# JSON Schema and Signatures
# =============================================================================


class JSONSchema(BaseModel):
    """JSON Schema definition for interface signatures.

    Follows JSON Schema specification for defining input/output contracts.
    """

    model_config = ConfigDict(extra="allow")

    type: str
    properties: dict[str, JSONSchema] | None = None
    required: list[str] | None = None
    items: JSONSchema | None = None
    description: str | None = None


class Signature(BaseModel):
    """Input/output signature for agent interfaces."""

    model_config = ConfigDict(extra="forbid")

    input: JSONSchema = Field(default_factory=lambda: JSONSchema(type="string"))
    output: JSONSchema = Field(default_factory=lambda: JSONSchema(type="string"))


# =============================================================================
# Interface Exposure
# =============================================================================


class HTTPExposure(BaseModel):
    """HTTP exposure configuration for web interfaces."""

    model_config = ConfigDict(extra="forbid")

    path: str


class Exposure(BaseModel):
    """Interface exposure configuration."""

    model_config = ConfigDict(extra="forbid")

    http: HTTPExposure | None = None


# =============================================================================
# Webhook Subscription
# =============================================================================


class Subscription(BaseModel):
    """Webhook subscription configuration."""

    model_config = ConfigDict(extra="forbid")

    protocol: str
    hub: str | None = None
    topic: str | None = None
    callback: str | None = None
    secret: str | None = None
    authentication: ClientAuthentication | None = None


# =============================================================================
# Interface Types
# =============================================================================


class InterfaceType(str, Enum):
    """Supported interface types."""

    CONSOLE_CHAT = "consolechat"
    WEB_CHAT = "webchat"
    WEBHOOK = "webhook"


class ConsoleChatInterface(BaseModel):
    """Console chat interface configuration."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["consolechat"] = "consolechat"
    signature: Signature = Field(default_factory=Signature)


class WebChatInterface(BaseModel):
    """Web chat interface configuration."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["webchat"] = "webchat"
    signature: Signature = Field(default_factory=Signature)
    exposure: Exposure = Field(
        default_factory=lambda: Exposure(http=HTTPExposure(path="/chat"))
    )


class WebhookInterface(BaseModel):
    """Webhook interface configuration."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["webhook"] = "webhook"
    prompt: str | None = None
    signature: Signature = Field(default_factory=Signature)
    exposure: Exposure = Field(
        default_factory=lambda: Exposure(http=HTTPExposure(path="/webhook"))
    )
    subscription: Subscription


# Type alias for any interface type
Interface = Annotated[
    ConsoleChatInterface | WebChatInterface | WebhookInterface,
    Field(discriminator="type"),
]


# =============================================================================
# Agent Metadata and AFM Record
# =============================================================================


class AgentMetadata(BaseModel):
    """Complete YAML frontmatter content from an AFM file.

    All fields are optional as per AFM specification.
    """

    model_config = ConfigDict(extra="forbid")

    spec_version: str | None = None
    name: str | None = None
    description: str | None = None
    version: str | None = None
    author: str | None = None
    authors: list[str] | None = None
    icon_url: str | None = None
    provider: Provider | None = None
    license: str | None = None
    model: Model | None = None
    interfaces: list[Interface] | None = None
    tools: Tools | None = None
    max_iterations: int | None = None


class AFMRecord(BaseModel):
    """Complete parsed AFM file.

    Contains the parsed metadata from YAML frontmatter and the
    Role and Instructions sections from the Markdown body.
    """

    model_config = ConfigDict(extra="forbid")

    metadata: AgentMetadata
    role: str
    instructions: str


# =============================================================================
# Template Types (for webhook prompt compilation)
# =============================================================================


class LiteralSegment(BaseModel):
    """A literal text segment in a compiled template."""

    model_config = ConfigDict(frozen=True)

    kind: Literal["literal"] = "literal"
    text: str


class PayloadVariable(BaseModel):
    """A payload variable segment in a compiled template.

    The path can be:
    - Empty string: refers to the entire payload
    - Dot notation: "field.nested"
    - Bracket notation: "['field.with.dots']"
    - Array access: "items[0]"
    """

    model_config = ConfigDict(frozen=True)

    kind: Literal["payload"] = "payload"
    path: str


class HeaderVariable(BaseModel):
    """A header variable segment in a compiled template."""

    model_config = ConfigDict(frozen=True)

    kind: Literal["header"] = "header"
    name: str


# Type alias for template segments
TemplateSegment = Annotated[
    LiteralSegment | PayloadVariable | HeaderVariable, Field(discriminator="kind")
]


class CompiledTemplate(BaseModel):
    """A compiled webhook prompt template.

    Contains a list of segments that can be literal text,
    payload variable references, or header variable references.
    """

    model_config = ConfigDict(frozen=True)

    segments: tuple[TemplateSegment, ...]


# =============================================================================
# Helper Functions
# =============================================================================


def get_filtered_tools(tool_filter: ToolFilter | None) -> list[str] | None:
    """Apply tool filtering based on allow/deny lists.

    Returns the list of allowed tools, or None if no filtering is applied.

    Filter logic:
    - If no filter or empty filter: return None (all tools allowed)
    - If only allow: return allow list
    - If only deny: return None (deny applied by caller)
    - If both: return allow list minus deny list
    """
    if tool_filter is None:
        return None

    allow = tool_filter.allow
    deny = tool_filter.deny

    if allow is None and deny is None:
        return None

    if allow is None:
        # Only deny specified - caller handles filtering
        return None

    if deny is None:
        return allow

    # Both specified - return allow minus deny
    return [tool for tool in allow if tool not in deny]
