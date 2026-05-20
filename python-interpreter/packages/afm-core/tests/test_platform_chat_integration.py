# Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
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

"""Integration tests for the platformchat interface using a real agent runner with a mock LLM."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from langchain_core.callbacks import AsyncCallbackManagerForLLMRun
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import BaseMessage
from langchain_core.outputs import ChatResult

from afm.interfaces.platform_chat import create_platform_chat_app
from afm.parser import parse_afm_file
from afm_langchain.backend import LangChainRunner


@pytest.fixture
def sample_slack_platform_chat_afm() -> Path:
    return (
        Path(__file__).parent / "fixtures" / "sample_slack_platform_chat_agent.afm.md"
    )


@pytest.fixture
def sample_gchat_platform_chat_afm() -> Path:
    return (
        Path(__file__).parent / "fixtures" / "sample_gchat_platform_chat_agent.afm.md"
    )


@pytest.fixture
def sample_gchat_platform_chat_sync_afm() -> Path:
    return (
        Path(__file__).parent
        / "fixtures"
        / "sample_gchat_platform_chat_sync_agent.afm.md"
    )


class TestPlatformChatIntegration:
    @pytest.mark.asyncio
    async def test_slack_platform_chat_acks_and_runs_agent_in_background(
        self,
        sample_slack_platform_chat_afm: Path,
    ) -> None:
        received_prompts: list[str] = []
        prompt_received = asyncio.Event()

        class TrackingFakeLLM(FakeListChatModel):
            async def _agenerate(
                self,
                messages: list[BaseMessage],
                stop: list[str] | None = None,
                run_manager: AsyncCallbackManagerForLLMRun | None = None,
                **kwargs: Any,
            ) -> ChatResult:
                received_prompts.append(messages[-1].content)
                prompt_received.set()
                return await super()._agenerate(
                    messages, stop=stop, run_manager=run_manager, **kwargs
                )

        fake_llm = TrackingFakeLLM(responses=["Hello from Slack"])
        afm = parse_afm_file(sample_slack_platform_chat_afm, resolve_env=False)
        runner = LangChainRunner(afm, model=fake_llm)
        app = create_platform_chat_app(runner, verify_signatures=False)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/slack",
                json={
                    "type": "event_callback",
                    "event": {"type": "message"},
                    "message": {"text": "Need help with the build"},
                },
                headers={"User-Agent": "Slack"},
            )

        assert response.status_code == 200
        assert response.content == b""
        await asyncio.wait_for(prompt_received.wait(), timeout=5.0)
        assert len(received_prompts) == 1
        assert (
            "[event_callback] Reply to Need help with the build" in received_prompts[0]
        )

    @pytest.mark.asyncio
    async def test_gchat_platform_chat_notification(
        self,
        sample_gchat_platform_chat_afm: Path,
    ) -> None:
        received_prompts: list[str] = []
        prompt_received = asyncio.Event()

        class TrackingFakeLLM(FakeListChatModel):
            async def _agenerate(
                self,
                messages: list[BaseMessage],
                stop: list[str] | None = None,
                run_manager: AsyncCallbackManagerForLLMRun | None = None,
                **kwargs: Any,
            ) -> ChatResult:
                received_prompts.append(messages[-1].content)
                prompt_received.set()
                return await super()._agenerate(
                    messages, stop=stop, run_manager=run_manager, **kwargs
                )

        fake_llm = TrackingFakeLLM(responses=["Hello from GChat"])
        afm = parse_afm_file(sample_gchat_platform_chat_afm, resolve_env=False)
        runner = LangChainRunner(afm, model=fake_llm)
        app = create_platform_chat_app(runner, verify_signatures=False)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/gchat",
                json={
                    "type": "MESSAGE",
                    "message": {
                        "text": "Help with deployment",
                        "sender": {"type": "HUMAN"},
                    },
                },
            )

        assert response.status_code == 202
        await asyncio.wait_for(prompt_received.wait(), timeout=5.0)
        assert len(received_prompts) == 1
        assert "[MESSAGE] Reply to Help with deployment" in received_prompts[0]

    @pytest.mark.asyncio
    async def test_gchat_platform_chat_request_response(
        self,
        sample_gchat_platform_chat_sync_afm: Path,
    ) -> None:
        fake_llm = FakeListChatModel(
            responses=['{"text": "Here is your deployment status."}']
        )
        afm = parse_afm_file(sample_gchat_platform_chat_sync_afm, resolve_env=False)
        runner = LangChainRunner(afm, model=fake_llm)
        app = create_platform_chat_app(runner, verify_signatures=False)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/gchat",
                json={
                    "type": "MESSAGE",
                    "message": {
                        "text": "deployment status",
                        "sender": {"type": "HUMAN"},
                    },
                },
            )

        assert response.status_code == 200
        assert response.json() == {"text": "Here is your deployment status."}
