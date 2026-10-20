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

"""httpx authentication for the AFM client authentication types (specification section 5.6).

Error messages never contain credentials, token-endpoint response bodies or library error text.
"""

from __future__ import annotations

import asyncio
import base64
import math
import re
import time
import uuid
from collections.abc import AsyncGenerator, Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote_plus

import httpx
import jwt
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from .authentication import (
    JWT_BEARER,
    ApiKeyAuthentication,
    BasicAuthentication,
    BearerAuthentication,
    ClientAuthentication,
    JwtAuthentication,
    JwtSigning,
    OAuth2Authentication,
    has_control_chars,
)
from .exceptions import AuthenticationError

MIN_RSA_KEY_BITS = 2048
DEFAULT_TOKEN_LIFETIME_SECONDS = 3600
TOKEN_REFRESH_MARGIN_SECONDS = 60
MAX_TOKEN_LIFETIME_SECONDS = 365 * 24 * 3600
TOKEN_REQUEST_TIMEOUT = httpx.Timeout(30.0, connect=10.0)

REQUEST_RESERVED_HEADERS = frozenset(
    {"content-type", "content-length", "host", "transfer-encoding", "connection"}
)
MCP_RESERVED_HEADERS = REQUEST_RESERVED_HEADERS | {
    "accept",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
}

_TOKEN_ERROR_CODES = frozenset(
    {
        "invalid_request",
        "invalid_client",
        "invalid_grant",
        "unauthorized_client",
        "unsupported_grant_type",
        "invalid_scope",
    }
)


def form_urlencode(value: str) -> str:
    """application/x-www-form-urlencoded: `*-._` are kept, a space becomes `+`."""
    return quote_plus(value, safe="*").replace("~", "%7E")


def canonical_resource_uri(url: str) -> str:
    """The canonical URI of an MCP server: lowercase scheme and host, no fragment."""
    without_fragment = url.partition("#")[0]
    match = re.fullmatch(r"([^:/?#]+)://([^/?#]*)(.*)", without_fragment, re.DOTALL)
    if match is None:
        return without_fragment
    scheme, authority, rest = match.groups()
    userinfo, at, host = authority.rpartition("@")
    return f"{scheme.lower()}://{userinfo}{at}{host.lower()}{rest}"


class HeaderAuth(httpx.Auth):
    """Sends one fixed header (bearer token or API key)."""

    def __init__(self, name: str, value: str, field: str) -> None:
        self._name = name
        self._value = value
        self._field = field

    def auth_flow(self, request: httpx.Request):
        try:
            request.headers[self._name] = self._value
        except UnicodeError:
            raise AuthenticationError(
                f"{self._field} cannot be sent: the HTTP client cannot encode it in a header"
            ) from None
        yield request


