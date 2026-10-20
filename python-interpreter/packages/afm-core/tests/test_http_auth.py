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

import asyncio
import atexit
import base64
import datetime
import json
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import jwt
import pytest
from afm.authentication import ClientAuthentication
from afm.exceptions import AuthenticationError
from afm.http_auth import (
    JwtSigner,
    OAuth2Auth,
    build_httpx_auth,
    canonical_resource_uri,
    form_urlencode,
)
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from pydantic import TypeAdapter


def write_test_keys() -> Path:
    directory = Path(tempfile.mkdtemp(prefix="afm-test-keys-"))
    atexit.register(shutil.rmtree, directory, ignore_errors=True)

    def new_key(bits: int) -> rsa.RSAPrivateKey:
        return rsa.generate_private_key(public_exponent=65537, key_size=bits)

    def pem(
        key: rsa.RSAPrivateKey,
        form: serialization.PrivateFormat = serialization.PrivateFormat.PKCS8,
        encryption: serialization.KeySerializationEncryption | None = None,
    ) -> bytes:
        return key.private_bytes(
            serialization.Encoding.PEM,
            form,
            encryption or serialization.NoEncryption(),
        )

    main_key = new_key(2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "afm-test")])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(main_key.public_key())
        .serial_number(1)
        .not_valid_before(datetime.datetime(2020, 1, 1))
        .not_valid_after(datetime.datetime(2099, 1, 1))
        .sign(main_key, hashes.SHA256())
    )
    files = {
        "rsa-2048.pem": pem(main_key),
        "rsa-2048-other.pem": pem(new_key(2048)),
        "rsa-2048-pkcs1.pem": pem(
            main_key, serialization.PrivateFormat.TraditionalOpenSSL
        ),
        "rsa-2048-encrypted.pem": pem(
            main_key, encryption=serialization.BestAvailableEncryption(b"test-password")
        ),
        "rsa-2047.pem": pem(new_key(2047)),
        "rsa-1024.pem": pem(new_key(1024)),
        "rsa-2048-cert.pem": certificate.public_bytes(serialization.Encoding.PEM),
    }
    for file_name, content in files.items():
        (directory / file_name).write_bytes(content)
    return directory


KEYS = write_test_keys()
HMAC_KEYS = {
    "HS256": "0123456789abcdef0123456789abcdef",
    "HS384": "0123456789abcdef0123456789abcdef0123456789abcdef",
    "HS512": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
}
TOKEN_URL = "https://idp.example.com/token"
JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer"
SECRET = "S3CR3T-VALUE"

adapter = TypeAdapter(ClientAuthentication)


def parse(data: dict):
    return adapter.validate_python(data)


def public_key(name: str):
    return serialization.load_pem_private_key(
        (KEYS / name).read_bytes(), password=None
    ).public_key()


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


async def send(
    auth: httpx.Auth | None,
    handler: Callable,
    *,
    content: bytes = b'{"jsonrpc":"2.0"}',
    url: str = "https://api.example.com/mcp",
) -> httpx.Response:
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        return await client.post(url, content=content, auth=auth)


def echo_headers(captured: list[httpx.Request]) -> Callable:
    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200)

    return handler


class TestStaticAuthentication:
    async def test_bearer(self):
        captured: list[httpx.Request] = []
        auth = build_httpx_auth(parse({"type": "bearer", "token": "abc"}))
        await send(auth, echo_headers(captured))
        assert captured[0].headers["Authorization"] == "Bearer abc"

    async def test_basic_is_utf8_base64(self):
        captured: list[httpx.Request] = []
        auth = build_httpx_auth(
            parse({"type": "basic", "username": "üser", "password": "pässwörd"})
        )
        await send(auth, echo_headers(captured))
        expected = base64.b64encode("üser:pässwörd".encode("utf-8")).decode()
        assert captured[0].headers["Authorization"] == f"Basic {expected}"

    async def test_api_key_default_header_is_the_raw_value(self):
        captured: list[httpx.Request] = []
        auth = build_httpx_auth(parse({"type": "api-key", "api_key": "Bot abc"}))
        await send(auth, echo_headers(captured))
        assert captured[0].headers["Authorization"] == "Bot abc"

    async def test_api_key_custom_header(self):
        captured: list[httpx.Request] = []
        auth = build_httpx_auth(
            parse({"type": "api-key", "api_key": "k", "header_name": "X-API-Key"})
        )
        await send(auth, echo_headers(captured))
        assert captured[0].headers["X-API-Key"] == "k"
        assert "Authorization" not in captured[0].headers

    def test_a_non_ascii_header_value_is_sent_as_utf8(self):
        auth = build_httpx_auth(parse({"type": "api-key", "api_key": "clé"}))
        request = httpx.Request("GET", "https://api.example.com/")

        next(auth.auth_flow(request))

        assert request.headers.raw[-1] == (b"Authorization", "clé".encode("utf-8"))

    def test_a_header_value_the_client_cannot_encode_is_reported_without_the_value(
        self,
    ):
        auth = build_httpx_auth(parse({"type": "api-key", "api_key": f"clé-{SECRET}"}))
        request = httpx.Request("GET", "https://api.example.com/")
        list(request.headers.keys())

        with pytest.raises(AuthenticationError) as exc_info:
            next(auth.auth_flow(request))

        assert "api_key" in str(exc_info.value)
        assert SECRET not in str(exc_info.value)
        assert exc_info.value.__cause__ is None

    def test_no_authentication_builds_nothing(self):
        assert build_httpx_auth(None) is None


