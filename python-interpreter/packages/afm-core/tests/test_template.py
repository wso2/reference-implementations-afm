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

import re
from pathlib import Path

import pytest

from afm.authentication import (
    BasicAuthentication,
    BearerAuthentication,
    JwtAuthentication,
)
from afm.http_auth import build_httpx_auth
from afm.parser import parse_afm_file

TEMPLATE = Path(__file__).resolve().parents[4] / "templates" / "agent_template.afm.md"


def test_the_template_loads_and_its_authentication_can_be_built(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in set(
        re.findall(r"\$\{env:(\w+)\}", TEMPLATE.read_text(encoding="utf-8"))
    ):
        monkeypatch.setenv(name, "x" * 40)

    record = parse_afm_file(TEMPLATE)

    servers = record.metadata.tools.mcp
    auth_types = [
        type(server.transport.authentication)
        for server in servers
        if server.transport.type == "http"
    ]
    assert auth_types == [
        BearerAuthentication,
        BasicAuthentication,
        JwtAuthentication,
        type(None),
    ]
    for server in servers:
        if server.transport.type == "http":
            build_httpx_auth(
                server.transport.authentication,
                base_dir=record.source_dir,
                mcp_url=server.transport.url,
            )
    subscription = record.metadata.interfaces[2].subscription
    assert isinstance(subscription.authentication, BearerAuthentication)
