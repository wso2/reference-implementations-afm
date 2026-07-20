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


RECOGNIZED_AUTH_TYPES = ("bearer", "basic", "api-key", "jwt", "oauth2")


_JWT_ALLOWED_FIELDS = {
    "issuer",
    "audience",
    "signing_key",
    "algorithm",
    "key_id",
    "subject",
    "custom_claims",
    "expiry_seconds",
}
_JWT_ALGORITHMS = {"RS256", "RS384", "RS512", "HS256", "HS384", "HS512"}
_OAUTH2_CREDENTIAL_BEARERS = {"auth_header", "post_body"}

_AUTH_REQUIRED_FIELDS: dict[str, set[str]] = {
    "bearer": {"token"},
    "basic": {"username", "password"},
    "api-key": {"api_key"},
    "jwt": {"issuer", "signing_key"},
}
_AUTH_ALLOWED_FIELDS: dict[str, set[str]] = {
    "bearer": {"token"},
    "basic": {"username", "password"},
    "api-key": {"api_key", "header_name"},
    "jwt": _JWT_ALLOWED_FIELDS,
}

_OAUTH2_GRANTS: dict[str, dict[str, set[str]]] = {
    "client_credentials": {
        "required": {"token_url", "client_id", "client_secret"},
        "optional": {"scopes", "credential_bearer"},
    },
    "password": {
        "required": {"token_url", "username", "password", "client_id", "client_secret"},
        "optional": {"scopes", "credential_bearer"},
    },
    "refresh_token": {
        "required": {"token_url", "refresh_token", "client_id", "client_secret"},
        "optional": {"scopes", "credential_bearer"},
    },
    "jwt_bearer": {
        "required": {"token_url", "assertion"},
        "optional": {"client_id", "client_secret", "scopes", "credential_bearer"},
    },
}
_AUTH_CREDENTIAL_FIELDS = (
    "token",
    "username",
    "password",
    "api_key",
    "header_name",
    "issuer",
    "audience",
    "signing_key",
    "algorithm",
    "key_id",
    "subject",
    "custom_claims",
    "expiry_seconds",
    "grant_type",
    "token_url",
    "client_id",
    "client_secret",
    "refresh_token",
    "assertion",
    "scopes",
    "credential_bearer",
)


class ClientAuthentication(BaseModel):
    model_config = ConfigDict(extra="allow")

    type: str
    token: str | None = None
    username: str | None = None
    password: str | None = None
    api_key: str | None = None
    header_name: str | None = None
    issuer: str | None = None
    audience: str | list[str] | None = None
    signing_key: str | None = None
    algorithm: str | None = None
    key_id: str | None = None
    subject: str | None = None
    custom_claims: dict[str, Any] | None = None
    expiry_seconds: int | None = None
    grant_type: str | None = None
    token_url: str | None = None
    client_id: str | None = None
    client_secret: str | None = None
    refresh_token: str | None = None
    assertion: str | None = None
    scopes: list[str] | None = None
    credential_bearer: str | None = None

    @model_validator(mode="after")
    def validate_type_fields(self) -> Self:
        auth_type = self.type.lower()

        if auth_type.startswith("x-"):
            return self

        if auth_type not in RECOGNIZED_AUTH_TYPES:
            supported = ", ".join(RECOGNIZED_AUTH_TYPES)
            raise ValueError(
                f"unknown authentication type '{self.type}'. "
                f"Supported types: {supported}"
            )

        provided = {
            name for name in _AUTH_CREDENTIAL_FIELDS if getattr(self, name) is not None
        }
        provided |= set(self.model_extra or {})

        if auth_type == "oauth2":
            self._validate_oauth2_fields(provided)
            return self

        missing = _AUTH_REQUIRED_FIELDS[auth_type] - provided
        if missing:
            fields = ", ".join(f"'{name}'" for name in sorted(missing))
            suffix = "field" if len(missing) == 1 else "fields"
            raise ValueError(f"type '{auth_type}' requires {fields} {suffix}")

        unknown = provided - _AUTH_ALLOWED_FIELDS[auth_type]
        if unknown:
            fields = ", ".join(f"'{name}'" for name in sorted(unknown))
            suffix = "field" if len(unknown) == 1 else "fields"
            raise ValueError(f"type '{auth_type}' does not support {fields} {suffix}")

        if auth_type == "jwt":
            self._validate_jwt_algorithm()

        return self

    def _validate_jwt_algorithm(self) -> None:
        if self.algorithm is None:
            return
        if self.algorithm.lower() == "none":
            raise ValueError(
                "jwt 'algorithm' 'none' is not allowed; it produces an unsigned token"
            )
        if self.algorithm not in _JWT_ALGORITHMS:
            supported = ", ".join(sorted(_JWT_ALGORITHMS))
            raise ValueError(
                f"jwt 'algorithm' '{self.algorithm}' is not supported. "
                f"Supported algorithms: {supported}"
            )

    def _validate_oauth2_fields(self, provided: set[str]) -> None:
        if self.grant_type is None:
            raise ValueError("type 'oauth2' requires 'grant_type' field")

        grant = self.grant_type.lower()
        spec = _OAUTH2_GRANTS.get(grant)
        if spec is None:
            supported = ", ".join(_OAUTH2_GRANTS)
            raise ValueError(
                f"oauth2 grant_type '{self.grant_type}' is not supported. "
                f"Supported grant types: {supported}"
            )

        missing = spec["required"] - provided
        if missing:
            fields = ", ".join(f"'{name}'" for name in sorted(missing))
            suffix = "field" if len(missing) == 1 else "fields"
            raise ValueError(f"oauth2 grant_type '{grant}' requires {fields} {suffix}")

        allowed = {"grant_type"} | spec["required"] | spec["optional"]
        unknown = provided - allowed
        if unknown:
            fields = ", ".join(f"'{name}'" for name in sorted(unknown))
            suffix = "field" if len(unknown) == 1 else "fields"
            raise ValueError(
                f"oauth2 grant_type '{grant}' does not support {fields} {suffix}"
            )

        if (
            self.credential_bearer is not None
            and self.credential_bearer not in _OAUTH2_CREDENTIAL_BEARERS
        ):
            supported = ", ".join(sorted(_OAUTH2_CREDENTIAL_BEARERS))
            raise ValueError(
                f"oauth2 'credential_bearer' '{self.credential_bearer}' is not "
                f"supported. Supported values: {supported}"
            )


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