def hmac_auth(algorithm: str = "HS256", **overrides: object) -> dict:
    return {
        "type": "jwt",
        "issuer": "my-issuer",
        "audience": "llm-api",
        "signing_key": HMAC_KEYS[algorithm],
        "algorithm": algorithm,
        **overrides,
    }


def rsa_auth(algorithm: str = "RS256", **overrides: object) -> dict:
    return {
        "type": "jwt",
        "issuer": "my-issuer",
        "audience": "llm-api",
        "signing_key": "rsa-2048.pem",
        "algorithm": algorithm,
        **overrides,
    }


async def sent_jwt(auth: httpx.Auth) -> str:
    captured: list[httpx.Request] = []
    await send(auth, echo_headers(captured))
    scheme, _, token = captured[0].headers["Authorization"].partition(" ")
    assert scheme == "Bearer"
    return token


class TestJwtAuthentication:
    @pytest.mark.parametrize("algorithm", ["HS256", "HS384", "HS512"])
    async def test_hmac_signature_verifies_and_rejects_wrong_key(self, algorithm: str):
        auth = build_httpx_auth(parse(hmac_auth(algorithm)))
        token = await sent_jwt(auth)

        claims = jwt.decode(
            token, HMAC_KEYS[algorithm], algorithms=[algorithm], audience="llm-api"
        )
        assert claims["iss"] == "my-issuer"
        with pytest.raises(jwt.InvalidSignatureError):
            jwt.decode(token, "x" * 64, algorithms=[algorithm], audience="llm-api")

    @pytest.mark.parametrize("algorithm", ["RS256", "RS384", "RS512"])
    async def test_rsa_signature_verifies_rejects_wrong_key_and_tampering(
        self, algorithm: str
    ):
        auth = build_httpx_auth(parse(rsa_auth(algorithm)), base_dir=KEYS)
        token = await sent_jwt(auth)

        jwt.decode(
            token,
            public_key("rsa-2048.pem"),
            algorithms=[algorithm],
            audience="llm-api",
        )
        with pytest.raises(jwt.InvalidSignatureError):
            jwt.decode(
                token,
                public_key("rsa-2048-other.pem"),
                algorithms=[algorithm],
                audience="llm-api",
            )

        header, payload, signature = token.split(".")
        claims = json.loads(
            base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4))
        )
        claims["iss"] = "someone-else"
        forged = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=")
        with pytest.raises(jwt.InvalidSignatureError):
            jwt.decode(
                f"{header}.{forged.decode()}.{signature}",
                public_key("rsa-2048.pem"),
                algorithms=[algorithm],
                audience="llm-api",
            )

    async def test_header_and_claims(self):
        auth = build_httpx_auth(
            parse(
                hmac_auth(
                    audience=["a", "b"],
                    subject="svc",
                    key_id="key-1",
                    custom_claims={"tenant": "t1"},
                    expiry_seconds="120",
                )
            )
        )
        token = await sent_jwt(auth)

        assert jwt.get_unverified_header(token) == {
            "alg": "HS256",
            "typ": "JWT",
            "kid": "key-1",
        }
        claims = jwt.decode(
            token, options={"verify_signature": False, "verify_aud": False}
        )
        assert set(claims) == {"iss", "aud", "sub", "tenant", "iat", "exp"}
        assert claims["aud"] == ["a", "b"]
        assert claims["sub"] == "svc"
        assert isinstance(claims["iat"], int) and isinstance(claims["exp"], int)
        assert claims["exp"] == claims["iat"] + 120

    async def test_optional_claims_are_only_sent_when_configured(self):
        token = await sent_jwt(build_httpx_auth(parse(hmac_auth())))

        assert jwt.get_unverified_header(token) == {"alg": "HS256", "typ": "JWT"}
        claims = jwt.decode(
            token, options={"verify_signature": False, "verify_aud": False}
        )
        assert set(claims) == {"iss", "aud", "iat", "exp"}
        assert claims["exp"] - claims["iat"] == 300
        assert "nbf" not in claims and "jti" not in claims

    async def test_empty_optional_values_are_sent_as_configured(self):
        token = await sent_jwt(
            build_httpx_auth(parse(hmac_auth(subject="", key_id="")))
        )
        header = jwt.get_unverified_header(token)
        claims = jwt.decode(
            token, options={"verify_signature": False, "verify_aud": False}
        )
        assert header["kid"] == "" and claims["sub"] == ""

    def test_a_fresh_token_is_signed_for_every_request(self):
        clock = FakeClock()
        signer = JwtSigner(parse(hmac_auth(expiry_seconds=60)), None, clock=clock)

        first = signer.sign()
        clock.now += 61
        second = signer.sign()

        def claims(token: str) -> dict:
            return jwt.decode(
                token,
                options={
                    "verify_signature": False,
                    "verify_aud": False,
                    "verify_exp": False,
                    "verify_iat": False,
                },
            )

        assert claims(second)["iat"] == claims(first)["iat"] + 61
        assert claims(second)["exp"] > claims(first)["exp"]

    def test_relative_key_path_is_resolved_against_the_afm_directory(self, tmp_path):
        (tmp_path / "keys").mkdir()
        (tmp_path / "keys" / "k.pem").write_bytes((KEYS / "rsa-2048.pem").read_bytes())
        signer = JwtSigner(parse(rsa_auth(signing_key="keys/k.pem")), tmp_path)
        jwt.decode(
            signer.sign(),
            public_key("rsa-2048.pem"),
            algorithms=["RS256"],
            audience="llm-api",
        )

    def test_absolute_key_path_is_used_as_is(self):
        signer = JwtSigner(
            parse(rsa_auth(signing_key=str(KEYS / "rsa-2048.pem"))), None
        )
        jwt.decode(
            signer.sign(),
            public_key("rsa-2048.pem"),
            algorithms=["RS256"],
            audience="llm-api",
        )

    def test_pkcs1_key_is_accepted(self):
        JwtSigner(parse(rsa_auth(signing_key="rsa-2048-pkcs1.pem")), KEYS)

    @pytest.mark.parametrize(
        ("key_file", "message"),
        [
            ("rsa-2047.pem", "at least 2048 bits"),
            ("rsa-1024.pem", "at least 2048 bits"),
            ("rsa-2048-encrypted.pem", "encrypted"),
            ("rsa-2048-cert.pem", "not a valid PEM private key"),
            ("missing.pem", "cannot be read"),
        ],
    )
    def test_unusable_keys_are_rejected(self, key_file: str, message: str):
        with pytest.raises(AuthenticationError, match=message):
            JwtSigner(parse(rsa_auth(signing_key=key_file)), KEYS)

    def test_relative_key_path_needs_the_afm_directory(self):
        with pytest.raises(AuthenticationError, match="location of the AFM file"):
            JwtSigner(parse(rsa_auth(signing_key="rsa-2048.pem")), None)