class JwtSigner:
    """Signs the JWT of the `jwt` type and the assertion of the JWT bearer grant."""

    def __init__(
        self,
        signing: JwtSigning,
        base_dir: Path | None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._signing = signing
        self._expiry_seconds = int(signing.expiry_seconds)
        self._clock = clock
        self._key = _load_signing_key(signing, base_dir)

    def sign(self, *, with_jti: bool = False) -> str:
        signing = self._signing
        issued_at = int(self._clock())
        claims: dict[str, Any] = dict(signing.custom_claims or {})
        claims.update(
            iss=signing.issuer,
            aud=signing.audience,
            iat=issued_at,
            exp=issued_at + self._expiry_seconds,
        )
        if signing.subject is not None:
            claims["sub"] = signing.subject
        if with_jti:
            claims["jti"] = str(uuid.uuid4())

        headers = {"typ": "JWT"}
        if signing.key_id is not None:
            headers["kid"] = signing.key_id
        return jwt.encode(
            claims, self._key, algorithm=signing.algorithm, headers=headers
        )


def _load_signing_key(
    signing: JwtSigning, base_dir: Path | None
) -> bytes | rsa.RSAPrivateKey:
    if signing.algorithm.startswith("HS"):
        return signing.signing_key.encode("utf-8")

    path = Path(signing.signing_key)
    if not path.is_absolute():
        if base_dir is None:
            raise AuthenticationError(
                "signing_key is a relative path but the location of the AFM file is unknown"
            )
        path = base_dir / path

    try:
        pem = path.read_bytes()
    except OSError:
        raise AuthenticationError("signing_key file cannot be read") from None
    try:
        key = serialization.load_pem_private_key(pem, password=None)
    except TypeError:
        raise AuthenticationError(
            "signing_key file is encrypted; only unencrypted PEM keys are supported"
        ) from None
    except (ValueError, UnsupportedAlgorithm):
        raise AuthenticationError(
            "signing_key file is not a valid PEM private key"
        ) from None

    if not isinstance(key, rsa.RSAPrivateKey):
        raise AuthenticationError("signing_key file must contain an RSA private key")
    if key.key_size < MIN_RSA_KEY_BITS:
        raise AuthenticationError(
            f"signing_key RSA key must be at least {MIN_RSA_KEY_BITS} bits"
        )
    return key


class JwtAuth(httpx.Auth):
    """Sends a freshly signed JWT with every request."""

    def __init__(self, signer: JwtSigner) -> None:
        self._signer = signer

    def auth_flow(self, request: httpx.Request):
        request.headers["Authorization"] = f"Bearer {self._signer.sign()}"
        yield request


class OAuth2Auth(httpx.Auth):
    """OAuth 2.0 client credentials and JWT bearer grants; async clients only."""

    def __init__(
        self,
        config: OAuth2Authentication,
        *,
        signer: JwtSigner | None = None,
        resource: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._config = config
        self._signer = signer
        self._resource = resource
        self._transport = transport
        self._clock = clock
        self._lock = asyncio.Lock()
        self._token: str | None = None
        self._refresh_at = 0.0

    def sync_auth_flow(self, request: httpx.Request):
        raise RuntimeError("OAuth2 authentication requires an async httpx client")

    async def async_auth_flow(
        self, request: httpx.Request
    ) -> AsyncGenerator[httpx.Request, httpx.Response]:
        await request.aread()
        token = await self._get_token()
        request.headers["Authorization"] = f"Bearer {token}"
        response = yield request

        if response.status_code == 401:
            token = await self._get_token(failed=token)
            request.headers["Authorization"] = f"Bearer {token}"
            yield request

    async def _get_token(self, failed: str | None = None) -> str:
        async with self._lock:
            token = self._token
            if token is None or token == failed or self._expired():
                token = await self._fetch_token()
            return token

    def _expired(self) -> bool:
        return self._clock() >= self._refresh_at

    async def _fetch_token(self) -> str:
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        }
        fields = self._token_request_fields(headers)
        body = "&".join(f"{form_urlencode(k)}={form_urlencode(v)}" for k, v in fields)

        try:
            async with httpx.AsyncClient(
                transport=self._transport,
                follow_redirects=False,
                timeout=TOKEN_REQUEST_TIMEOUT,
            ) as client:
                response = await client.post(
                    self._config.token_url,
                    content=body.encode("ascii"),
                    headers=headers,
                )
        except (httpx.HTTPError, httpx.InvalidURL) as e:
            raise AuthenticationError(
                f"token request failed ({type(e).__name__})"
            ) from None

        token, lifetime = _read_token_response(response)
        margin = min(TOKEN_REFRESH_MARGIN_SECONDS, lifetime / 10)
        self._token = token
        self._refresh_at = self._clock() + lifetime - margin
        return token

    def _token_request_fields(self, headers: dict[str, str]) -> list[tuple[str, str]]:
        config = self._config
        fields = [("grant_type", config.grant_type)]
        if self._signer is not None:
            fields.append(("assertion", self._signer.sign(with_jti=True)))
        if config.scopes:
            fields.append(("scope", " ".join(config.scopes)))
        if self._resource is not None:
            fields.append(("resource", self._resource))
        fields.extend((config.extra_params or {}).items())

        if config.token_endpoint_auth_method == "client_secret_basic":
            credentials = f"{form_urlencode(config.client_id)}:{form_urlencode(config.client_secret)}"
            encoded = base64.b64encode(credentials.encode("ascii")).decode("ascii")
            headers["Authorization"] = f"Basic {encoded}"
        elif config.token_endpoint_auth_method == "client_secret_post":
            fields.append(("client_id", config.client_id))
            fields.append(("client_secret", config.client_secret))
        elif config.client_id is not None:
            fields.append(("client_id", config.client_id))
        return fields


def _read_token_response(response: httpx.Response) -> tuple[str, float]:
    """Validates a token response (on every fetch) and returns the token and its lifetime."""
    status = response.status_code
    if 300 <= status < 400:
        raise AuthenticationError(
            f"token endpoint answered with a redirect (HTTP {status}); redirects are not followed"
        )
    if not 200 <= status < 300:
        raise AuthenticationError(
            f"token request failed (HTTP {status}{_error_code(response)})"
        )

    try:
        data = response.json()
    except ValueError:
        raise AuthenticationError("token response is not valid JSON") from None
    if not isinstance(data, dict):
        raise AuthenticationError("token response is not a JSON object")

    token_type = data.get("token_type")
    if not isinstance(token_type, str) or token_type.lower() != "bearer":
        raise AuthenticationError("token response token_type is not Bearer")

    token = data.get("access_token")
    if not isinstance(token, str) or not token or has_control_chars(token):
        raise AuthenticationError("token response has no valid access_token")

    return token, _lifetime_seconds(data)


def _error_code(response: httpx.Response) -> str:
    try:
        error = response.json().get("error")
    except (ValueError, AttributeError):
        return ""
    if isinstance(error, str) and error in _TOKEN_ERROR_CODES:
        return f", error {error}"
    return ""


def _lifetime_seconds(data: dict[str, Any]) -> float:
    if "expires_in" not in data:
        return DEFAULT_TOKEN_LIFETIME_SECONDS

    value = data["expires_in"]
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            value = None
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or (isinstance(value, float) and not math.isfinite(value))
        or value <= 0
    ):
        raise AuthenticationError("token response has an invalid expires_in")
    return float(min(value, MAX_TOKEN_LIFETIME_SECONDS))


