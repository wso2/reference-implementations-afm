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

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, ClassVar, Mapping, Self

import jwt
from fastapi import HTTPException
from fastapi.responses import JSONResponse, Response
from jwt import PyJWKClient
from pydantic import BaseModel, ConfigDict, model_validator

from ._handler import PlatformHandler

if TYPE_CHECKING:
    from ...models import PlatformChatInterface

logger = logging.getLogger(__name__)

# Event types that the agent can act on.
_ACTIONABLE_EVENT_TYPES: frozenset[str] = frozenset({"MESSAGE", "ADDED_TO_SPACE"})

# Google Chat service account that issues bearer tokens.
_CHAT_ISSUER = "chat@system.gserviceaccount.com"

# Accepted issuers for Google-signed OIDC ID tokens.
_GOOGLE_OIDC_ISSUERS: frozenset[str] = frozenset(
    {"accounts.google.com", "https://accounts.google.com"}
)

# JWKS endpoints used to verify bearer token signatures.
_GOOGLE_OIDC_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
_GOOGLE_SA_JWKS_URL = (
    "https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com"
)

# JWKS clients are cached per-URL by PyJWKClient (keys are cached in-process).
_jwks_clients: dict[str, PyJWKClient] = {}


class GChatConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_number: str | int | None = None
    endpoint_url: str | None = None

    @model_validator(mode="after")
    def _exactly_one_audience(self) -> Self:
        has_project = self.project_number is not None and str(self.project_number) != ""
        has_url = isinstance(self.endpoint_url, str) and self.endpoint_url != ""
        if has_project and has_url:
            raise ValueError(
                "GChat platform_config accepts only one of "
                "'project_number' or 'endpoint_url', not both."
            )
        return self


@dataclass(frozen=True)
class HttpEndpointUrlConfig:
    """Verify bearer tokens as Google-signed OIDC ID tokens.

    Used when the Chat app's Authentication Audience is set to HTTP endpoint URL.
    The `aud` claim of the incoming JWT must match `endpoint_url`.
    """

    endpoint_url: str


@dataclass(frozen=True)
class ProjectNumberConfig:
    """Verify bearer tokens as self-signed JWTs from the Chat service account.

    Used when the Chat app's Authentication Audience is set to Project Number.
    The `aud` claim of the incoming JWT must match `project_number`.
    """

    project_number: str


HttpConfig = HttpEndpointUrlConfig | ProjectNumberConfig


def get_http_config(config: GChatConfig) -> HttpConfig | None:
    if isinstance(config.endpoint_url, str) and config.endpoint_url:
        return HttpEndpointUrlConfig(endpoint_url=config.endpoint_url)

    project_number = config.project_number
    if isinstance(project_number, str) and project_number:
        return ProjectNumberConfig(project_number=project_number)
    if isinstance(project_number, int):
        return ProjectNumberConfig(project_number=str(project_number))

    return None


def extract_bearer_token(auth_header: str | None) -> str | None:
    if not isinstance(auth_header, str) or not auth_header.startswith("Bearer "):
        return None
    token = auth_header[len("Bearer ") :].strip()
    return token or None


def verify_gchat_bearer_token(
    auth_header: str | None,
    config: HttpConfig,
) -> bool:
    token = extract_bearer_token(auth_header)
    if token is None:
        logger.warning(
            "GChat verification failed: missing or malformed Authorization header"
        )
        return False

    try:
        if isinstance(config, HttpEndpointUrlConfig):
            return _verify_id_token(token, config.endpoint_url)
        return _verify_project_number_jwt(token, config.project_number)
    except Exception:
        logger.exception("GChat bearer token verification raised an unexpected error")
        return False


def _get_jwks_client(url: str) -> PyJWKClient:
    client = _jwks_clients.get(url)
    if client is None:
        client = PyJWKClient(url, cache_keys=True)
        _jwks_clients[url] = client
    return client