def basic_oauth2(**overrides: object) -> dict:
    return {
        "type": "oauth2",
        "grant_type": "client_credentials",
        "token_url": TOKEN_URL,
        "client_id": "client",
        "client_secret": "secret",
        **overrides,
    }


def token_json(token: str = "access-1", **members: object) -> dict[str, object]:
    return {"access_token": token, "token_type": "Bearer", **members}


class TokenEndpoint:
    """Mock token endpoint that answers from a list of responses and records requests."""

    def __init__(self, *responses: dict | httpx.Response) -> None:
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        await asyncio.sleep(0)
        response = (
            self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        )
        if isinstance(response, httpx.Response):
            return response
        return httpx.Response(200, json=response)

    def form(self, index: int = -1) -> dict[str, list[str]]:
        return parse_qs(self.requests[index].content.decode(), keep_blank_values=True)


def oauth2(
    endpoint: TokenEndpoint,
    data: dict | None = None,
    *,
    base_dir: Path | None = KEYS,
    mcp_url: str | None = None,
    clock: FakeClock | None = None,
) -> OAuth2Auth:
    auth = build_httpx_auth(
        parse(data or basic_oauth2()), base_dir=base_dir, mcp_url=mcp_url
    )
    assert isinstance(auth, OAuth2Auth)
    auth._transport = httpx.MockTransport(endpoint)
    if clock is not None:
        auth._clock = clock
    return auth


