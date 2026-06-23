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

from enum import Enum
from pathlib import Path
from typing import Annotated, Any, Literal, Self

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


class HttpTransport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["http"] = "http"
    url: str
    authentication: ClientAuthentication | None = None


class StdioTransport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["stdio"] = "stdio"
    command: str
    args: list[str] | None = None
    env: dict[str, str] | None = None


Transport = Annotated[
    HttpTransport | StdioTransport,
    Field(discriminator="type"),
]


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

    http: HTTPExposure


class Subscription(BaseModel):
    model_config = ConfigDict(extra="forbid")

    protocol: Literal["websub"]
    hub: str | None = None
    topic: str | None = None
    callback: str | None = None
    secret: str | None = None
    authentication: ClientAuthentication | None = None


class InterfaceType(str, Enum):
    CONSOLE_CHAT = "consolechat"
    WEB_CHAT = "webchat"
    PLATFORM_CHAT = "platformchat"
    WEBHOOK = "webhook"


class PlatformChatMode(str, Enum):
    NOTIFICATION = "notification"
    REQUEST = "request"
    POLLING = "polling"


DEFAULT_POLLING_INTERVAL_SECONDS = 30

DEFAULT_WEBCHAT_PATH = "/chat"
DEFAULT_WEBHOOK_PATH = "/webhook"


class Polling(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Seconds to wait between polling cycles. 0 means "no sleep" (typical
    # when ``timeout`` is set and the platform long-polls). Negative values
    # would busy-spin the loop, so they are rejected at parse time.
    interval: int = Field(default=DEFAULT_POLLING_INTERVAL_SECONDS, ge=0)
    timeout: int | None = Field(default=None, ge=0)


class ConsoleChatInterface(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["consolechat"] = "consolechat"
    signature: Signature = Field(default_factory=Signature)


class WebChatInterface(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["webchat"] = "webchat"
    signature: Signature = Field(default_factory=Signature)
    exposure: Exposure = Field(
        default_factory=lambda: Exposure(http=HTTPExposure(path=DEFAULT_WEBCHAT_PATH))
    )


class WebhookInterface(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["webhook"] = "webhook"
    prompt: str | None = None
    signature: Signature = Field(default_factory=Signature)
    exposure: Exposure = Field(
        default_factory=lambda: Exposure(http=HTTPExposure(path=DEFAULT_WEBHOOK_PATH))
    )
    subscription: Subscription


class PlatformChatInterface(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["platformchat"] = "platformchat"
    platform: str
    mode: PlatformChatMode
    platform_config: dict[str, Any] | None = None
    prompt: str | None = None
    signature: Signature = Field(default_factory=Signature)
    exposure: Exposure | None = None
    polling: Polling | None = None
    authentication: ClientAuthentication | None = None
    has_explicit_output_schema: bool = Field(default=False, exclude=True)

    @model_validator(mode="before")
    @classmethod
    def annotate_explicit_output_schema(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data

        if "has_explicit_output_schema" not in data:
            signature = data.get("signature")
            data["has_explicit_output_schema"] = (
                isinstance(signature, dict) and "output" in signature
            )
        return data

    @model_validator(mode="after")
    def validate_mode_fields(self) -> Self:
        if self.mode != PlatformChatMode.REQUEST and self.has_explicit_output_schema:
            raise ValueError(
                f"mode '{self.mode.value}' does not support synchronous "
                "responses; 'signature.output' must not be specified"
            )

        if self.mode == PlatformChatMode.POLLING:
            if self.exposure is not None:
                raise ValueError(
                    "mode 'polling' has no inbound HTTP endpoint; "
                    "'exposure' must not be set"
                )
        else:
            if self.polling is not None:
                raise ValueError(
                    f"mode '{self.mode.value}' does not support 'polling'; "
                    "this field applies only to mode 'polling'"
                )
            if self.authentication is not None:
                raise ValueError(
                    f"mode '{self.mode.value}' does not support "
                    "'authentication'; this field applies only to mode 'polling'"
                )
        return self


# Type alias for any interface type
Interface = Annotated[
    ConsoleChatInterface | WebChatInterface | PlatformChatInterface | WebhookInterface,
    Field(discriminator="type"),
]


class LocalSkillSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["local"] = "local"
    path: str


SkillSource = Annotated[
    LocalSkillSource,
    Field(discriminator="type"),
]


class SkillInfo(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str
    body: str
    base_path: Path = Field(exclude=True)
    resources: list[str] = Field(default_factory=list)


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
    skills: list[SkillSource] | None = None
    max_iterations: int | None = None


class AFMRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metadata: AgentMetadata
    role: str
    instructions: str
    source_dir: Path | None = Field(default=None, exclude=True)


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
