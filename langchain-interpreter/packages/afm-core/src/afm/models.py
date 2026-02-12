# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Provider(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    url: str | None = None


class ClientAuthentication(BaseModel):
    model_config = ConfigDict(extra="allow")

    type: str
    token: str | None = None
    username: str | None = None
    password: str | None = None
    api_key: str | None = None

    @model_validator(mode="after")
    def validate_type_fields(self) -> Self:
        match self.type.lower():
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
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    provider: str | None = None
    url: str | None = None
    authentication: ClientAuthentication | None = None


class TransportType(str, Enum):
    HTTP = "http"


class Transport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["http"] = "http"
    url: str
    authentication: ClientAuthentication | None = None


class ToolFilter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allow: list[str] | None = None
    deny: list[str] | None = None


class MCPServer(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    transport: Transport
    tool_filter: ToolFilter | None = None


class Tools(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mcp: list[MCPServer] | None = None


class JSONSchema(BaseModel):
    model_config = ConfigDict(extra="allow")

    type: str
    properties: dict[str, JSONSchema] | None = None
    required: list[str] | None = None
    items: JSONSchema | None = None
    description: str | None = None


class Signature(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input: JSONSchema = Field(default_factory=lambda: JSONSchema(type="string"))
    output: JSONSchema = Field(default_factory=lambda: JSONSchema(type="string"))


#


class HTTPExposure(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str


class Exposure(BaseModel):
    model_config = ConfigDict(extra="forbid")

    http: HTTPExposure | None = None


class Subscription(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocol: str
    hub: str | None = None
    topic: str | None = None
    callback: str | None = None
    secret: str | None = None
    authentication: ClientAuthentication | None = None


class InterfaceType(str, Enum):
    CONSOLE_CHAT = "consolechat"
    WEB_CHAT = "webchat"
    WEBHOOK = "webhook"


class ConsoleChatInterface(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["consolechat"] = "consolechat"
    signature: Signature = Field(default_factory=Signature)


class WebChatInterface(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["webchat"] = "webchat"
    signature: Signature = Field(default_factory=Signature)
    exposure: Exposure = Field(
        default_factory=lambda: Exposure(http=HTTPExposure(path="/chat"))
    )


class WebhookInterface(BaseModel):
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


class AgentMetadata(BaseModel):
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
    model_config = ConfigDict(extra="forbid")

    metadata: AgentMetadata
    role: str
    instructions: str


class LiteralSegment(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["literal"] = "literal"
    text: str


class PayloadVariable(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["payload"] = "payload"
    path: str


class HeaderVariable(BaseModel):
    model_config = ConfigDict(frozen=True)

    kind: Literal["header"] = "header"
    name: str


# Type alias for template segments
TemplateSegment = Annotated[
    LiteralSegment | PayloadVariable | HeaderVariable, Field(discriminator="kind")
]


class CompiledTemplate(BaseModel):
    model_config = ConfigDict(frozen=True)

    segments: tuple[TemplateSegment, ...]
