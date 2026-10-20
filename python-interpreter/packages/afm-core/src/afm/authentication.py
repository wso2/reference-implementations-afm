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

"""Client authentication schema (specification section 5.6).

Messages name fields and never echo values, so credentials cannot leak into errors.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Annotated, Any, ClassVar, Literal

import httpx
from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)

AUTH_TYPES = ("bearer", "basic", "api-key", "jwt", "oauth2")
JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer"
DEFAULT_EXPIRY_SECONDS = 300

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
_WHITESPACE = re.compile(
    "[\t\n\x0b\x0c\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]"
)
_HEADER_NAME = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
_SCOPE_TOKEN = re.compile(r"[\x21\x23-\x5b\x5d-\x7e]+")
_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.\-]*")
_BAD_PERCENT_ENCODING = re.compile(r"%(?![0-9A-Fa-f]{2})")

_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
_RESERVED_CLAIMS = ("iss", "aud", "sub", "iat", "exp", "nbf", "jti")
_HMAC_MIN_KEY_BYTES = {"HS256": 32, "HS384": 48, "HS512": 64}
_RESERVED_PARAMS = (
    "grant_type",
    "scope",
    "client_id",
    "client_secret",
    "resource",
    "assertion",
    "username",
    "password",
    "refresh_token",
    "client_assertion",
    "client_assertion_type",
)


def has_control_chars(value: str) -> bool:
    return _CONTROL_CHARS.search(value) is not None


def _is_json_value(value: Any) -> bool:
    if value is None or isinstance(value, (str, bool, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(
            isinstance(key, str) and _is_json_value(item) for key, item in value.items()
        )
    return False


def _split_authority(url: str) -> tuple[str, str, str] | None:
    """The scheme, host and port of a URL with an authority, or None if the authority is malformed.

    The URL is split by hand, with the same steps as the Ballerina interpreter, so that
    both accept and reject the same malformed URLs.
    """
    scheme, separator, rest = url.partition("://")
    if not separator:
        return None

    authority = re.split(r"[/?#]", rest, maxsplit=1)[0]
    host_port = authority.rpartition("@")[2]
    if host_port.startswith("["):
        host, bracket, after = host_port[1:].partition("]")
        if not bracket or (after and not after.startswith(":")):
            return None
        port = after[1:]
    else:
        host, _, port = host_port.partition(":")

    if not host or (
        port and not (port.isascii() and port.isdigit() and int(port) <= 65535)
    ):
        return None
    return scheme.lower(), host, port


def _http_library_reads(url: str) -> bool:
    """Whether the HTTP library that will call the URL can read it (it rejects, for example, an IPv6 host that is not one)."""
    try:
        httpx.URL(url)
    except httpx.InvalidURL:
        return False
    return True


def _is_absolute_uri(value: str) -> bool:
    """An RFC 3986 absolute URI without a fragment."""
    scheme, colon, rest = value.partition(":")
    if not (
        bool(colon and rest)
        and _SCHEME.fullmatch(scheme) is not None
        and "#" not in value
        and not has_control_chars(value)
        and _WHITESPACE.search(value) is None
        and _BAD_PERCENT_ENCODING.search(value) is None
    ):
        return False
    if not rest.startswith("//"):
        return True
    return _split_authority(value) is not None and _http_library_reads(value)


def _is_valid_token_url(url: str) -> bool:
    """An absolute https URL; http only for a loopback host."""
    if has_control_chars(url) or _WHITESPACE.search(url):
        return False
    parts = _split_authority(url)
    if parts is None:
        return False
    scheme, host, _ = parts
    return (
        scheme == "https" or (scheme == "http" and host.lower() in _LOOPBACK_HOSTS)
    ) and _http_library_reads(url)


def _is_unresolved(value: object, info: ValidationInfo) -> bool:
    context = info.context or {}
    return (
        bool(context.get("defer_unresolved"))
        and isinstance(value, str)
        and "${" in value
    )


def _requires(label: str, names: list[str]) -> str:
    quoted = [f"'{name}'" for name in names]
    if len(quoted) == 1:
        return f"{label} requires {quoted[0]} field"
    return f"{label} requires {', '.join(quoted[:-1])} and {quoted[-1]} fields"


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    label: ClassVar[str]

    @model_validator(mode="before")
    @classmethod
    def _check_structure(cls, data: Any) -> Any:
        if not isinstance(data, Mapping):
            return data

        fields = cls.model_fields
        unknown = sorted(str(name) for name in data if name not in fields)
        if unknown:
            raise ValueError(
                f"{cls.label} does not support field(s): {', '.join(unknown)}"
            )

        null = next((name for name, value in data.items() if value is None), None)
        if null is not None:
            raise ValueError(f"{cls.label}: field '{null}' must not be null")

        required = [name for name, field in fields.items() if field.is_required()]
        missing = [name for name in required if name not in data]
        if missing:
            raise ValueError(_requires(cls.label, missing))

        empty = next((name for name in required if data[name] in ("", [])), None)
        if empty is not None:
            raise ValueError(f"{cls.label}: field '{empty}' must not be empty")
        return data


class BearerAuthentication(_Closed):
    label: ClassVar[str] = "type 'bearer'"

    type: Literal["bearer"] = "bearer"
    token: str

    @field_validator("token")
    @classmethod
    def _check_token(cls, value: str, info: ValidationInfo) -> str:
        if _is_unresolved(value, info):
            return value
        if has_control_chars(value):
            raise ValueError("must not contain control characters")
        if _WHITESPACE.search(value):
            raise ValueError("must not contain whitespace")
        return value


class BasicAuthentication(_Closed):
    label: ClassVar[str] = "type 'basic'"

    type: Literal["basic"] = "basic"
    username: str
    password: str

    @field_validator("username")
    @classmethod
    def _check_username(cls, value: str, info: ValidationInfo) -> str:
        if _is_unresolved(value, info):
            return value
        if has_control_chars(value):
            raise ValueError("must not contain control characters")
        if ":" in value:
            raise ValueError("must not contain a colon")
        return value

    @field_validator("password")
    @classmethod
    def _check_password(cls, value: str, info: ValidationInfo) -> str:
        if not _is_unresolved(value, info) and has_control_chars(value):
            raise ValueError("must not contain control characters")
        return value


class ApiKeyAuthentication(_Closed):
    label: ClassVar[str] = "type 'api-key'"

    type: Literal["api-key"] = "api-key"
    api_key: str
    header_name: str | None = None

    @field_validator("api_key")
    @classmethod
    def _check_api_key(cls, value: str, info: ValidationInfo) -> str:
        if not _is_unresolved(value, info) and has_control_chars(value):
            raise ValueError("must not contain control characters")
        return value

    @field_validator("header_name")
    @classmethod
    def _check_header_name(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None or _is_unresolved(value, info):
            return value
        if _HEADER_NAME.fullmatch(value) is None:
            raise ValueError("must be a valid HTTP header field name")
        return value


class JwtSigning(_Closed):
    """Claims and key of a runtime-signed JWT; shared by `jwt` and `assertion_signing`."""

    label: ClassVar[str] = "assertion_signing"

    issuer: str
    audience: str | list[str]
    signing_key: str
    algorithm: Literal["RS256", "RS384", "RS512", "HS256", "HS384", "HS512"] = "RS256"
    key_id: str | None = None
    subject: str | None = None
    custom_claims: dict[str, Any] | None = None
    expiry_seconds: int | str = DEFAULT_EXPIRY_SECONDS

    @field_validator("audience")
    @classmethod
    def _check_audience(cls, value: str | list[str]) -> str | list[str]:
        if isinstance(value, list) and not all(value):
            raise ValueError("entries must be non-empty strings")
        return value

    @field_validator("custom_claims")
    @classmethod
    def _check_custom_claims(
        cls, value: dict[str, Any] | None
    ) -> dict[str, Any] | None:
        reserved = [name for name in _RESERVED_CLAIMS if value and name in value]
        if reserved:
            raise ValueError(f"must not contain reserved claims: {', '.join(reserved)}")
        if not _is_json_value(value):
            raise ValueError(
                "must contain only JSON values (strings, numbers, booleans, null, lists and objects)"
            )
        return value

    @field_validator("expiry_seconds", mode="before")
    @classmethod
    def _parse_expiry_seconds(cls, value: Any, info: ValidationInfo) -> Any:
        if isinstance(value, bool):
            raise ValueError("must be an integer or a string of digits")
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            if _is_unresolved(value, info):
                return value
            if value.isascii() and value.isdigit():
                return int(value)
        raise ValueError("must be an integer or a string of digits")

    @field_validator("expiry_seconds")
    @classmethod
    def _check_expiry_seconds(cls, value: int | str) -> int | str:
        if isinstance(value, int) and value <= 0:
            raise ValueError("must be greater than zero")
        return value

    @model_validator(mode="after")
    def _check_hmac_secret_length(self, info: ValidationInfo) -> JwtSigning:
        minimum = _HMAC_MIN_KEY_BYTES.get(self.algorithm)
        if minimum is None or _is_unresolved(self.signing_key, info):
            return self
        if len(self.signing_key.encode("utf-8")) < minimum:
            raise ValueError(
                f"signing_key must be at least {minimum} bytes for {self.algorithm}"
            )
        return self


class JwtAuthentication(JwtSigning):
    label: ClassVar[str] = "type 'jwt'"

    type: Literal["jwt"] = "jwt"


class AssertionSigning(JwtSigning):
    """The signing of a JWT bearer assertion: RFC 7523 requires the `sub` claim."""

    subject: str


class OAuth2Authentication(_Closed):
    label: ClassVar[str] = "type 'oauth2'"

    type: Literal["oauth2"] = "oauth2"
    grant_type: Literal[
        "client_credentials", "urn:ietf:params:oauth:grant-type:jwt-bearer"
    ]
    token_url: str
    client_id: str | None = None
    client_secret: str | None = None
    assertion_signing: AssertionSigning | None = None
    scopes: list[str] | None = None
    token_endpoint_auth_method: Literal[
        "client_secret_basic", "client_secret_post", "none"
    ] = "client_secret_basic"
    resource: str | None = None
    extra_params: dict[str, str] | None = None

    @field_validator("grant_type", mode="before")
    @classmethod
    def _normalize_grant_type(cls, value: Any) -> Any:
        return value.lower() if isinstance(value, str) else value

    @field_validator("token_url")
    @classmethod
    def _check_token_url(cls, value: str, info: ValidationInfo) -> str:
        if not _is_unresolved(value, info) and not _is_valid_token_url(value):
            raise ValueError(
                "must be an absolute https URL "
                "(http is allowed only for localhost, 127.0.0.1 or ::1)"
            )
        return value

    @field_validator("scopes")
    @classmethod
    def _check_scopes(
        cls, value: list[str] | None, info: ValidationInfo
    ) -> list[str] | None:
        for index, scope in enumerate(value or []):
            if not _is_unresolved(scope, info) and not _SCOPE_TOKEN.fullmatch(scope):
                raise ValueError(f"entry {index} is not a valid scope token")
        return value

    @field_validator("resource")
    @classmethod
    def _check_resource(cls, value: str | None, info: ValidationInfo) -> str | None:
        if value is None or _is_unresolved(value, info):
            return value
        if not _is_absolute_uri(value):
            raise ValueError("must be an absolute URI without a fragment")
        return value

    @field_validator("extra_params")
    @classmethod
    def _check_extra_params(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        reserved = [name for name in _RESERVED_PARAMS if value and name in value]
        if reserved:
            raise ValueError(
                f"must not contain reserved parameters: {', '.join(reserved)}"
            )
        return value

    @model_validator(mode="after")
    def _check_grant_rules(self) -> OAuth2Authentication:
        jwt_bearer = self.grant_type == JWT_BEARER
        if jwt_bearer and self.assertion_signing is None:
            raise ValueError("the JWT bearer grant requires 'assertion_signing'")
        if not jwt_bearer and self.assertion_signing is not None:
            raise ValueError(
                "'assertion_signing' is only allowed with the JWT bearer grant"
            )

        method = self.token_endpoint_auth_method
        if method == "none":
            if not jwt_bearer:
                raise ValueError(
                    "token_endpoint_auth_method 'none' is only allowed with the JWT bearer grant"
                )
            if self.client_secret is not None:
                raise ValueError(
                    "'client_secret' must not be set with token_endpoint_auth_method 'none'"
                )
        elif not (self.client_id and self.client_secret):
            raise ValueError(
                f"token_endpoint_auth_method '{method}' requires 'client_id' and 'client_secret'"
            )
        return self


def _normalize_type(value: Any) -> Any:
    if not isinstance(value, Mapping):
        return value
    auth_type = value.get("type")
    if not isinstance(auth_type, str) or auth_type.lower() not in AUTH_TYPES:
        raise ValueError(
            f"'type' is required and must be one of: {', '.join(AUTH_TYPES)}"
        )
    return {**value, "type": auth_type.lower()}


ClientAuthentication = Annotated[
    BearerAuthentication
    | BasicAuthentication
    | ApiKeyAuthentication
    | JwtAuthentication
    | OAuth2Authentication,
    Field(discriminator="type"),
    BeforeValidator(_normalize_type),
]
