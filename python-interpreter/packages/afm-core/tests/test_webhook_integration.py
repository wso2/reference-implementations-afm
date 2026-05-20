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

"""Integration tests for the webhook interface using a real agent runner with a mock LLM."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from langchain_core.callbacks import AsyncCallbackManagerForLLMRun
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.messages import BaseMessage
from langchain_core.outputs import ChatResult

from fastapi import FastAPI

from afm.interfaces.webhook import create_webhook_app
from afm.parser import parse_afm_file
from afm_langchain.backend import LangChainRunner


@pytest.fixture
def sample_webhook_afm() -> Path:
    return Path(__file__).parent / "fixtures" / "sample_webhook_agent.afm.md"


@pytest.fixture
def fake_llm() -> FakeListChatModel:
    return FakeListChatModel(
        responses=["Order processed successfully. Order ID: 12345 confirmed."]
    )


@pytest.fixture
def webhook_runner(
    sample_webhook_afm: Path, fake_llm: FakeListChatModel
) -> LangChainRunner:
    afm = parse_afm_file(sample_webhook_afm, resolve_env=False)
    return LangChainRunner(afm, model=fake_llm)


@pytest.fixture
def webhook_app(webhook_runner: LangChainRunner) -> FastAPI:
    return create_webhook_app(
        webhook_runner,
        auto_subscribe=False,
        verify_signatures=False,
    )


class TestWebhookIntegration:
    @pytest.mark.asyncio
    async def test_webhook_accepts_and_runs_agent(
        self, webhook_app, webhook_runner: LangChainRunner
    ) -> None:
        transport = ASGITransport(app=webhook_app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/webhook",
                json={"event": "order_created", "order_id": "12345"},
                headers={"User-Agent": "TestClient/1.0"},
            )

        assert response.status_code == 202
        assert response.json() == {"status": "accepted"}

        # Let the background task complete
        await asyncio.sleep(0.1)

    @pytest.mark.asyncio
    async def test_webhook_rejects_invalid_json(self, webhook_app) -> None:
        transport = ASGITransport(app=webhook_app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/webhook",
                content=b"not json",
                headers={"Content-Type": "application/json"},
            )

        assert response.status_code == 400
        assert "Invalid JSON" in response.json()["detail"]

    @pytest.mark.asyncio
    async def test_webhook_template_evaluation(
        self,
        webhook_app,
        fake_llm: FakeListChatModel,
    ) -> None:
        """Verify the prompt template is evaluated with the webhook payload before being sent to the LLM."""
        # Track what the LLM receives by wrapping arun on the runner
        received_prompts: list[str] = []
        prompt_received = asyncio.Event()
        original_agenerate = fake_llm._agenerate

        async def tracking_agenerate(messages, stop=None, run_manager=None, **kwargs):
            # The last message is the HumanMessage with the evaluated prompt
            received_prompts.append(messages[-1].content)
            prompt_received.set()
            return await original_agenerate(
                messages, stop=stop, run_manager=run_manager, **kwargs
            )

        fake_llm._agenerate = tracking_agenerate  # type: ignore[assignment]

        transport = ASGITransport(app=webhook_app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/webhook",
                json={"event": "order_placed", "order_id": "99"},
                headers={"User-Agent": "WebhookTest/2.0"},
            )

        assert response.status_code == 202

        # Wait for the background agent task to invoke the LLM
        await asyncio.wait_for(prompt_received.wait(), timeout=5.0)

        assert len(received_prompts) == 1
        # The AFM template is: "[${http:payload.event}] Process the following order event: ${http:payload}"
        assert "[order_placed]" in received_prompts[0]
        assert "order_id" in received_prompts[0]

    @pytest.mark.asyncio
    async def test_health_endpoint(self, webhook_app) -> None:
        transport = ASGITransport(app=webhook_app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/health")

        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    @pytest.mark.asyncio
    async def test_webhook_multiple_requests(
        self,
        sample_webhook_afm: Path,
    ) -> None:
        """Each webhook invocation should trigger an independent agent run."""
        call_count = 0
        all_calls_seen = asyncio.Event()

        class CountingFakeLLM(FakeListChatModel):
            async def _agenerate(
                self,
                messages: list[BaseMessage],
                stop: list[str] | None = None,
                run_manager: AsyncCallbackManagerForLLMRun | None = None,
                **kwargs: Any,
            ) -> ChatResult:
                nonlocal call_count
                call_count += 1
                if call_count == 3:
                    all_calls_seen.set()
                return await super()._agenerate(
                    messages, stop=stop, run_manager=run_manager, **kwargs
                )

        fake_llm = CountingFakeLLM(
            responses=[
                "Processed event 1",
                "Processed event 2",
                "Processed event 3",
            ]
        )
        afm = parse_afm_file(sample_webhook_afm, resolve_env=False)
        runner = LangChainRunner(afm, model=fake_llm)
        app = create_webhook_app(runner, auto_subscribe=False, verify_signatures=False)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            for i in range(3):
                response = await client.post(
                    "/webhook",
                    json={"event": f"event_{i}", "seq": i},
                    headers={"User-Agent": "TestClient/1.0"},
                )
                assert response.status_code == 202

        # Wait for all three background agent tasks to complete
        await asyncio.wait_for(all_calls_seen.wait(), timeout=5.0)
        assert call_count == 3

    @pytest.mark.asyncio
    async def test_webhook_acknowledges_before_agent_completes(
        self,
        sample_webhook_afm: Path,
    ) -> None:
        """Verify the webhook returns 202 before the agent finishes running.

        Uses a mock LLM with an artificial delay to prove the response is
        not blocked on agent execution
        """
        agent_delay = 5.0  # seconds the mock LLM will sleep
        call_count = 0

        class SlowFakeLLM(FakeListChatModel):
            async def _agenerate(
                self,
                messages: list[BaseMessage],
                stop: list[str] | None = None,
                run_manager: AsyncCallbackManagerForLLMRun | None = None,
                **kwargs: Any,
            ) -> ChatResult:
                nonlocal call_count
                call_count += 1
                await asyncio.sleep(agent_delay)
                return await super()._agenerate(
                    messages, stop=stop, run_manager=run_manager, **kwargs
                )

        slow_llm = SlowFakeLLM(responses=["Slowly processed."])
        afm = parse_afm_file(sample_webhook_afm, resolve_env=False)
        runner = LangChainRunner(afm, model=slow_llm)
        app = create_webhook_app(runner, auto_subscribe=False, verify_signatures=False)

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            before = time.monotonic()
            response = await client.post(
                "/webhook",
                json={"event": "slow_test", "order_id": "1"},
                headers={"User-Agent": "TestClient/1.0"},
            )
            elapsed = time.monotonic() - before

        assert response.status_code == 202
        # The response must arrive well before the agent delay completes
        assert elapsed < 2.0, (
            f"Webhook responded in {elapsed:.2f}s; expected fast ack (<2s) "
            f"while agent runs for ~{agent_delay}s in the background"
        )

        # Wait for the background agent to finish and verify it actually ran
        await asyncio.sleep(agent_delay + 0.5)
        assert call_count == 1, "Slow mock LLM should have been invoked exactly once"