class TestOAuth2ClientCredentials:
    async def test_basic_client_authentication_form_encodes_the_credentials(self):
        endpoint = TokenEndpoint(token_json())
        auth = oauth2(
            endpoint,
            basic_oauth2(client_id="a:b+c%d&e f é~*", client_secret="s:e+c%r&t f ü"),
        )
        captured: list[httpx.Request] = []

        await send(auth, echo_headers(captured))

        request = endpoint.requests[0]
        expected = base64.b64encode(
            b"a%3Ab%2Bc%25d%26e+f+%C3%A9%7E*:s%3Ae%2Bc%25r%26t+f+%C3%BC"
        ).decode()
        assert request.headers["Authorization"] == f"Basic {expected}"
        assert request.headers["Content-Type"] == "application/x-www-form-urlencoded"
        assert request.headers["Accept"] == "application/json"
        assert request.method == "POST" and str(request.url) == TOKEN_URL
        assert endpoint.form() == {"grant_type": ["client_credentials"]}
        assert captured[0].headers["Authorization"] == "Bearer access-1"

    async def test_post_client_authentication_sends_the_credentials_in_the_body(self):
        endpoint = TokenEndpoint(token_json())
        auth = oauth2(
            endpoint,
            basic_oauth2(
                token_endpoint_auth_method="client_secret_post",
                client_id="a b",
                client_secret="p&q",
            ),
        )

        await send(auth, echo_headers([]))

        assert "Authorization" not in endpoint.requests[0].headers
        assert endpoint.form() == {
            "grant_type": ["client_credentials"],
            "client_id": ["a b"],
            "client_secret": ["p&q"],
        }

    async def test_scopes_resource_and_extra_params(self):
        endpoint = TokenEndpoint(token_json())
        auth = oauth2(
            endpoint,
            basic_oauth2(
                grant_type="Client_Credentials",
                scopes=["read", "write:all"],
                resource="https://mcp.example.com/mcp",
                extra_params={"tenant": "t 1", "audience": "api"},
            ),
        )

        await send(auth, echo_headers([]))

        body = endpoint.requests[0].content.decode()
        assert body.startswith("grant_type=client_credentials&scope=read+write%3Aall&")
        assert endpoint.form() == {
            "grant_type": ["client_credentials"],
            "scope": ["read write:all"],
            "resource": ["https://mcp.example.com/mcp"],
            "tenant": ["t 1"],
            "audience": ["api"],
        }

    async def test_empty_scopes_are_omitted(self):
        endpoint = TokenEndpoint(token_json())
        await send(oauth2(endpoint, basic_oauth2(scopes=[])), echo_headers([]))
        assert endpoint.form() == {"grant_type": ["client_credentials"]}

    async def test_mcp_transport_defaults_resource_to_the_canonical_uri(self):
        endpoint = TokenEndpoint(token_json())
        auth = oauth2(endpoint, mcp_url="HTTPS://MCP.Example.COM:8443/Path?q=1#frag")

        await send(auth, echo_headers([]))

        assert endpoint.form()["resource"] == ["https://mcp.example.com:8443/Path?q=1"]

    async def test_explicit_resource_wins_over_the_mcp_default(self):
        endpoint = TokenEndpoint(token_json())
        auth = oauth2(
            endpoint,
            basic_oauth2(resource="https://explicit.example.com"),
            mcp_url="https://mcp.example.com/mcp",
        )

        await send(auth, echo_headers([]))

        assert endpoint.form()["resource"] == ["https://explicit.example.com"]

    async def test_other_locations_have_no_default_resource(self):
        endpoint = TokenEndpoint(token_json())
        await send(oauth2(endpoint), echo_headers([]))
        assert "resource" not in endpoint.form()

    def test_canonical_resource_uri(self):
        assert canonical_resource_uri("HTTPS://User@EXAMPLE.com/A#f") == (
            "https://User@example.com/A"
        )
        assert canonical_resource_uri("https://example.com") == "https://example.com"

    def test_form_urlencode(self):
        assert form_urlencode("a b~*-._:+%&é") == "a+b%7E*-._%3A%2B%25%26%C3%A9"


