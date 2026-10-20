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

"""Regression tests for the findings of the second review of the authentication work."""

import base64
import datetime
import logging
from pathlib import Path

import httpx
import pytest
from pydantic import TypeAdapter, ValidationError

from afm.authentication import ClientAuthentication
from afm.exceptions import AuthenticationError
from afm.interfaces.webhook import WebSubSubscriber
from afm.http_auth import (
    MAX_TOKEN_LIFETIME_SECONDS,
    MCP_RESERVED_HEADERS,
    REQUEST_RESERVED_HEADERS,
    OAuth2Auth,
    _lifetime_seconds,
    build_httpx_auth,
)

adapter = TypeAdapter(ClientAuthentication)
SECRET = "S3CR3T-hmac-secret-0123456789abcdefghijkl"
CLIENT_CREDENTIALS = {
    "type": "oauth2",
    "grant_type": "client_credentials",
    "token_url": "https://idp.example.com/token",
    "client_id": "c",
    "client_secret": "s",
}


def parse(data: dict):
    return adapter.validate_python(data)


class TestSigningKeyIsNotEchoed:
    def test_a_secret_written_for_an_rsa_key_is_not_in_the_error(self, tmp_path: Path):
        auth = parse(
            {"type": "jwt", "issuer": "i", "audience": "a", "signing_key": SECRET}
        )
        with pytest.raises(AuthenticationError, match="cannot be read") as error:
            build_httpx_auth(auth, base_dir=tmp_path)
        assert SECRET not in str(error.value)

    def test_the_same_holds_for_an_assertion(self, tmp_path: Path):
        auth = parse(
            {
                **CLIENT_CREDENTIALS,
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion_signing": {
                    "issuer": "i",
                    "subject": "s",
                    "audience": "a",
                    "signing_key": SECRET,
                },
            }
        )
        with pytest.raises(AuthenticationError, match="cannot be read") as error:
            build_httpx_auth(auth, base_dir=tmp_path)
        assert SECRET not in str(error.value)

    @pytest.mark.parametrize(
        "value",
        [
            "keys/missing.pem",
            "S3CR3T.pem",
            "secret.key",
            SECRET + ".pem",
            SECRET + ".KEY",
        ],
    )
    def test_the_value_is_never_shown_even_if_it_looks_like_a_file_name(
        self, tmp_path: Path, value: str
    ):
        auth = parse(
            {"type": "jwt", "issuer": "i", "audience": "a", "signing_key": value}
        )
        with pytest.raises(AuthenticationError) as error:
            build_httpx_auth(auth, base_dir=tmp_path)
        assert str(error.value) == "signing_key file cannot be read"
        assert value not in str(error.value)


class TestMcpReservedHeaders:
    @pytest.mark.parametrize(
        "name", sorted(MCP_RESERVED_HEADERS) + ["Accept", "MCP-Session-ID"]
    )
    def test_the_key_cannot_use_a_header_the_transport_sets(self, name: str):
        auth = parse({"type": "api-key", "api_key": "k", "header_name": name})
        with pytest.raises(AuthenticationError, match="header_name"):
            build_httpx_auth(auth, mcp_url="https://mcp.example.com/mcp")

    def test_accept_is_fine_on_a_webhook(self):
        auth = parse({"type": "api-key", "api_key": "k", "header_name": "Accept"})
        assert build_httpx_auth(auth) is not None

    @pytest.mark.parametrize("name", [None, "X-API-Key", "Authorization", "Api-Key"])
    def test_other_headers_are_fine_on_mcp(self, name: str | None):
        data = {"type": "api-key", "api_key": "k"}
        if name:
            data["header_name"] = name
        assert (
            build_httpx_auth(parse(data), mcp_url="https://mcp.example.com/mcp")
            is not None
        )


class TestWebhookReservedHeaders:
    @pytest.mark.parametrize(
        "name",
        sorted(REQUEST_RESERVED_HEADERS)
        + ["Content-Type", "HOST", "Transfer-Encoding"],
    )
    def test_the_key_cannot_use_a_header_the_http_request_needs(self, name: str):
        auth = parse({"type": "api-key", "api_key": "k", "header_name": name})
        with pytest.raises(AuthenticationError, match="header_name"):
            build_httpx_auth(auth)

    @pytest.mark.parametrize(
        "name",
        [
            None,
            "X-API-Key",
            "Authorization",
            "Accept",
            "User-Agent",
            "Cookie",
            "Expect",
        ],
    )
    def test_other_headers_are_fine_on_a_webhook(self, name: str | None):
        data = {"type": "api-key", "api_key": "k"}
        if name:
            data["header_name"] = name
        assert build_httpx_auth(parse(data)) is not None


