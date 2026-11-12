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

import pytest
from pydantic import ValidationError

from afm.authentication import (
    ApiKeyAuthentication,
    BasicAuthentication,
    BearerAuthentication,
    JwtAuthentication,
    OAuth2Authentication,
)
from afm.exceptions import AFMValidationError
from afm.models import AgentMetadata, HttpTransport, Model, Subscription
from afm.parser import parse_afm

SECRET = "S3CR3T-VALUE"


def afm_with_token(token: str) -> str:
    return (
        "---\n"
        "tools:\n"
        "  mcp:\n"
        "    - name: server\n"
        "      transport:\n"
        "        type: http\n"
        "        url: https://mcp.example.com/mcp\n"
        "        authentication:\n"
        "          type: bearer\n"
        f'          token: "{token}"\n'
        "---\n# Role\nr\n# Instructions\ni\n"
    )


class TestDeferral:
    def test_unresolved_values_are_not_value_checked_without_resolution(self):
        record = parse_afm(afm_with_token("a ${env:X}"), resolve_env=False)
        transport = record.metadata.tools.mcp[0].transport
        assert transport.authentication.token == "a ${env:X}"

    def test_a_resolved_value_is_checked(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("X", "b")
        with pytest.raises(AFMValidationError, match="must not contain whitespace"):
            parse_afm(afm_with_token("a ${env:X}"))

    def test_a_resolved_value_containing_variable_syntax_is_still_checked(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("X", "has space ${env:Y}")
        with pytest.raises(AFMValidationError, match="whitespace"):
            parse_afm(afm_with_token("${env:X}"))

    def test_values_without_a_variable_are_checked_even_without_resolution(self):
        with pytest.raises(AFMValidationError, match="whitespace"):
            parse_afm(afm_with_token("a b"), resolve_env=False)

    def test_structure_is_checked_without_resolution(self):
        text = afm_with_token("t").replace("          token:", "          tokn:")
        with pytest.raises(
            AFMValidationError, match=r"does not support field\(s\): tokn"
        ):
            parse_afm(text, resolve_env=False)


class TestAuthenticationObjects:
    def test_models_accept_validated_authentication_objects(self):
        transport = HttpTransport(
            url="https://x", authentication=BearerAuthentication(token="t")
        )
        assert transport.authentication.token == "t"

    def test_the_type_is_normalized_to_lowercase(self):
        model = Model(authentication={"type": "API-Key", "api_key": "k"})
        assert isinstance(model.authentication, ApiKeyAuthentication)
        assert model.authentication.type == "api-key"

    def test_the_wire_value_of_the_grant_type_is_canonical(self):
        auth = Subscription(
            protocol="websub",
            authentication={
                "type": "oauth2",
                "grant_type": "URN:IETF:PARAMS:OAUTH:GRANT-TYPE:JWT-BEARER",
                "token_url": "https://idp.example.com/token",
                "token_endpoint_auth_method": "none",
                "assertion_signing": {
                    "issuer": "i",
                    "subject": "s",
                    "audience": "a",
                    "signing_key": "k" * 32,
                    "algorithm": "HS256",
                },
            },
        ).authentication
        assert isinstance(auth, OAuth2Authentication)
        assert auth.grant_type == "urn:ietf:params:oauth:grant-type:jwt-bearer"

    def test_defaults(self):
        assert Model().authentication is None
        auth = JwtAuthentication(issuer="i", audience="a", signing_key="k.pem")
        assert auth.algorithm == "RS256" and auth.expiry_seconds == 300

    def test_basic_authentication_object(self):
        auth = BasicAuthentication(username="u", password="p")
        assert (auth.username, auth.password) == ("u", "p")


INVALID_INPUTS = [
    {"type": SECRET},
    {"type": "bearer", "token": f"{SECRET} x"},
    {"type": "basic", "username": f"a:{SECRET}", "password": "p"},
    {"type": "api-key", "api_key": "k", "header_name": f"bad name {SECRET}"},
    {"type": "bearer", "token": 5},
    {"type": "jwt", "issuer": "i", "audience": 5, "signing_key": SECRET},
    {
        "type": "oauth2",
        "grant_type": f"password-{SECRET}",
        "token_url": f"http://x/{SECRET}",
        "client_id": "c",
        "client_secret": SECRET,
    },
    {"type": "oauth2", "assertion_signing": SECRET},
    SECRET,
]


class TestErrorsNeverContainValues:
    @pytest.mark.parametrize("data", INVALID_INPUTS)
    @pytest.mark.parametrize(
        "build",
        [
            lambda data: Model(authentication=data),
            lambda data: HttpTransport(url="https://x", authentication=data),
            lambda data: Subscription(protocol="websub", authentication=data),
            lambda data: AgentMetadata(model={"authentication": data}),
        ],
        ids=["model", "transport", "subscription", "metadata"],
    )
    def test_validation_errors_do_not_echo_input(self, data, build):
        with pytest.raises(ValidationError) as exc_info:
            build(data)

        error = exc_info.value
        assert SECRET not in str(error)
        assert SECRET not in repr(error)
        structured = error.errors(
            include_input=False, include_context=False, include_url=False
        )
        assert SECRET not in str(structured)

    @pytest.mark.parametrize("data", INVALID_INPUTS)
    def test_parser_messages_do_not_echo_input(self, data):
        import json

        front_matter = json.dumps(
            {
                "tools": {
                    "mcp": [
                        {
                            "name": "s",
                            "transport": {
                                "type": "http",
                                "url": "https://x",
                                "authentication": data,
                            },
                        }
                    ]
                }
            }
        )
        with pytest.raises(AFMValidationError) as exc_info:
            parse_afm(f"---\n{front_matter}\n---\n# Role\nr\n# Instructions\ni\n")

        error = exc_info.value
        for text in (str(error), repr(error), repr(error.args)):
            assert SECRET not in text
        assert error.__cause__ is None and error.__suppress_context__

    def test_an_unsupported_type_is_reported_without_the_value(self):
        with pytest.raises(AFMValidationError) as exc_info:
            parse_afm(
                "---\nmodel:\n  authentication:\n    type: digest\n---\n# Role\nr\n# Instructions\ni\n"
            )
        assert "digest" not in str(exc_info.value)
        assert "must be one of: bearer, basic, api-key, jwt, oauth2" in str(
            exc_info.value
        )

    def test_the_location_names_the_field(self):
        with pytest.raises(AFMValidationError) as exc_info:
            parse_afm(afm_with_token("a b"))
        assert exc_info.value.field == (
            "tools.mcp.0.transport.http.authentication.bearer.token"
        )