class TestOAuth2TokenLifecycle:
    async def test_token_is_reused_until_near_expiry_then_renewed_once(self):
        clock = FakeClock()
        endpoint = TokenEndpoint(
            token_json("t1", expires_in=1000), token_json("t2", expires_in=1000)
        )
        auth = oauth2(endpoint, clock=clock)
        captured: list[httpx.Request] = []

        for _ in range(3):
            await send(auth, echo_headers(captured))
        assert len(endpoint.requests) == 1

        clock.now += 939
        await send(auth, echo_headers(captured))
        assert len(endpoint.requests) == 1

        clock.now += 2
        await send(auth, echo_headers(captured))
        await send(auth, echo_headers(captured))
        assert len(endpoint.requests) == 2
        assert [r.headers["Authorization"] for r in captured[-2:]] == ["Bearer t2"] * 2

    async def test_absent_expires_in_means_3600_seconds(self):
        clock = FakeClock()
        endpoint = TokenEndpoint(token_json("t1"), token_json("t2"))
        auth = oauth2(endpoint, clock=clock)

        await send(auth, echo_headers([]))
        clock.now += 3539
        await send(auth, echo_headers([]))
        assert len(endpoint.requests) == 1

        clock.now += 2
        await send(auth, echo_headers([]))
        assert len(endpoint.requests) == 2

    async def test_a_short_lived_token_is_not_refetched_on_every_request(self):
        clock = FakeClock()
        endpoint = TokenEndpoint(token_json("t1", expires_in=30), token_json("t2"))
        auth = oauth2(endpoint, clock=clock)

        await send(auth, echo_headers([]))
        clock.now += 20
        await send(auth, echo_headers([]))
        assert len(endpoint.requests) == 1

        clock.now += 8
        await send(auth, echo_headers([]))
        assert len(endpoint.requests) == 2

    async def test_a_numeric_string_expires_in_is_accepted(self):
        endpoint = TokenEndpoint(token_json(expires_in="3599"))
        await send(oauth2(endpoint), echo_headers([]))

    @pytest.mark.parametrize("expires_in", [None, "abc", 0, -5, "0", True, [], "nan"])
    async def test_a_present_but_invalid_expires_in_is_an_error(self, expires_in):
        endpoint = TokenEndpoint(token_json(expires_in=expires_in))
        with pytest.raises(AuthenticationError, match="expires_in"):
            await send(oauth2(endpoint), echo_headers([]))

    @pytest.mark.parametrize("token_type", ["bearer", "BEARER", "Bearer"])
    async def test_token_type_is_case_insensitive(self, token_type: str):
        endpoint = TokenEndpoint({"access_token": "t", "token_type": token_type})
        await send(oauth2(endpoint), echo_headers([]))

    @pytest.mark.parametrize("token_type", ["DPoP", "mac", "", None, 5])
    async def test_other_token_types_are_rejected(self, token_type):
        endpoint = TokenEndpoint({"access_token": "t", "token_type": token_type})
        with pytest.raises(AuthenticationError, match="token_type"):
            await send(oauth2(endpoint), echo_headers([]))

    async def test_a_missing_token_type_is_rejected(self):
        endpoint = TokenEndpoint({"access_token": "t"})
        with pytest.raises(AuthenticationError, match="token_type"):
            await send(oauth2(endpoint), echo_headers([]))

    async def test_token_type_is_checked_on_every_response_including_renewals(self):
        clock = FakeClock()
        endpoint = TokenEndpoint(
            token_json("t1", expires_in=100),
            {"access_token": "t2", "token_type": "mac", "expires_in": 100},
        )
        auth = oauth2(endpoint, clock=clock)

        await send(auth, echo_headers([]))
        clock.now += 100
        with pytest.raises(AuthenticationError, match="token_type"):
            await send(auth, echo_headers([]))

    @pytest.mark.parametrize("access_token", [None, "", 5, ["t"], "a\r\nb"])
    async def test_an_invalid_access_token_is_rejected(self, access_token):
        endpoint = TokenEndpoint({"access_token": access_token, "token_type": "Bearer"})
        with pytest.raises(AuthenticationError, match="access_token"):
            await send(oauth2(endpoint), echo_headers([]))

    async def test_a_missing_access_token_is_rejected(self):
        endpoint = TokenEndpoint({"token_type": "Bearer"})
        with pytest.raises(AuthenticationError, match="access_token"):
            await send(oauth2(endpoint), echo_headers([]))

    @pytest.mark.parametrize(
        "response",
        [httpx.Response(200, text="not json"), httpx.Response(200, json=["a"])],
    )
    async def test_a_malformed_token_response_is_an_error(self, response):
        with pytest.raises(AuthenticationError, match="token response"):
            await send(oauth2(TokenEndpoint(response)), echo_headers([]))

    async def test_an_unexpected_refresh_token_is_ignored(self):
        endpoint = TokenEndpoint(token_json(refresh_token="r", scope="x", extra=[1]))
        captured: list[httpx.Request] = []
        await send(oauth2(endpoint), echo_headers(captured))
        assert captured[0].headers["Authorization"] == "Bearer access-1"

    async def test_concurrent_requests_fetch_a_single_token(self):
        endpoint = TokenEndpoint(token_json("t1"))
        auth = oauth2(endpoint)
        captured: list[httpx.Request] = []

        await asyncio.gather(*(send(auth, echo_headers(captured)) for _ in range(5)))

        assert len(endpoint.requests) == 1
        assert len(captured) == 5

    async def test_concurrent_requests_renew_an_expired_token_once(self):
        clock = FakeClock()
        endpoint = TokenEndpoint(token_json("t1", expires_in=100), token_json("t2"))
        auth = oauth2(endpoint, clock=clock)
        await send(auth, echo_headers([]))
        clock.now += 100
        captured: list[httpx.Request] = []

        await asyncio.gather(*(send(auth, echo_headers(captured)) for _ in range(5)))

        assert len(endpoint.requests) == 2
        assert {r.headers["Authorization"] for r in captured} == {"Bearer t2"}

    async def test_sync_clients_are_not_supported(self):
        auth = oauth2(TokenEndpoint(token_json()))
        with httpx.Client(transport=httpx.MockTransport(echo_headers([]))) as client:
            with pytest.raises(RuntimeError, match="async"):
                client.get("https://api.example.com/", auth=auth)