class TestUrlsAreReadable:
    @pytest.mark.parametrize(
        "url",
        [
            "https://[not-ipv6]/token",
            "https://[1:2:3]/token",
            "https://[v1.x]/token",
            "https://�.example.com/token",
            "https://" + "a" * 70000 + ".com/t",
        ],
    )
    def test_a_token_url_the_http_library_cannot_read_is_rejected_when_loaded(
        self, url: str
    ):
        with pytest.raises(ValidationError):
            parse({**CLIENT_CREDENTIALS, "token_url": url})

    @pytest.mark.parametrize(
        "url",
        [
            "https://idp.example.com:8443/t",
            "http://[::1]:8443/token",
            "http://localhost:8080/token",
            "https://exämple.com/token",
        ],
    )
    def test_valid_token_urls_are_still_accepted(self, url: str):
        assert parse({**CLIENT_CREDENTIALS, "token_url": url})

    async def test_an_unreadable_url_at_use_time_is_a_controlled_error(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.InvalidURL("bad")

        auth = OAuth2Auth(
            parse(CLIENT_CREDENTIALS), transport=httpx.MockTransport(handler)
        )
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(200)), auth=auth
        ) as client:
            with pytest.raises(AuthenticationError, match="token request failed"):
                await client.get("https://api.example.com/")

    @pytest.mark.parametrize(
        "resource",
        [
            "https://[not-ipv6]/mcp",
            "https://example.com:99999/mcp",
            "https://example.com/a%zz",
            "http://[::1/x",
            "https:///x",
        ],
    )
    def test_a_malformed_resource_is_rejected(self, resource: str):
        with pytest.raises(ValidationError):
            parse({**CLIENT_CREDENTIALS, "resource": resource})

    @pytest.mark.parametrize(
        "resource",
        [
            "urn:example:mcp",
            "https://example.com:8443/a%20b?x=1",
            "https://mcp.example.com/mcp",
            "a:b",
        ],
    )
    def test_valid_resources_are_still_accepted(self, resource: str):
        assert parse({**CLIENT_CREDENTIALS, "resource": resource})


class TestJwtClaimsAreJson:
    def jwt_with(self, claims: dict):
        return {
            "type": "jwt",
            "issuer": "i",
            "audience": "a",
            "algorithm": "HS256",
            "signing_key": "k" * 32,
            "custom_claims": claims,
        }

    @pytest.mark.parametrize(
        "value",
        [
            datetime.date(2024, 1, 1),
            datetime.datetime(2024, 1, 1, 10),
            b"bytes",
            {1, 2},
            float("nan"),
            float("inf"),
            [datetime.date(2024, 1, 1)],
            {"nested": {"d": datetime.date(2024, 1, 1)}},
        ],
    )
    def test_values_a_jwt_cannot_carry_are_rejected_when_loaded(self, value):
        with pytest.raises(ValidationError, match="JSON values"):
            parse(self.jwt_with({"x": value}))

    def test_ordinary_claims_are_accepted(self):
        claims = {
            "tenant": "t1",
            "n": 3,
            "ratio": 1.5,
            "ok": True,
            "none": None,
            "list": [1, "a", {"k": []}],
            "obj": {"k": "v"},
        }
        assert parse(self.jwt_with(claims)).custom_claims == claims


class TestTokenLifetime:
    @pytest.mark.parametrize(
        "value", [10**400, 10**30, 1e308, float(MAX_TOKEN_LIFETIME_SECONDS) + 1]
    )
    def test_a_very_long_lifetime_is_capped(self, value):
        assert _lifetime_seconds({"expires_in": value}) == MAX_TOKEN_LIFETIME_SECONDS

    @pytest.mark.parametrize(
        "value", [-(10**400), 0, "1e400", "nan", float("inf"), True]
    )
    def test_an_invalid_lifetime_is_still_an_error(self, value):
        with pytest.raises(AuthenticationError, match="invalid expires_in"):
            _lifetime_seconds({"expires_in": value})

    def test_ordinary_lifetimes_are_unchanged(self):
        assert _lifetime_seconds({"expires_in": 3599}) == 3599
        assert _lifetime_seconds({"expires_in": "120"}) == 120
        assert _lifetime_seconds({}) == 3600


class TestWebhookLogsNeverShowTheHubsText:
    KEY = "S3CR3T-API-KEY-0123456789"

    @pytest.fixture
    def hub(self, monkeypatch: pytest.MonkeyPatch):
        """Makes the subscriber talk to the given handler instead of a network."""

        def use(handler):
            real = httpx.AsyncClient
            monkeypatch.setattr(
                "afm.interfaces.webhook.httpx.AsyncClient",
                lambda **kwargs: real(transport=httpx.MockTransport(handler), **kwargs),
            )

        return use

    def subscriber(self, auth: httpx.Auth | None = None) -> WebSubSubscriber:
        return WebSubSubscriber(
            hub="https://hub.example.com/hub",
            topic="https://example.com/topic",
            callback="https://agent.example.com/webhook",
            auth=auth,
        )

    def echoed(self) -> str:
        encoded = base64.b64encode(self.KEY.encode()).decode()
        return (
            f"invalid credentials: raw={self.KEY} b64={encoded} first8={self.KEY[:8]}"
        )

    async def test_a_refused_subscription_logs_the_status_only(self, hub, caplog):
        hub(lambda request: httpx.Response(401, text=self.echoed()))
        caplog.set_level(logging.DEBUG)

        assert await self.subscriber().subscribe() is False

        assert "WebSub subscription failed: 401" in caplog.text
        for shown in (
            self.KEY,
            self.KEY[:8],
            base64.b64encode(self.KEY.encode()).decode(),
        ):
            assert shown not in caplog.text

    @pytest.mark.parametrize("method", ["subscribe", "unsubscribe"])
    async def test_the_text_of_a_library_error_is_not_logged(self, hub, caplog, method):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.RemoteProtocolError(
                f"illegal header line: bytearray(b'{self.echoed()}')"
            )

        hub(handler)
        caplog.set_level(logging.DEBUG)

        assert await getattr(self.subscriber(), method)() is False

        assert "RemoteProtocolError" in caplog.text
        assert self.KEY not in caplog.text

    async def test_the_message_of_an_authentication_error_is_still_logged(
        self, hub, caplog
    ):
        class Failing(httpx.Auth):
            def auth_flow(self, request):
                raise AuthenticationError("token request failed (HTTP 401)")
                yield request

        hub(lambda request: httpx.Response(202))
        caplog.set_level(logging.DEBUG)

        assert await self.subscriber(Failing()).subscribe() is False

        assert "token request failed (HTTP 401)" in caplog.text