def build_httpx_auth(
    auth: ClientAuthentication | None,
    *,
    base_dir: Path | None = None,
    mcp_url: str | None = None,
) -> httpx.Auth | None:
    """Builds the httpx auth for a validated authentication object.

    `base_dir` is the directory of the AFM file (relative key paths); `mcp_url` is set for
    an MCP HTTP transport, whose canonical URI is the default OAuth2 `resource`.
    """
    match auth:
        case None:
            return None
        case BearerAuthentication():
            return HeaderAuth("Authorization", f"Bearer {auth.token}", "token")
        case BasicAuthentication():
            return httpx.BasicAuth(auth.username, auth.password)
        case ApiKeyAuthentication():
            name = (auth.header_name or "").lower()
            if mcp_url is not None and name in MCP_RESERVED_HEADERS:
                raise AuthenticationError(
                    "header_name cannot be a header that the MCP transport sets itself "
                    "(Accept, Content-Type, Mcp-Session-Id, ...)"
                )
            if mcp_url is None and name in REQUEST_RESERVED_HEADERS:
                raise AuthenticationError(
                    "header_name cannot be a header that the HTTP request needs itself "
                    "(Content-Type, Content-Length, Host, ...)"
                )
            return HeaderAuth(
                auth.header_name or "Authorization", auth.api_key, "api_key"
            )
        case JwtAuthentication():
            return JwtAuth(JwtSigner(auth, base_dir))
        case OAuth2Authentication():
            signer = (
                JwtSigner(auth.assertion_signing, base_dir)
                if auth.grant_type == JWT_BEARER and auth.assertion_signing
                else None
            )
            resource = auth.resource
            if resource is None and mcp_url is not None:
                resource = canonical_resource_uri(mcp_url)
            return OAuth2Auth(auth, signer=signer, resource=resource)