class TestOAuth2Unauthorized:
    @staticmethod
    def resource_server(accepted: set[str], seen: list[tuple[str, bytes]]) -> Callable:
        def handler(request: httpx.Request) -> httpx.Response:
            token = request.headers["Authorization"].removeprefix("Bearer ")
            seen.append((token, request.content))
            return httpx.Response(200 if token in accepted else 401)

        return handler

    async def test_a_401_requests_one_new_token_and_retries_once_with_the_same_body(
        self,
    ):
        endpoint = TokenEndpoint(token_json("old"), token_json("new"))
        seen: list[tuple[str, bytes]] = []
        auth = oauth2(endpoint)

        response = await send(
            auth, self.resource_server({"new"}, seen), content=b'{"tool":"x"}'
        )

        assert response.status_code == 200
        assert seen == [("old", b'{"tool":"x"}'), ("new", b'{"tool":"x"}')]
        assert len(endpoint.requests) == 2

    async def test_a_second_401_is_returned_without_another_retry(self):
        endpoint = TokenEndpoint(token_json("old"), token_json("new"))
        seen: list[tuple[str, bytes]] = []

        response = await send(oauth2(endpoint), self.resource_server(set(), seen))

        assert response.status_code == 401
        assert len(seen) == 2
        assert len(endpoint.requests) == 2

    async def test_simultaneous_401s_cause_one_new_token_and_one_retry_each(self):
        endpoint = TokenEndpoint(token_json("old"), token_json("new"))
        seen: list[tuple[str, bytes]] = []
        auth = oauth2(endpoint)
        await send(auth, echo_headers([]))

        arrived = 0
        all_arrived = asyncio.Event()

        async def resource_server(request: httpx.Request) -> httpx.Response:
            nonlocal arrived
            token = request.headers["Authorization"].removeprefix("Bearer ")
            seen.append((token, request.content))
            if token == "old":
                arrived += 1
                if arrived == 4:
                    all_arrived.set()
                await all_arrived.wait()
            return httpx.Response(200 if token == "new" else 401)

        responses = await asyncio.gather(
            *(send(auth, resource_server) for _ in range(4))
        )

        assert [r.status_code for r in responses] == [200] * 4
        assert [token for token, _ in seen].count("old") == 4
        assert [token for token, _ in seen].count("new") == 4
        assert len(endpoint.requests) == 2

    async def test_a_401_does_not_discard_a_token_that_is_already_newer(self):
        endpoint = TokenEndpoint(
            token_json("old"), token_json("new"), token_json("newer")
        )
        auth = oauth2(endpoint)
        stale = await auth._get_token()
        assert stale == "old"
        assert await auth._get_token(failed=stale) == "new"

        assert await auth._get_token(failed=stale) == "new"
        assert len(endpoint.requests) == 2