def _verify_id_token(token: str, expected_audience: str) -> bool:
    try:
        signing_key = _get_jwks_client(_GOOGLE_OIDC_JWKS_URL).get_signing_key_from_jwt(
            token
        )
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=expected_audience,
            issuer=list(_GOOGLE_OIDC_ISSUERS),
            options={"require": ["exp", "iat", "iss", "aud"]},
        )
    except jwt.PyJWTError as exc:
        logger.warning("GChat ID token validation failed: %s", exc)
        return False

    email = payload.get("email")
    if email != _CHAT_ISSUER:
        logger.warning("GChat ID token has unexpected email claim: %r", email)
        return False

    if payload.get("email_verified") is not True:
        logger.warning("GChat ID token email_verified claim is not true")
        return False

    return True


def _verify_project_number_jwt(token: str, expected_audience: str) -> bool:
    try:
        signing_key = _get_jwks_client(_GOOGLE_SA_JWKS_URL).get_signing_key_from_jwt(
            token
        )
        jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=expected_audience,
            issuer=_CHAT_ISSUER,
            options={"require": ["exp", "iat", "iss", "aud"]},
        )
    except jwt.PyJWTError as exc:
        logger.warning("GChat project-number JWT validation failed: %s", exc)
        return False

    return True


def get_gchat_session_id(payload: object) -> str:
    if not isinstance(payload, dict):
        return "default"

    space = payload.get("space")
    space_name = (
        _non_empty_string(space.get("name")) if isinstance(space, dict) else None
    )
    if space_name is None:
        return "gchat:unknown-space:default"

    user = payload.get("user")
    if isinstance(user, dict):
        user_name = _non_empty_string(user.get("name"))
        if user_name:
            return f"gchat:{space_name}:{user_name}"

    return f"gchat:{space_name}:default"


def should_ignore_gchat_event(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False

    event_type = payload.get("type")
    if not isinstance(event_type, str) or event_type not in _ACTIONABLE_EVENT_TYPES:
        return True

    # Prevent bot loops: ignore messages from bot senders.
    message = payload.get("message")
    if isinstance(message, dict):
        sender = message.get("sender")
        if isinstance(sender, dict) and sender.get("type") == "BOT":
            return True

    return False


class GChatHandler(PlatformHandler):
    name: ClassVar[str] = "gchat"

    def parse_config(self, raw_config: Mapping[str, Any] | None) -> GChatConfig:
        return GChatConfig.model_validate(dict(raw_config or {}))

    def validate_runtime_config(
        self,
        interface: PlatformChatInterface,
        *,
        verify_signatures: bool,
    ) -> None:
        if not verify_signatures:
            return
        config = self.parse_config(interface.platform_config)
        if get_http_config(config) is None:
            raise ValueError(
                "GChat platform chat requires "
                "platform_config.project_number or "
                "platform_config.endpoint_url when "
                "signature verification is enabled."
            )

    def verify_raw_request(
        self,
        body: bytes,
        headers: Mapping[str, str],
        interface: PlatformChatInterface,
    ) -> None:
        config = self.parse_config(interface.platform_config)
        http_config = get_http_config(config)
        if http_config is None:
            raise HTTPException(
                status_code=500,
                detail="GChat verification audience is not configured",
            )
        auth_header = headers.get("authorization") or headers.get("Authorization")
        if not verify_gchat_bearer_token(auth_header, http_config):
            raise HTTPException(
                status_code=401,
                detail="Invalid GChat bearer token",
            )

    def verify_parsed_payload(
        self,
        payload: Any,
        interface: PlatformChatInterface,
    ) -> None:
        return

    def should_ignore(self, payload: Any) -> bool:
        return should_ignore_gchat_event(payload)

    def create_ignored_response(self) -> Response:
        return JSONResponse(status_code=200, content={})

    def get_session_id(self, payload: Any) -> str:
        return get_gchat_session_id(payload)

    def create_notification_ack(self) -> Response:
        return JSONResponse(status_code=202, content={"status": "accepted"})

    def create_request_response(self, result: str | object) -> Response:
        # If the result is already a dict (e.g. from output schema coercion),
        # return it directly — it should already contain the expected structure.
        if isinstance(result, dict):
            return JSONResponse(content=result)
        return JSONResponse(content={"text": result})


def _non_empty_string(value: object) -> str | None:
    return value if isinstance(value, str) and value != "" else None