class TestOAuth2Errors:
    async def test_error_responses_report_only_the_status_and_the_rfc_error_code(self):
        body = {"error": "invalid_client", "error_description": f"{SECRET} rejected"}
        auth = oauth2(TokenEndpoint(httpx.Response(401, json=body)))

        with pytest.raises(AuthenticationError) as exc_info:
            await send(auth, echo_headers([]))

        assert (
            str(exc_info.value)
            == "token request failed (HTTP 401, error invalid_client)"
        )

    @pytest.mark.parametrize(
        "response",
        [
            httpx.Response(500, text=f"{SECRET} internal error"),
            httpx.Response(400, json={"error": f"{SECRET}"}),
            httpx.Response(400, json={"error": ["x"]}),
            httpx.Response(400, json=[f"{SECRET}"]),
        ],
    )
    async def test_response_bodies_never_reach_the_message(self, response):
        auth = oauth2(TokenEndpoint(response))
        with pytest.raises(AuthenticationError) as exc_info:
            await send(auth, echo_headers([]))
        assert SECRET not in str(exc_info.value)
        assert str(exc_info.value).startswith("token request failed (HTTP ")

    async def test_transport_errors_report_only_the_exception_class(self):
        def failing(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError(f"cannot connect with {SECRET}")

        auth = build_httpx_auth(parse(basic_oauth2()))
        auth._transport = httpx.MockTransport(failing)

        with pytest.raises(AuthenticationError) as exc_info:
            await send(auth, echo_headers([]))

        assert str(exc_info.value) == "token request failed (ConnectError)"

    @pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
    async def test_a_redirect_is_an_error_and_is_not_followed(self, status: int):
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(
                status, headers={"Location": "https://evil.example.com/steal"}
            )

        auth = build_httpx_auth(parse(basic_oauth2()))
        auth._transport = httpx.MockTransport(handler)

        with pytest.raises(AuthenticationError, match="redirect"):
            await send(auth, echo_headers([]))

        assert seen == [TOKEN_URL]


def jwt_bearer(**overrides: object) -> dict:
    data = basic_oauth2(
        grant_type="urn:ietf:params:oauth:grant-type:JWT-Bearer",
        assertion_signing={
            "issuer": "my-agent",
            "subject": "service-account",
            "audience": "https://aud.example.com/",
            "signing_key": "rsa-2048.pem",
            "algorithm": "RS256",
        },
    )
    data.update(overrides)
    return data


def assertion_of(endpoint: TokenEndpoint, index: int = -1) -> str:
    return endpoint.form(index)["assertion"][0]


class TestOAuth2JwtBearerGrant:
    async def test_the_assertion_is_signed_and_sent_with_the_grant(self):
        endpoint = TokenEndpoint(token_json())
        auth = oauth2(endpoint, jwt_bearer())

        await send(auth, echo_headers([]))

        form = endpoint.form()
        assert form["grant_type"] == [JWT_BEARER]
        assert "client_id" not in form and "client_secret" not in form
        assert endpoint.requests[0].headers["Authorization"].startswith("Basic ")

        assertion = assertion_of(endpoint)
        claims = jwt.decode(
            assertion,
            public_key("rsa-2048.pem"),
            algorithms=["RS256"],
            audience="https://aud.example.com/",
        )
        assert jwt.get_unverified_header(assertion) == {"alg": "RS256", "typ": "JWT"}
        assert set(claims) == {"iss", "aud", "sub", "iat", "exp", "jti"}
        assert claims["iss"] == "my-agent"
        assert claims["sub"] == "service-account"
        assert claims["exp"] == claims["iat"] + 300
        assert isinstance(claims["iat"], int) and isinstance(claims["exp"], int)

    async def test_the_assertion_signature_is_checked_against_the_right_key_only(self):
        endpoint = TokenEndpoint(token_json())
        await send(oauth2(endpoint, jwt_bearer()), echo_headers([]))
        with pytest.raises(jwt.InvalidSignatureError):
            jwt.decode(
                assertion_of(endpoint),
                public_key("rsa-2048-other.pem"),
                algorithms=["RS256"],
                audience="https://aud.example.com/",
            )

    async def test_audience_is_not_derived_from_the_token_url_or_resource(self):
        endpoint = TokenEndpoint(token_json())
        auth = oauth2(
            endpoint,
            jwt_bearer(resource="https://resource.example.com"),
            mcp_url="https://mcp.example.com/mcp",
        )
        await send(auth, echo_headers([]))

        claims = jwt.decode(
            assertion_of(endpoint),
            options={"verify_signature": False, "verify_aud": False},
        )
        assert claims["aud"] == "https://aud.example.com/"
        assert endpoint.form()["resource"] == ["https://resource.example.com"]

    async def test_subject_key_id_and_custom_claims(self):
        endpoint = TokenEndpoint(token_json())
        data = jwt_bearer()
        data["assertion_signing"].update(
            subject="svc",
            key_id="k1",
            audience=["a", "b"],
            algorithm="HS256",
            signing_key=HMAC_KEYS["HS256"],
            custom_claims={"scope": "api:read"},
            expiry_seconds=60,
        )
        await send(oauth2(endpoint, data), echo_headers([]))

        assertion = assertion_of(endpoint)
        claims = jwt.decode(
            assertion, HMAC_KEYS["HS256"], algorithms=["HS256"], audience="a"
        )
        assert jwt.get_unverified_header(assertion) == {
            "alg": "HS256",
            "typ": "JWT",
            "kid": "k1",
        }
        assert claims["sub"] == "svc" and claims["scope"] == "api:read"
        assert claims["aud"] == ["a", "b"]
        assert claims["exp"] == claims["iat"] + 60
        assert "nbf" not in claims

    async def test_every_token_request_signs_a_new_assertion(self):
        clock = FakeClock()
        endpoint = TokenEndpoint(token_json("t1", expires_in=100), token_json("t2"))
        auth = oauth2(endpoint, jwt_bearer(), clock=clock)

        await send(auth, echo_headers([]))
        clock.now += 100
        await send(auth, echo_headers([]))

        def jti(index: int) -> str:
            return jwt.decode(
                assertion_of(endpoint, index),
                options={"verify_signature": False, "verify_aud": False},
            )["jti"]

        assert jti(0) != jti(1)

    async def test_a_401_signs_a_new_assertion_for_the_retry(self):
        endpoint = TokenEndpoint(token_json("old"), token_json("new"))
        seen: list[tuple[str, bytes]] = []

        response = await send(
            oauth2(endpoint, jwt_bearer()),
            TestOAuth2Unauthorized.resource_server({"new"}, seen),
        )

        assert response.status_code == 200
        assert assertion_of(endpoint, 0) != assertion_of(endpoint, 1)

    async def test_post_client_authentication(self):
        endpoint = TokenEndpoint(token_json())
        auth = oauth2(
            endpoint, jwt_bearer(token_endpoint_auth_method="client_secret_post")
        )
        await send(auth, echo_headers([]))
        assert "Authorization" not in endpoint.requests[0].headers
        assert endpoint.form()["client_id"] == ["client"]
        assert endpoint.form()["client_secret"] == ["secret"]

    async def test_no_client_authentication_sends_neither_secret_nor_basic_header(self):
        endpoint = TokenEndpoint(token_json())
        data = jwt_bearer(token_endpoint_auth_method="none")
        del data["client_id"], data["client_secret"]
        await send(oauth2(endpoint, data), echo_headers([]))

        assert "Authorization" not in endpoint.requests[0].headers
        assert set(endpoint.form()) == {"grant_type", "assertion"}

    async def test_no_client_authentication_sends_a_configured_client_id_only(self):
        endpoint = TokenEndpoint(token_json())
        data = jwt_bearer(token_endpoint_auth_method="none")
        del data["client_secret"]
        await send(oauth2(endpoint, data), echo_headers([]))

        assert "Authorization" not in endpoint.requests[0].headers
        assert endpoint.form()["client_id"] == ["client"]
        assert "client_secret" not in endpoint.form()

    async def test_assertion_key_errors_are_reported_when_the_auth_is_built(self):
        data = jwt_bearer()
        data["assertion_signing"]["signing_key"] = "rsa-2047.pem"
        with pytest.raises(AuthenticationError, match="2048 bits"):
            build_httpx_auth(parse(data), base_dir=KEYS)
