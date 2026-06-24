from __future__ import annotations

import asyncio
import hashlib
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from typing import Any


if "httpx" not in sys.modules:
    httpx_stub = types.ModuleType("httpx")

    class HTTPStatusError(Exception):
        def __init__(self, *args, response=None, **kwargs):
            super().__init__(*args)
            self.response = response

    class AsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def aclose(self) -> None:
            pass

    httpx_stub.HTTPStatusError = HTTPStatusError
    httpx_stub.AsyncClient = AsyncClient
    sys.modules["httpx"] = httpx_stub

if "fastapi" not in sys.modules:
    fastapi_stub = types.ModuleType("fastapi")

    class HTTPException(Exception):
        def __init__(self, status_code: int = 500, detail: Any = None):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class Request:
        pass

    class FastAPI:
        def __init__(self, *args, **kwargs):
            pass

        def get(self, *args, **kwargs):
            return lambda func: func

        def post(self, *args, **kwargs):
            return lambda func: func

        def on_event(self, *args, **kwargs):
            return lambda func: func

    def Header(default=None, *args, **kwargs):
        return default

    fastapi_stub.FastAPI = FastAPI
    fastapi_stub.Header = Header
    fastapi_stub.HTTPException = HTTPException
    fastapi_stub.Request = Request
    sys.modules["fastapi"] = fastapi_stub

    responses_stub = types.ModuleType("fastapi.responses")

    class Response:
        def __init__(self, *args, **kwargs):
            pass

    class JSONResponse(Response):
        pass

    class StreamingResponse(Response):
        pass

    responses_stub.JSONResponse = JSONResponse
    responses_stub.Response = Response
    responses_stub.StreamingResponse = StreamingResponse
    sys.modules["fastapi.responses"] = responses_stub

if "yaml" not in sys.modules:
    yaml_stub = types.ModuleType("yaml")
    yaml_stub.YAMLError = Exception
    yaml_stub.safe_load = lambda text: {}
    sys.modules["yaml"] = yaml_stub


sys.path.insert(0, str(Path(__file__).resolve().parent))
import app as router  # noqa: E402
from modelnet_gateway import backend_adapters  # noqa: E402


class FakeTenant:
    tenant_id = "test"
    trace_allowed = False
    allowed_runners = ()

    def allows_model(self, model_id: str) -> bool:
        return True

    def allows_runner(self, runner: str) -> bool:
        return True

    def allows_aggregator(self, aggregator: str) -> bool:
        return True


def candidate(
    model_id: str,
    *,
    backend_type: str = "custom_http",
    metadata: dict[str, Any] | None = None,
) -> router.Candidate:
    return router.Candidate(
        model_id=model_id,
        backend_type=backend_type,
        k8s_namespace="inference",
        backend_model=model_id,
        root_url="http://127.0.0.1",
        api_base="http://127.0.0.1/v1",
        service_names=(model_id,),
        metadata=metadata or {},
    )


def request_for(prompt: str, runner_config: dict[str, Any] | None = None) -> router.EnsembleRequest:
    return router.EnsembleRequest(
        request_id="test-request",
        runner="auto",
        aggregator="auto",
        runner_config=runner_config or {},
        sources=[
            router.EnsembleSource(
                source_id="input",
                prompt=prompt,
                messages=[{"role": "user", "content": prompt}],
                sampling_params={"max_tokens": 64},
            )
        ],
    )


async def collect_events(stream) -> list[tuple[str, dict[str, Any]]]:
    events: list[tuple[str, dict[str, Any]]] = []
    async for chunk in stream:
        events.append(router.parse_sse_chunk(chunk))
    return events


async def collect_openai_content_deltas(stream) -> list[str]:
    deltas: list[str] = []
    async for chunk in stream:
        _event, data = router.parse_sse_chunk(chunk)
        if data.get("raw") == "[DONE]":
            continue
        choices = data.get("choices")
        if not isinstance(choices, list) or not choices:
            continue
        choice = choices[0]
        if not isinstance(choice, dict):
            continue
        delta = choice.get("delta")
        if isinstance(delta, dict) and delta.get("content"):
            deltas.append(str(delta.get("content") or ""))
    return deltas


async def collect_openai_deltas(stream) -> tuple[list[str], list[str]]:
    content_deltas: list[str] = []
    reasoning_deltas: list[str] = []
    async for chunk in stream:
        _event, data = router.parse_sse_chunk(chunk)
        if data.get("raw") == "[DONE]":
            continue
        choices = data.get("choices")
        if not isinstance(choices, list) or not choices:
            continue
        choice = choices[0]
        if not isinstance(choice, dict):
            continue
        delta = choice.get("delta")
        if not isinstance(delta, dict):
            continue
        if delta.get("content"):
            content_deltas.append(str(delta.get("content") or ""))
        if delta.get("reasoning_content"):
            reasoning_deltas.append(str(delta.get("reasoning_content") or ""))
    return content_deltas, reasoning_deltas


async def collect_openai_modelnet_events(stream) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    async for chunk in stream:
        _event, data = router.parse_sse_chunk(chunk)
        if data.get("raw") == "[DONE]":
            continue
        modelnet_event = data.get("modelnet_event")
        if isinstance(modelnet_event, dict):
            events.append(modelnet_event)
    return events


async def collect_openai_content(stream) -> str:
    return "".join(await collect_openai_content_deltas(stream))


async def fake_stream_response_source_from_result(source: router.EnsembleSource, result: dict[str, Any]):
    backend = result.get("backend")
    model = str((backend or {}).get("id") or source.model_alias or source.source_id)
    if backend is not None:
        yield {"event": "selected", "source_id": source.source_id, "backend": backend, "model": model}
    yield {"event": "started", "source_id": source.source_id, "backend": backend, "model": model}
    text = str(result.get("text") or "")
    if result.get("error") is None and text:
        yield {
            "event": "delta",
            "source_id": source.source_id,
            "backend": backend,
            "model": model,
            "delta": text,
            "text": text,
        }
    if result.get("error") is None:
        yield {
            "event": "completed",
            "source_id": source.source_id,
            "backend": backend,
            "model": model,
            "result": result,
        }
    else:
        yield {
            "event": "failed",
            "source_id": source.source_id,
            "backend": backend,
            "model": model,
            "error": result.get("error"),
            "result": result,
        }


def done_payload(events: list[tuple[str, dict[str, Any]]]) -> dict[str, Any]:
    return [data for event, data in events if event == "done"][0]


class AdaptiveAutoTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.tenant = FakeTenant()
        self.scored = [
            (candidate("qwen-7b"), 10.0, "ready"),
            (candidate("llama-8b"), 120.0, "ready"),
            (candidate("granite-3b"), 240.0, "ready"),
        ]
        self.original_pick_source_candidate = router.pick_source_candidate
        self.original_pick_candidate = router.pick_candidate
        self.original_load_candidates = router.load_candidates
        self.original_backend_generate_text = router.backend_generate_text
        self.original_backend_stream_chat = router.backend_stream_chat
        self.original_http_client = router.http_client
        self.original_context_length_cache = dict(router.context_length_cache)
        self.original_scored_candidate_pool = router.scored_candidate_pool
        self.original_visible_candidates = router.visible_candidates
        self.original_generate_text = router.generate_text
        self.original_generate_response_source = router.generate_response_source
        self.original_stream_response_source = router.stream_response_source
        self.original_generate_response_synthesis = router.generate_response_synthesis
        self.original_stream_response_synthesis = router.stream_response_synthesis
        self.original_trace_path = router.AUTO_ROUTER_TRACE_PATH
        self.original_claim_enabled = router.CLAIM_MEMORY_ENABLED
        self.original_claim_db_path = router.CLAIM_MEMORY_DB_PATH
        self.original_claim_timeout_ms = router.CLAIM_MEMORY_TIMEOUT_MS
        self.original_claim_inject_limit = router.CLAIM_MEMORY_INJECT_LIMIT
        router.AUTO_ROUTER_TRACE_PATH = Path("/tmp/modelnet-router-test-trace.jsonl")

    def tearDown(self) -> None:
        router.pick_source_candidate = self.original_pick_source_candidate
        router.pick_candidate = self.original_pick_candidate
        router.load_candidates = self.original_load_candidates
        router.backend_generate_text = self.original_backend_generate_text
        router.backend_stream_chat = self.original_backend_stream_chat
        router.http_client = self.original_http_client
        router.context_length_cache = dict(self.original_context_length_cache)
        router.scored_candidate_pool = self.original_scored_candidate_pool
        router.visible_candidates = self.original_visible_candidates
        router.generate_text = self.original_generate_text
        router.generate_response_source = self.original_generate_response_source
        router.stream_response_source = self.original_stream_response_source
        router.generate_response_synthesis = self.original_generate_response_synthesis
        router.stream_response_synthesis = self.original_stream_response_synthesis
        router.AUTO_ROUTER_TRACE_PATH = self.original_trace_path
        router.CLAIM_MEMORY_ENABLED = self.original_claim_enabled
        router.CLAIM_MEMORY_DB_PATH = self.original_claim_db_path
        router.CLAIM_MEMORY_TIMEOUT_MS = self.original_claim_timeout_ms
        router.CLAIM_MEMORY_INJECT_LIMIT = self.original_claim_inject_limit

    def assert_call_ledger(self, metadata: dict[str, Any], stages: set[str]) -> None:
        ledger = metadata.get("call_ledger")
        self.assertIsInstance(ledger, list)
        self.assertGreaterEqual(len(ledger), len(stages))
        self.assertEqual(metadata.get("internal_call_count"), len(ledger))
        self.assertGreaterEqual(metadata.get("internal_total_tokens"), 0)
        self.assertIn("internal_usage", metadata)
        self.assertIn("stage_latencies_ms", metadata)
        self.assertIn("call_ledger_summary", metadata)
        self.assertTrue(stages.issubset({str(item.get("stage")) for item in ledger}))

    def assert_no_response_prompt_control_leakage(self, text: str) -> None:
        lowered = text.lower()
        forbidden = [
            "/no_think",
            "now provide only the final answer",
            "return only the final answer",
            "final answer only",
            "hidden reasoning",
            "scratchpad",
            "direct answer",
            "\u7bc7\u5e45\u9650\u5236",
            "\u76f4\u63a5\u56de\u7b54",
        ]
        for phrase in forbidden:
            self.assertNotIn(phrase.lower(), lowered)

    def test_modelnet_auto_openai_payload_normalizes_to_auto_network(self) -> None:
        ir = router.openai_chat_to_ir(
            {
                'model': router.PUBLIC_AUTO_MODEL_NAME,
                'messages': [{'role': 'user', 'content': 'hello'}],
                'modelnet': {'collaboration_plan': {'runner_config': {'strategy': 'adaptive_sparse_graph'}}},
            }
        )
        ensemble = router.ir_to_ensemble_request(ir)

        self.assertEqual(ir.collaboration_plan['runner'], 'auto.network')
        self.assertEqual(ir.collaboration_plan['aggregator'], 'auto')
        self.assertEqual(ensemble.runner, 'auto')
        self.assertEqual(ensemble.runner_config['native_runner'], 'auto.network')

    def test_modelnet_auto_preserves_explicit_collaboration_runner(self) -> None:
        ir = router.openai_chat_to_ir(
            {
                "model": router.PUBLIC_AUTO_MODEL_NAME,
                "messages": [{"role": "user", "content": "hello"}],
                "modelnet": {
                    "collaboration_plan": {
                        "runner": "response.parallel",
                        "models": ["qwen-7b", "llama-8b"],
                        "runner_config": {"allow_degraded": False},
                    }
                },
            }
        )
        ensemble = router.ir_to_ensemble_request(ir)

        self.assertEqual(ir.collaboration_plan["runner"], "response.parallel")
        self.assertEqual(ir.collaboration_plan["aggregator"], "synthesize")
        self.assertEqual(ensemble.runner, "response_aggregate")
        self.assertEqual(ensemble.runner_config["native_runner"], "response.parallel")
        self.assertEqual(ensemble.runner_config["allow_degraded"], False)
        self.assertEqual([source.model_alias for source in ensemble.sources], ["qwen-7b", "llama-8b"])

    def serial_dify_request(self, serial_topology: dict[str, Any]) -> router.EnsembleRequest:
        return router.EnsembleRequest(
            sources=[router.EnsembleSource(source_id="source-1", prompt="hello")],
            runner="dynamic_collab_route",
            aggregator="dify.dsl",
            runner_config={
                "native_runner": "response.serial",
                "serial_engine": "dify",
                "serial_topology": serial_topology,
            },
            request_id="serial-test",
        )

    def test_serial_dify_preflight_reports_missing_generator_config_before_stream(self) -> None:
        original = (
            router.MODELNET_DIFY_INNER_API_KEY,
            router.MODELNET_DIFY_WORKSPACE_ID,
            router.MODELNET_DIFY_CREATOR_EMAIL,
        )
        try:
            router.MODELNET_DIFY_INNER_API_KEY = ""
            router.MODELNET_DIFY_WORKSPACE_ID = ""
            router.MODELNET_DIFY_CREATOR_EMAIL = ""
            error = router.serial_dify_preflight_error(
                self.serial_dify_request(
                    {
                        "version": "modelnet.serial.v1",
                        "nodes": [
                            {"id": "step-1", "modelId": "model-a"},
                            {"id": "step-2", "modelId": "model-b"},
                        ],
                        "edges": [{"source": "step-1", "target": "step-2"}],
                    }
                )
            )
        finally:
            (
                router.MODELNET_DIFY_INNER_API_KEY,
                router.MODELNET_DIFY_WORKSPACE_ID,
                router.MODELNET_DIFY_CREATOR_EMAIL,
            ) = original

        self.assertIsNotNone(error)
        assert error is not None
        self.assertEqual(error["stage"], "serial.dify.config")
        self.assertEqual(router.serial_dify_preflight_status(error), 503)

    def test_serial_dify_preflight_reports_invalid_topology_before_stream(self) -> None:
        original = (
            router.MODELNET_DIFY_INNER_API_KEY,
            router.MODELNET_DIFY_WORKSPACE_ID,
            router.MODELNET_DIFY_CREATOR_EMAIL,
        )
        try:
            router.MODELNET_DIFY_INNER_API_KEY = "inner-secret"
            router.MODELNET_DIFY_WORKSPACE_ID = "61fa3f27-e7fc-4e7f-813f-bbef43b4ebc2"
            router.MODELNET_DIFY_CREATOR_EMAIL = "15225743339@163.com"
            error = router.serial_dify_preflight_error(
                self.serial_dify_request(
                    {
                        "version": "modelnet.serial.v1",
                        "nodes": [{"id": "step-1", "modelId": "model-a"}],
                        "edges": [],
                    }
                )
            )
        finally:
            (
                router.MODELNET_DIFY_INNER_API_KEY,
                router.MODELNET_DIFY_WORKSPACE_ID,
                router.MODELNET_DIFY_CREATOR_EMAIL,
            ) = original

        self.assertIsNotNone(error)
        assert error is not None
        self.assertEqual(error["stage"], "serial.topology")
        self.assertEqual(router.serial_dify_preflight_status(error), 400)

    async def test_dify_serial_provision_uses_admin_creator_and_topology_hash(self) -> None:
        class FakeResponse:
            is_error = False

            def json(self) -> dict[str, Any]:
                return {"api_key": "app-key", "app_id": "app-1", "workflow_id": "workflow-1"}

        class FakeClient:
            def __init__(self) -> None:
                self.calls: list[dict[str, Any]] = []

            async def post(self, url: str, **kwargs: Any) -> FakeResponse:
                self.calls.append({"url": url, **kwargs})
                return FakeResponse()

        payload = {
            "version": "modelnet.serial.v1",
            "nodes": [
                {"id": "step-1", "modelId": "model-a"},
                {"id": "step-2", "modelId": "model-b"},
            ],
            "edges": [{"source": "step-1", "target": "step-2"}],
        }
        topology = router.parse_serial_topology(payload)
        yaml_content = router.build_serial_dify_dsl(topology)
        fake_client = FakeClient()
        original = (
            router.http_client,
            router.MODELNET_DIFY_INNER_API_BASE,
            router.MODELNET_DIFY_INNER_API_KEY,
            router.MODELNET_DIFY_WORKSPACE_ID,
            router.MODELNET_DIFY_CREATOR_EMAIL,
            dict(router.dify_serial_workflow_cache),
        )
        try:
            router.http_client = fake_client
            router.MODELNET_DIFY_INNER_API_BASE = "http://api:5001/inner/api"
            router.MODELNET_DIFY_INNER_API_KEY = "inner-secret"
            router.MODELNET_DIFY_WORKSPACE_ID = "61fa3f27-e7fc-4e7f-813f-bbef43b4ebc2"
            router.MODELNET_DIFY_CREATOR_EMAIL = "15225743339@163.com"
            router.dify_serial_workflow_cache.clear()
            result = await router.provision_dify_serial_workflow(topology, yaml_content)
        finally:
            (
                router.http_client,
                router.MODELNET_DIFY_INNER_API_BASE,
                router.MODELNET_DIFY_INNER_API_KEY,
                router.MODELNET_DIFY_WORKSPACE_ID,
                router.MODELNET_DIFY_CREATOR_EMAIL,
                cache,
            ) = original
            router.dify_serial_workflow_cache.clear()
            router.dify_serial_workflow_cache.update(cache)

        self.assertEqual(result["api_key"], "app-key")
        self.assertEqual(len(fake_client.calls), 1)
        call = fake_client.calls[0]
        self.assertIn(
            "/enterprise/workspaces/61fa3f27-e7fc-4e7f-813f-bbef43b4ebc2/modelnet/dsl/provision",
            call["url"],
        )
        request_json = call["json"]
        self.assertEqual(request_json["creator_email"], "15225743339@163.com")
        self.assertEqual(request_json["external_key"], topology.hash)
        self.assertEqual(request_json["topology_hash"], topology.hash)
        self.assertEqual(request_json["yaml_content"], yaml_content)
        self.assertNotIn("api_key", request_json)
        self.assertEqual(call["headers"]["X-Inner-Api-Key"], "inner-secret")


    def test_openai_responses_payload_normalizes_to_auto_network(self) -> None:
        chat_body = router.openai_responses_to_chat_body(
            {
                "model": router.PUBLIC_AUTO_MODEL_NAME,
                "instructions": "Be concise.",
                "input": [
                    {"role": "user", "content": [{"type": "input_text", "text": "hello"}]},
                ],
                "max_output_tokens": 42,
                "stream": True,
                "tools": [{"type": "web_search"}],
            }
        )
        ir = router.openai_chat_to_ir(chat_body)
        ensemble = router.ir_to_ensemble_request(ir)

        self.assertEqual(chat_body["messages"][0], {"role": "system", "content": "Be concise."})
        self.assertEqual(chat_body["messages"][1], {"role": "user", "content": "hello"})
        self.assertEqual(chat_body["max_tokens"], 42)
        self.assertNotIn("tools", chat_body)
        self.assertEqual(ir.collaboration_plan["runner"], "auto.network")
        self.assertEqual(ensemble.runner, "auto")

    def test_openai_response_payload_contains_responses_api_output_text(self) -> None:
        payload = router.openai_response_payload(
            request_id="test-request",
            model=router.PUBLIC_AUTO_MODEL_NAME,
            text="hello back",
            prompt_text="hello",
            metadata={"runner": "auto.network"},
        )

        self.assertEqual(payload["object"], "response")
        self.assertEqual(payload["status"], "completed")
        self.assertEqual(payload["output_text"], "hello back")
        self.assertEqual(payload["output"][0]["content"][0]["type"], "output_text")
        self.assertEqual(payload["usage"]["total_tokens"], payload["usage"]["input_tokens"] + payload["usage"]["output_tokens"])

    async def test_modelnet_public_entrypoint_is_retired(self) -> None:
        class RetiredRequest:
            async def json(self):
                return {'model': router.PUBLIC_MODEL_NAME, 'messages': [{'role': 'user', 'content': 'hello'}]}

        with self.assertRaises(router.HTTPException) as context:
            await router.chat_completions(RetiredRequest())

        self.assertEqual(context.exception.status_code, 410)
        self.assertEqual(context.exception.detail['error'], 'model_retired')
        self.assertEqual(context.exception.detail['replacement'], router.PUBLIC_AUTO_MODEL_NAME)

    async def test_models_exposes_only_modelnet_auto_public_entrypoint(self) -> None:
        router.visible_candidates = lambda _tenant: [candidate('qwen-7b')]

        payload = await router.models()
        ids = [item['id'] for item in payload['data']]

        self.assertIn(router.PUBLIC_AUTO_MODEL_NAME, ids)
        self.assertNotIn(router.PUBLIC_MODEL_NAME, ids)
        auto_model = next(item for item in payload['data'] if item['id'] == router.PUBLIC_AUTO_MODEL_NAME)
        self.assertEqual(auto_model['metadata']['entry_runner'], 'auto.network')
        self.assertEqual(auto_model['metadata']['native_runner'], 'auto.network')
        self.assertEqual(auto_model['metadata']['default_strategy'], 'role_graph')

    async def stub_scored(self, *args, **kwargs):
        return list(self.scored)

    def test_missing_usage_is_estimated_in_call_ledger(self) -> None:
        entry = router.build_call_ledger_entry(
            stage="candidate.answer",
            source_id="candidate-1",
            backend={"id": "qwen-7b"},
            metadata={},
            prompt_text="Question?",
            completion_text="Answer.",
            status="ok",
            latency_ms=12,
        )

        self.assertEqual(entry["usage_source"], "estimated")
        self.assertGreater(entry["prompt_tokens"], 0)
        self.assertGreater(entry["completion_tokens"], 0)
        self.assertEqual(entry["total_tokens"], entry["prompt_tokens"] + entry["completion_tokens"])

    def test_injected_error_fixture_covers_required_categories(self) -> None:
        fixture = Path(__file__).resolve().parents[1] / "benchmarks" / "fixtures" / "modelnet_claim_injected_errors.jsonl"
        rows = [
            json.loads(line)
            for line in fixture.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        categories = {row["category"] for row in rows}

        self.assertTrue(
            {
                "numeric_error",
                "entity_replacement",
                "conclusion_reversal",
                "historical_context_error",
                "local_deployment_config_error",
            }.issubset(categories)
        )
        for row in rows:
            for key in ("id", "prompt", "clean_answer", "injected_answer", "injected_claim", "risk", "expected_detection"):
                self.assertTrue(row.get(key), f"missing {key} in {row.get('id')}")

    async def test_claim_memory_injects_verified_claim(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "claims.sqlite3"
            router.ClaimMemoryStore(db_path).upsert_claim(
                scope="tenant:test",
                text="The ModelNet router is exposed on 127.0.0.1:3092.",
                status="verified",
                evidence_level="source_grounded",
                entities=["ModelNet router"],
            )
            router.CLAIM_MEMORY_ENABLED = True
            router.CLAIM_MEMORY_DB_PATH = db_path
            router.scored_candidate_pool = self.stub_scored

            planned, plan = await router.plan_auto_ensemble(
                request_for(
                    "What endpoint should I call for the ModelNet router?",
                    {"strategy": "single_best"},
                ),
                self.tenant,
            )

        self.assertTrue(plan["claim_memory"]["enabled"])
        self.assertTrue(plan["claim_memory"]["available"])
        self.assertEqual(plan["claim_memory"]["injected_count"], 1)
        self.assertEqual(plan["injected_claims"][0]["evidence_level"], "source_grounded")
        first_message = planned.sources[0].messages[0]
        self.assertEqual(first_message["role"], "system")
        self.assertIn("Verified project facts", first_message["content"])
        self.assertIn("127.0.0.1:3092", first_message["content"])

    async def test_claim_memory_contested_claim_is_signal_not_injected_fact(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "claims.sqlite3"
            router.ClaimMemoryStore(db_path).upsert_claim(
                scope="tenant:test",
                text="The ModelNet router is exposed on /var/log/modelnet/router_trace.jsonl.",
                status="contested",
                evidence_level="source_grounded",
                entities=["ModelNet router"],
            )
            router.CLAIM_MEMORY_ENABLED = True
            router.CLAIM_MEMORY_DB_PATH = db_path
            router.scored_candidate_pool = self.stub_scored

            planned, plan = await router.plan_auto_ensemble(
                request_for(
                    "Where is the ModelNet router exposed?",
                    {"strategy": "single_best"},
                ),
                self.tenant,
            )

        self.assertEqual(plan["claim_memory"]["injected_count"], 0)
        self.assertEqual(plan["claim_memory"]["contested_count"], 1)
        self.assertEqual(plan["injected_claims"], [])
        self.assertEqual(len(plan["contested_claims"]), 1)
        rendered_messages = json.dumps(planned.sources[0].messages, ensure_ascii=False)
        self.assertNotIn("/var/log/modelnet/router_trace.jsonl", rendered_messages)

    async def test_claim_memory_unavailable_fails_open(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            router.CLAIM_MEMORY_ENABLED = True
            router.CLAIM_MEMORY_DB_PATH = Path(tmpdir)
            router.CLAIM_MEMORY_TIMEOUT_MS = 50
            router.scored_candidate_pool = self.stub_scored

            planned, plan = await router.plan_auto_ensemble(
                request_for("Say hello.", {"strategy": "single_best"}),
                self.tenant,
            )

        self.assertEqual(planned.runner, "route")
        self.assertTrue(plan["claim_memory"]["enabled"])
        self.assertFalse(plan["claim_memory"]["available"])
        self.assertEqual(plan["injected_claims"], [])

    def test_claim_graph_runner_is_registered(self) -> None:
        self.assertEqual(router.canonical_runner("claim_graph"), "auto.claim_graph")
        self.assertIn("auto.claim_graph", router.RUNNER_PLUGINS)
        self.assertEqual(router.RUNNER_PLUGINS["auto.claim_graph"].legacy_name, "claim_graph")

    def test_role_graph_runner_is_registered(self) -> None:
        self.assertEqual(router.canonical_runner("role_graph"), "auto.role_graph")
        self.assertIn("auto.role_graph", router.RUNNER_PLUGINS)
        self.assertEqual(router.RUNNER_PLUGINS["auto.role_graph"].legacy_name, "role_graph")

    async def test_claim_graph_strategy_selects_claim_graph_runner(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            router.CLAIM_MEMORY_DB_PATH = Path(tmpdir) / "claims.sqlite3"
            router.CLAIM_MEMORY_ENABLED = False
            router.scored_candidate_pool = self.stub_scored

            planned, plan = await router.plan_auto_ensemble(
                request_for(
                    "According to the deployment notes, explain the ModelNet router endpoint and risk.",
                    {"strategy": "claim_graph"},
                ),
                self.tenant,
            )

        self.assertEqual(planned.runner, "claim_graph")
        self.assertEqual(planned.aggregator, "auto")
        self.assertEqual(plan["runner"], "auto.claim_graph")
        self.assertEqual(plan["plan_version"], "claim_graph_v1")
        self.assertTrue(plan["claim_memory"]["enabled"])
        self.assertIn("claim_graph", planned.runner_config)

    async def test_claim_graph_runner_extracts_verifies_and_records_metadata(self) -> None:
        async def fake_generate(_tenant, source, **_kwargs):
            if source.source_id == "proposer":
                return {
                    "source_id": source.source_id,
                    "backend": {"id": "qwen-7b"},
                    "text": "The ModelNet router listens on 127.0.0.1:3092.",
                    "metadata": {"usage": {"prompt_tokens": 5, "completion_tokens": 8, "total_tokens": 13}},
                    "weight": source.weight,
                    "error": None,
                }
            if source.source_id == "claim-extractor":
                return {
                    "source_id": source.source_id,
                    "backend": {"id": "llama-8b"},
                    "text": json.dumps(
                        {
                            "claims": [
                                {
                                    "text": "The ModelNet router listens on 127.0.0.1:3092.",
                                    "question": "Does the ModelNet router listen on 127.0.0.1:3092?",
                                    "risk": "high",
                                }
                            ]
                        }
                    ),
                    "metadata": {},
                    "weight": source.weight,
                    "error": None,
                }
            return {
                "source_id": source.source_id,
                "backend": {"id": "granite-3b"},
                "text": '{"verdict":"supported","confidence":0.9,"reason":"matches the deployment note"}',
                "metadata": {},
                "weight": source.weight,
                "error": None,
            }

        with tempfile.TemporaryDirectory() as tmpdir:
            router.CLAIM_MEMORY_DB_PATH = Path(tmpdir) / "claims.sqlite3"
            router.generate_response_source = fake_generate
            req = router.EnsembleRequest(
                request_id="claim-graph-ok",
                runner="claim_graph",
                aggregator="auto",
                runner_config={
                    "original_prompt": "Where does the ModelNet router listen?",
                    "claim_graph": {"frontier_k": 1, "verify_max_tokens": 32, "extract_max_tokens": 64},
                    "auto_plan": {
                        "claim_memory": {"scopes": ["tenant:test"]},
                        "injected_claims": [],
                        "contested_claims": [],
                    },
                },
                sources=[
                    router.EnsembleSource(source_id="proposer", model_alias="qwen-7b", prompt="Question?"),
                    router.EnsembleSource(source_id="verifier", model_alias="llama-8b", prompt="Question?"),
                ],
            )

            events = await collect_events(router.run_claim_graph_ensemble(req, self.tenant))

        done = done_payload(events)
        metadata = done["metadata"]
        self.assertEqual(metadata["shortcut"], "none")
        self.assertEqual(len(metadata["claim_frontier"]), 1)
        self.assertEqual(metadata["votes"][0]["verdict"], "supported")
        self.assertEqual(metadata["claim_writeback"]["status"], "ok")
        self.assert_call_ledger(metadata, {"claim.proposer", "claim.extract", "claim.verify"})

    async def test_claim_graph_extraction_failure_returns_draft(self) -> None:
        async def fake_generate(_tenant, source, **_kwargs):
            if source.source_id == "claim-extractor":
                return {
                    "source_id": source.source_id,
                    "backend": {"id": "llama-8b"},
                    "text": "not json",
                    "metadata": {},
                    "weight": source.weight,
                    "error": None,
                }
            return {
                "source_id": source.source_id,
                "backend": {"id": "qwen-7b"},
                "text": "draft answer",
                "metadata": {},
                "weight": source.weight,
                "error": None,
            }

        with tempfile.TemporaryDirectory() as tmpdir:
            router.CLAIM_MEMORY_DB_PATH = Path(tmpdir) / "claims.sqlite3"
            router.generate_response_source = fake_generate
            req = router.EnsembleRequest(
                request_id="claim-graph-extraction-fail",
                runner="claim_graph",
                aggregator="auto",
                runner_config={
                    "original_prompt": "Question?",
                    "claim_graph": {"frontier_k": 1},
                    "auto_plan": {"claim_memory": {"scopes": ["tenant:test"]}, "injected_claims": [], "contested_claims": []},
                },
                sources=[
                    router.EnsembleSource(source_id="proposer", model_alias="qwen-7b", prompt="Question?"),
                    router.EnsembleSource(source_id="verifier", model_alias="llama-8b", prompt="Question?"),
                ],
            )

            events = await collect_events(router.run_claim_graph_ensemble(req, self.tenant))

        done = done_payload(events)
        self.assertEqual(done["text"], "draft answer")
        self.assertEqual(done["metadata"]["shortcut"], "extraction_failed")
        self.assert_call_ledger(done["metadata"], {"claim.proposer", "claim.extract"})

    async def test_default_selects_role_graph(self) -> None:
        router.scored_candidate_pool = self.stub_scored
        planned, plan = await router.plan_auto_ensemble(request_for("Say hello."), self.tenant)

        self.assertEqual(planned.runner, "role_graph")
        self.assertEqual(plan["runner"], "auto.role_graph")
        self.assertEqual(plan["plan_version"], "role_graph_v1")
        self.assertEqual(plan["strategy"], "role_graph")
        self.assertEqual(plan["source_count"], 2)
        self.assertEqual(plan["call_budget"]["max_sources"], 2)
        self.assertEqual(planned.runner_config["auto_strategy"], "role_graph")
        self.assertEqual(len(plan["selected_roles"]["experts"]), 2)

    async def test_route_once_outputs_call_ledger(self) -> None:
        async def fake_pick(_tenant, _source, required_capabilities=None):
            return candidate("qwen-7b"), 10.0, "ready"

        async def fake_generate_text(_candidate, _source, *, prompt_override=None, **_kwargs):
            return {
                "text": "route answer",
                "metadata": {"usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7}},
            }

        router.pick_source_candidate = fake_pick
        router.generate_text = fake_generate_text
        req = router.EnsembleRequest(
            request_id="route-ledger",
            runner="route",
            aggregator="load_aware",
            sources=[router.EnsembleSource(source_id="source-1", prompt="Question?")],
        )
        events = await collect_events(router.run_route_ensemble(req, self.tenant))
        done = done_payload(events)

        self.assertEqual(done["text"], "route answer")
        self.assert_call_ledger(done["metadata"], {"route.once"})
        self.assertEqual(done["metadata"]["internal_total_tokens"], 7)

    async def test_explicit_adaptive_sparse_selects_rank_fuse(self) -> None:
        router.scored_candidate_pool = self.stub_scored
        planned, plan = await router.plan_auto_ensemble(
            request_for(
                "Analyze and compare the design tradeoffs, risks, and implementation plan.",
                {"strategy": "adaptive_sparse_graph"},
            ),
            self.tenant,
        )

        self.assertEqual(planned.runner, "rank_fuse")
        self.assertEqual(plan["runner"], "auto.rank_fuse")
        self.assertEqual(plan["plan_version"], "rank_fuse_v2")
        self.assertEqual(plan["strategy"], "adaptive_sparse_graph")
        self.assertEqual(plan["source_count"], 2)
        self.assertIn("ranker", plan)

    async def test_high_load_does_not_select_three_source_role_graph(self) -> None:
        self.scored = [
            (candidate("qwen-7b"), 1200.0, "ready"),
            (candidate("llama-8b"), 1300.0, "ready"),
            (candidate("granite-3b"), 1400.0, "ready"),
        ]
        router.scored_candidate_pool = self.stub_scored
        _, plan = await router.plan_auto_ensemble(
            request_for(
                "Design and analyze a careful multi-step migration plan with tradeoffs.",
                {"strategy": "role_graph", "max_auto_sources": 3},
            ),
            self.tenant,
        )

        self.assertLessEqual(plan["source_count"], 2)
        self.assertEqual(plan["load_state"], "shed")

    async def test_verifier_passes_without_escalation(self) -> None:
        async def fake_generate(_tenant, source, **_kwargs):
            if source.source_id == "verifier":
                text = '{"pass": true, "confidence": 0.91, "reason": "complete"}'
            else:
                text = "primary answer"
            return {
                "source_id": source.source_id,
                "backend": {"id": source.model_alias or source.source_id},
                "text": text,
                "metadata": {},
                "weight": source.weight,
                "error": None,
            }

        router.generate_response_source = fake_generate
        req = router.EnsembleRequest(
            request_id="cascade-pass",
            runner="cascade_verify",
            aggregator="verify_then_escalate",
            runner_config={"cascade_verify": {"max_extra_calls": 1}},
            sources=[
                router.EnsembleSource(source_id="primary", model_alias="qwen-7b", prompt="Question?"),
                router.EnsembleSource(source_id="escalation", model_alias="llama-8b", prompt="Question?"),
            ],
        )
        events = await collect_events(router.run_cascade_verify_ensemble(req, self.tenant))
        done = done_payload(events)

        self.assertEqual(done["text"], "primary answer")
        self.assertEqual(done["metadata"]["source_count"], 1)
        self.assertEqual(done["metadata"]["escalation_reason"], "verifier_passed")
        self.assert_call_ledger(done["metadata"], {"primary.answer", "verifier.check"})

    async def test_verifier_failure_escalates_with_budget(self) -> None:
        async def fake_generate(_tenant, source, **_kwargs):
            if source.source_id == "verifier":
                text = '{"pass": false, "confidence": 0.22, "reason": "missing details"}'
            elif source.source_id == "escalation":
                text = "escalated answer"
            else:
                text = "primary answer"
            return {
                "source_id": source.source_id,
                "backend": {"id": source.model_alias or source.source_id},
                "text": text,
                "metadata": {},
                "weight": source.weight,
                "error": None,
            }

        router.generate_response_source = fake_generate
        req = router.EnsembleRequest(
            request_id="cascade-fail",
            runner="cascade_verify",
            aggregator="verify_then_escalate",
            runner_config={"cascade_verify": {"max_extra_calls": 1}},
            sources=[
                router.EnsembleSource(source_id="primary", model_alias="qwen-7b", prompt="Question?"),
                router.EnsembleSource(source_id="escalation", model_alias="llama-8b", prompt="Question?"),
            ],
        )
        events = await collect_events(router.run_cascade_verify_ensemble(req, self.tenant))
        done = done_payload(events)

        self.assertEqual(done["text"], "escalated answer")
        self.assertEqual(done["metadata"]["source_count"], 2)
        self.assertEqual(done["metadata"]["escalation_reason"], "verifier_failed_escalated")
        self.assert_call_ledger(done["metadata"], {"primary.answer", "verifier.check", "optional.escalation"})

    async def test_rank_fuse_high_confidence_selects_candidate(self) -> None:
        async def fake_generate(_tenant, source, **_kwargs):
            texts = {
                "candidate-1": "weaker answer",
                "candidate-2": "better answer",
                "ranker": '{"winner_source_id": "candidate-2", "confidence": 0.93, "should_fuse": false, "reason": "better"}',
            }
            return {
                "source_id": source.source_id,
                "backend": {"id": source.model_alias or source.source_id},
                "text": texts[source.source_id],
                "metadata": {},
                "weight": source.weight,
                "error": None,
            }

        router.generate_response_source = fake_generate
        req = router.EnsembleRequest(
            request_id="rank-select",
            runner="rank_fuse",
            aggregator="rank_then_fuse",
            runner_config={"rank_fuse": {"confidence_threshold": 0.72}},
            sources=[
                router.EnsembleSource(source_id="candidate-1", model_alias="qwen-7b", prompt="Question?"),
                router.EnsembleSource(source_id="candidate-2", model_alias="llama-8b", prompt="Question?"),
            ],
        )
        events = await collect_events(router.run_rank_fuse_ensemble(req, self.tenant))
        done = done_payload(events)

        self.assertEqual(done["text"], "better answer")
        self.assertEqual(done["metadata"]["selected_source_id"], "candidate-2")
        self.assertEqual(done["metadata"]["escalation_reason"], "ranker_selected")
        self.assert_call_ledger(done["metadata"], {"candidate.answer", "ranker.select"})

    async def test_rank_fuse_low_confidence_synthesizes(self) -> None:
        async def fake_generate(_tenant, source, **_kwargs):
            texts = {
                "candidate-1": "partial answer A",
                "candidate-2": "partial answer B",
                "ranker": '{"winner_source_id": "candidate-1", "confidence": 0.41, "should_fuse": true, "reason": "complementary"}',
            }
            return {
                "source_id": source.source_id,
                "backend": {"id": source.model_alias or source.source_id},
                "text": texts[source.source_id],
                "metadata": {},
                "weight": source.weight,
                "error": None,
            }

        async def fake_synthesis(_request, _tenant, responses):
            self.assertEqual(len(responses), 2)
            return {
                "source_id": "__response_aggregator__",
                "backend": {"id": "qwen-7b"},
                "text": "fused answer",
                "metadata": {},
            }, {"instruction": "test", "prompt_chars": 12}

        router.generate_response_source = fake_generate
        router.generate_response_synthesis = fake_synthesis
        req = router.EnsembleRequest(
            request_id="rank-fuse",
            runner="rank_fuse",
            aggregator="rank_then_fuse",
            runner_config={"rank_fuse": {"confidence_threshold": 0.72}},
            sources=[
                router.EnsembleSource(source_id="candidate-1", model_alias="qwen-7b", prompt="Question?"),
                router.EnsembleSource(source_id="candidate-2", model_alias="llama-8b", prompt="Question?"),
            ],
        )
        events = await collect_events(router.run_rank_fuse_ensemble(req, self.tenant))
        done = done_payload(events)

        self.assertEqual(done["text"], "fused answer")
        self.assertEqual(done["metadata"]["escalation_reason"], "ranker_fused")
        self.assertIn("response_aggregator", done["metadata"])
        self.assert_call_ledger(done["metadata"], {"candidate.answer", "ranker.select", "optional.synthesizer.final"})

    async def test_response_aggregate_outputs_call_ledger(self) -> None:
        async def fake_generate(_tenant, source, **_kwargs):
            return {
                "source_id": source.source_id,
                "backend": {"id": source.model_alias or source.source_id},
                "text": f"answer from {source.source_id}",
                "metadata": {},
                "weight": source.weight,
                "error": None,
            }

        async def fake_synthesis(_request, _tenant, responses):
            self.assertEqual(len(responses), 2)
            yield {
                "event": "selected",
                "synthesis": {"source_id": "__response_aggregator__", "backend": {"id": "aggregator"}},
            }
            yield {"event": "token", "delta": "combined "}
            yield {"event": "token", "delta": "answer"}
            yield {
                "event": "done",
                "synthesis": {
                    "source_id": "__response_aggregator__",
                    "backend": {"id": "aggregator"},
                    "text": "combined answer",
                    "metadata": {},
                },
                "metadata": {"instruction": "test", "prompt_chars": 8},
            }

        async def fake_stream(_tenant, source, **_kwargs):
            result = await fake_generate(_tenant, source, **_kwargs)
            async for item in fake_stream_response_source_from_result(source, result):
                yield item

        router.stream_response_source = fake_stream
        router.stream_response_synthesis = fake_synthesis
        req = router.EnsembleRequest(
            request_id="response-aggregate-ledger",
            runner="response_aggregate",
            aggregator="synthesize",
            sources=[
                router.EnsembleSource(source_id="source-1", model_alias="qwen-7b", prompt="Question?"),
                router.EnsembleSource(source_id="source-2", model_alias="llama-8b", prompt="Question?"),
            ],
        )
        events = await collect_events(router.run_response_aggregate_ensemble(req, self.tenant))
        done = done_payload(events)

        token_deltas = [data["delta"] for event, data in events if event == "token"]
        self.assertEqual(token_deltas, ["combined ", "answer"])
        self.assertEqual(done["text"], "combined answer")
        self.assert_call_ledger(done["metadata"], {"response.parallel", "optional.synthesizer.final"})

    def test_response_aggregate_default_prompts_avoid_control_leakage(self) -> None:
        req = router.EnsembleRequest(
            request_id="response-aggregate-prompts",
            runner="response_aggregate",
            aggregator="synthesize",
            sources=[
                router.EnsembleSource(source_id="source-1", model_alias="qwen-7b", prompt="Question?"),
                router.EnsembleSource(source_id="source-2", model_alias="llama-8b", prompt="Question?"),
            ],
        )
        responses = [
            {"source_id": "source-1", "text": "first complete response", "weight": 1.0},
            {"source_id": "source-2", "text": "second complete response", "weight": 1.0},
        ]
        source, instruction, user_prompt = router.build_response_synthesis_source(
            req,
            candidate("aggregator"),
            responses,
        )
        retry_source, retry_instruction, retry_user_prompt = router.build_response_synthesis_source(
            req,
            candidate("aggregator"),
            responses,
            retry_final_only=True,
        )
        prompt_surfaces = [
            json.dumps(source.extra, ensure_ascii=False),
            json.dumps(retry_source.extra, ensure_ascii=False),
            router.DEFAULT_RESPONSE_AGGREGATE_INSTRUCTION,
            router.RESPONSE_AGGREGATE_SYSTEM_PROMPT,
            instruction,
            user_prompt,
            retry_instruction,
            retry_user_prompt,
        ]
        prompt_surfaces.extend(str(message.get("content") or "") for message in source.messages)
        prompt_surfaces.extend(str(message.get("content") or "") for message in retry_source.messages)
        self.assert_no_response_prompt_control_leakage("\n".join(prompt_surfaces))
        expected_extra = {"chat_template_kwargs": {"enable_thinking": False}}
        self.assertEqual(source.extra, expected_extra)
        self.assertEqual(retry_source.extra, expected_extra)

        disabled_req = router.EnsembleRequest(
            request_id="response-aggregate-prompts-disable-thinking",
            runner="response_aggregate",
            aggregator="synthesize",
            runner_config={"disable_internal_thinking": True},
            sources=[
                router.EnsembleSource(source_id="source-1", model_alias="qwen-7b", prompt="Question?"),
                router.EnsembleSource(source_id="source-2", model_alias="llama-8b", prompt="Question?"),
            ],
        )
        disabled_source, _disabled_instruction, _disabled_user_prompt = router.build_response_synthesis_source(
            disabled_req, candidate("aggregator"), responses
        )
        self.assertEqual(disabled_source.extra, {"chat_template_kwargs": {"enable_thinking": False}})


    async def test_response_serial_judge_refine_dispatches_gateway_runner(self) -> None:
        original_gateway = router.run_gateway_serial_ensemble
        original_dify = router.run_dify_serial_ensemble
        calls: list[str] = []

        async def fake_gateway(request, tenant):
            calls.append("gateway")
            yield router.sse("done", {"text": "gateway final", "metadata": {"runner": request.runner}})

        async def fake_dify(_request, _tenant):
            calls.append("dify")
            raise AssertionError("judge_refine serial requests must not call Dify")
            yield b""

        try:
            router.run_gateway_serial_ensemble = fake_gateway
            router.run_dify_serial_ensemble = fake_dify
            req = router.EnsembleRequest(
                request_id="serial-dispatch",
                runner="dynamic_collab_route",
                aggregator="judge_refine",
                runner_config={
                    "native_runner": "response.serial",
                    "serial_topology": {
                        "version": "modelnet.serial.v1",
                        "nodes": [
                            {"id": "step-1", "modelId": "model-a"},
                            {"id": "step-2", "modelId": "model-b"},
                        ],
                        "edges": [{"source": "step-1", "target": "step-2"}],
                    },
                },
                sources=[router.EnsembleSource(source_id="input", prompt="Question?")],
            )

            events = await collect_events(router.run_ensemble_stream(req, self.tenant))
        finally:
            router.run_gateway_serial_ensemble = original_gateway
            router.run_dify_serial_ensemble = original_dify

        self.assertEqual(calls, ["gateway"])
        self.assertEqual(done_payload(events)["text"], "gateway final")

    async def test_gateway_serial_runs_topology_order_and_refines_previous_answer(self) -> None:
        seen: list[dict[str, Any]] = []

        async def fake_pick(_tenant, source, required_capabilities=None):
            return candidate(str(source.model_alias), metadata={"max_model_len": 8192}), 10.0, "ready"

        async def fake_generate(source_candidate, source, **_kwargs):
            seen.append(
                {
                    "model": source_candidate.model_id,
                    "source_id": source.source_id,
                    "prompt": source.prompt,
                    "messages": list(source.messages or []),
                    "extra": dict(source.extra),
                }
            )
            return {"text": f"answer from {source_candidate.model_id}", "metadata": {}}

        router.pick_source_candidate = fake_pick
        router.generate_text = fake_generate
        req = router.EnsembleRequest(
            request_id="serial-local",
            runner="dynamic_collab_route",
            aggregator="judge_refine",
            runner_config={
                "native_runner": "response.serial",
                "serial_topology": {
                    "version": "modelnet.serial.v1",
                    "nodes": [
                        {"id": "step-1", "modelId": "model-a"},
                        {"id": "step-2", "modelId": "model-b"},
                    ],
                    "edges": [{"source": "step-1", "target": "step-2"}],
                },
            },
            sources=[
                router.EnsembleSource(
                    source_id="input",
                    prompt="Question?",
                    messages=[{"role": "user", "content": "Question?"}],
                    sampling_params={"max_tokens": 64},
                )
            ],
        )

        events = await collect_events(router.run_gateway_serial_ensemble(req, self.tenant))
        done = done_payload(events)

        self.assertEqual([item["model"] for item in seen], ["model-a", "model-b"])
        self.assertIn("Question?", seen[1]["prompt"])
        self.assertIn("answer from model-a", seen[1]["prompt"])
        self.assertEqual(seen[0]["messages"][0]["role"], "system")
        self.assertIn("visible user-facing final answer", seen[0]["messages"][0]["content"])
        self.assertNotEqual(
            seen[0]["extra"].get("chat_template_kwargs"),
            {"enable_thinking": False},
        )
        self.assertNotEqual(
            seen[1]["extra"].get("chat_template_kwargs"),
            {"enable_thinking": False},
        )
        self.assertEqual(done["text"], "answer from model-b")
        self.assertFalse(done["metadata"]["used_summaries"])

    async def test_gateway_serial_recovers_visible_answer_after_reasoning_only_step(self) -> None:
        seen: list[dict[str, Any]] = []

        async def fake_pick(_tenant, source, required_capabilities=None):
            return candidate(str(source.model_alias), metadata={"max_model_len": 8192}), 10.0, "ready"

        async def fake_generate(source_candidate, source, **_kwargs):
            seen.append(
                {
                    "model": source_candidate.model_id,
                    "source_id": source.source_id,
                    "prompt": source.prompt,
                    "extra": dict(source.extra),
                }
            )
            if source.source_id == "step-1":
                return {"text": "first answer", "metadata": {}}
            if source.source_id == "step-2":
                return {
                    "text": "",
                    "metadata": {
                        "reasoning_content": "internal comparison notes",
                        "finish_reason": "length",
                    },
                }
            return {"text": "visible final answer", "metadata": {}}

        router.pick_source_candidate = fake_pick
        router.generate_text = fake_generate
        req = router.EnsembleRequest(
            request_id="serial-visible-recovery",
            runner="dynamic_collab_route",
            aggregator="judge_refine",
            runner_config={
                "native_runner": "response.serial",
                "serial_topology": {
                    "version": "modelnet.serial.v1",
                    "nodes": [
                        {"id": "step-1", "modelId": "model-a"},
                        {"id": "step-2", "modelId": "model-b"},
                    ],
                    "edges": [{"source": "step-1", "target": "step-2"}],
                },
            },
            sources=[router.EnsembleSource(source_id="input", prompt="Question?")],
        )

        events = await collect_events(router.run_gateway_serial_ensemble(req, self.tenant))
        done = done_payload(events)

        self.assertIn("step-2__visible_recovery", [item["source_id"] for item in seen])
        recovery_call = [item for item in seen if item["source_id"] == "step-2__visible_recovery"][0]
        self.assertIn("Internal notes", recovery_call["prompt"])
        self.assertEqual(
            recovery_call["extra"].get("chat_template_kwargs"),
            {"enable_thinking": False},
        )
        self.assertEqual(done["text"], "visible final answer")
        recovery = done["metadata"]["serial_steps"][1]["metadata"]["serial_visible_answer_recovery"]
        self.assertTrue(recovery["recovered"])
        self.assertEqual(recovery["reason"], "empty_visible_answer")

    async def test_gateway_serial_rewrites_meta_review_into_visible_answer(self) -> None:
        seen: list[dict[str, Any]] = []

        async def fake_pick(_tenant, source, required_capabilities=None):
            return candidate(str(source.model_alias), metadata={"max_model_len": 8192}), 10.0, "ready"

        async def fake_generate(_candidate, source, **_kwargs):
            seen.append({"source_id": source.source_id, "prompt": source.prompt, "extra": dict(source.extra)})
            if source.source_id == "step-1":
                return {"text": "first answer", "metadata": {}}
            if source.source_id == "step-2":
                return {
                    "text": "**\n    *   Content: It introduces useful facts.\n    *   Issue: The text cuts off mid-sentence.",
                    "metadata": {},
                }
            return {"text": "final user-facing answer", "metadata": {}}

        router.pick_source_candidate = fake_pick
        router.generate_text = fake_generate
        req = router.EnsembleRequest(
            request_id="serial-meta-review-rewrite",
            runner="dynamic_collab_route",
            aggregator="judge_refine",
            runner_config={
                "native_runner": "response.serial",
                "serial_topology": {
                    "version": "modelnet.serial.v1",
                    "nodes": [
                        {"id": "step-1", "modelId": "model-a"},
                        {"id": "step-2", "modelId": "model-b"},
                    ],
                    "edges": [{"source": "step-1", "target": "step-2"}],
                },
            },
            sources=[router.EnsembleSource(source_id="input", prompt="Question?")],
        )

        events = await collect_events(router.run_gateway_serial_ensemble(req, self.tenant))
        done = done_payload(events)

        recovery_call = [item for item in seen if item["source_id"] == "step-2__visible_recovery"][0]
        self.assertEqual(
            recovery_call["extra"].get("chat_template_kwargs"),
            {"enable_thinking": False},
        )
        self.assertEqual(done["text"], "final user-facing answer")
        recovery = done["metadata"]["serial_steps"][1]["metadata"]["serial_visible_answer_recovery"]
        self.assertTrue(recovery["recovered"])
        self.assertEqual(recovery["reason"], "meta_review_visible_answer")

    async def test_gateway_serial_rewrites_opening_rubric_into_visible_answer(self) -> None:
        seen: list[dict[str, Any]] = []

        async def fake_pick(_tenant, source, required_capabilities=None):
            return candidate(str(source.model_alias), metadata={"max_model_len": 8192}), 10.0, "ready"

        async def fake_generate(_candidate, source, **_kwargs):
            seen.append({"source_id": source.source_id, "prompt": source.prompt, "extra": dict(source.extra)})
            if source.source_id == "step-1":
                return {"text": "李世民善于制度建设和纳谏。", "metadata": {}}
            if source.source_id == "step-2":
                return {"text": "朱元璋创业难度极高，但治理方式更严酷。", "metadata": {}}
            if source.source_id == "step-3":
                return {
                    "text": "**\n* Opening: Good, acknowledges both are great rulers, difficult to compare.",
                    "metadata": {"finish_reason": "length"},
                }
            return {"text": "如果看创业难度，朱元璋更厉害；如果看治国成熟度和历史评价，李世民更胜一筹。", "metadata": {}}

        router.pick_source_candidate = fake_pick
        router.generate_text = fake_generate
        req = router.EnsembleRequest(
            request_id="serial-opening-rubric-rewrite",
            runner="dynamic_collab_route",
            aggregator="judge_refine",
            runner_config={
                "native_runner": "response.serial",
                "serial_topology": {
                    "version": "modelnet.serial.v1",
                    "nodes": [
                        {"id": "step-1", "modelId": "model-a"},
                        {"id": "step-2", "modelId": "model-b"},
                        {"id": "step-3", "modelId": "model-c"},
                    ],
                    "edges": [
                        {"source": "step-1", "target": "step-2"},
                        {"source": "step-2", "target": "step-3"},
                    ],
                },
            },
            sources=[router.EnsembleSource(source_id="input", prompt="李世民和朱元璋谁厉害")],
        )

        events = await collect_events(router.run_gateway_serial_ensemble(req, self.tenant))
        done = done_payload(events)

        self.assertIn("step-3__visible_recovery", [item["source_id"] for item in seen])
        recovery_call = [item for item in seen if item["source_id"] == "step-3__visible_recovery"][0]
        self.assertEqual(
            recovery_call["extra"].get("chat_template_kwargs"),
            {"enable_thinking": False},
        )
        self.assertEqual(done["text"], "如果看创业难度，朱元璋更厉害；如果看治国成熟度和历史评价，李世民更胜一筹。")
        self.assertNotIn("Opening: Good", done["text"])
        recovery = done["metadata"]["serial_steps"][2]["metadata"]["serial_visible_answer_recovery"]
        self.assertTrue(recovery["recovered"])
        self.assertEqual(recovery["reason"], "meta_review_visible_answer")

    async def test_gateway_serial_rewrites_internal_process_notes_into_visible_answer(self) -> None:
        seen: list[dict[str, Any]] = []

        async def fake_pick(_tenant, source, required_capabilities=None):
            return candidate(str(source.model_alias), metadata={"max_model_len": 8192}), 10.0, "ready"

        async def fake_generate(_candidate, source, **_kwargs):
            seen.append({"source_id": source.source_id, "prompt": source.prompt, "extra": dict(source.extra)})
            if source.source_id == "step-1":
                return {"text": "first answer", "metadata": {}}
            if source.source_id == "step-2":
                return {
                    "text": "用户的问题是“李世民和朱元璋谁厉害”。上一轮模型回答被截断了。我作为这一环节，需要基于上一轮的分析思路，补全并完善回答。关键点包括：",
                    "metadata": {},
                }
            return {"text": "final answer for the user", "metadata": {}}

        router.pick_source_candidate = fake_pick
        router.generate_text = fake_generate
        req = router.EnsembleRequest(
            request_id="serial-internal-note-rewrite",
            runner="dynamic_collab_route",
            aggregator="judge_refine",
            runner_config={
                "native_runner": "response.serial",
                "serial_topology": {
                    "version": "modelnet.serial.v1",
                    "nodes": [
                        {"id": "step-1", "modelId": "model-a"},
                        {"id": "step-2", "modelId": "model-b"},
                    ],
                    "edges": [{"source": "step-1", "target": "step-2"}],
                },
            },
            sources=[router.EnsembleSource(source_id="input", prompt="Question?")],
        )

        events = await collect_events(router.run_gateway_serial_ensemble(req, self.tenant))
        done = done_payload(events)

        self.assertIn("step-2__visible_recovery", [item["source_id"] for item in seen])
        self.assertEqual(done["text"], "final answer for the user")
        recovery = done["metadata"]["serial_steps"][1]["metadata"]["serial_visible_answer_recovery"]
        self.assertTrue(recovery["recovered"])
        self.assertEqual(recovery["reason"], "meta_review_visible_answer")

    async def test_gateway_serial_continues_nonempty_cutoff_visible_answer(self) -> None:
        seen: list[str] = []

        async def fake_pick(_tenant, source, required_capabilities=None):
            return candidate(str(source.model_alias), metadata={"max_model_len": 8192}), 10.0, "ready"

        async def fake_generate(_candidate, source, **_kwargs):
            seen.append(source.source_id)
            if source.source_id.endswith("__visible_recovery"):
                return {"text": "and then completes cleanly.", "metadata": {"finish_reason": "stop"}}
            return {
                "text": "visible answer without terminal punctuation",
                "metadata": {"finish_reason": "length"},
            }

        router.pick_source_candidate = fake_pick
        router.generate_text = fake_generate
        req = router.EnsembleRequest(
            request_id="serial-cutoff-visible-recovery",
            runner="dynamic_collab_route",
            aggregator="judge_refine",
            runner_config={
                "native_runner": "response.serial",
                "serial_topology": {
                    "version": "modelnet.serial.v1",
                    "nodes": [
                        {"id": "step-1", "modelId": "model-a"},
                        {"id": "step-2", "modelId": "model-b"},
                    ],
                    "edges": [{"source": "step-1", "target": "step-2"}],
                },
            },
            sources=[router.EnsembleSource(source_id="input", prompt="Question?")],
        )

        events = await collect_events(router.run_gateway_serial_ensemble(req, self.tenant))
        done = done_payload(events)

        self.assertIn("step-2__visible_recovery", seen)
        self.assertEqual(
            done["text"],
            "visible answer without terminal punctuationand then completes cleanly.",
        )
        recovery = done["metadata"]["serial_steps"][1]["metadata"]["serial_visible_answer_recovery"]
        self.assertTrue(recovery["recovered"])
        self.assertTrue(recovery["continued_partial"])
        self.assertEqual(recovery["reason"], "cut_off_visible_answer")
        self.assertEqual(recovery["finish_reason"], "length")

    async def test_gateway_serial_summarizes_when_next_prompt_exceeds_context(self) -> None:
        seen: list[dict[str, Any]] = []

        async def fake_pick(_tenant, source, required_capabilities=None):
            return candidate(str(source.model_alias), metadata={"max_model_len": 900}), 10.0, "ready"

        async def fake_generate(source_candidate, source, **_kwargs):
            seen.append(
                {
                    "model": source_candidate.model_id,
                    "source_id": source.source_id,
                    "prompt": source.prompt,
                    "max_tokens": source.sampling_params.get("max_tokens"),
                }
            )
            if source.source_id.endswith("__summary"):
                return {"text": "compact serial context", "metadata": {}}
            return {"text": "detail " * 200 if source.source_id == "step-1" else "final answer", "metadata": {}}

        router.pick_source_candidate = fake_pick
        router.generate_text = fake_generate
        req = router.EnsembleRequest(
            request_id="serial-summary",
            runner="dynamic_collab_route",
            aggregator="judge_refine",
            runner_config={
                "native_runner": "response.serial",
                "serial_reserved_output_tokens": 64,
                "serial_topology": {
                    "version": "modelnet.serial.v1",
                    "nodes": [
                        {"id": "step-1", "modelId": "model-a"},
                        {"id": "step-2", "modelId": "model-b"},
                    ],
                    "edges": [{"source": "step-1", "target": "step-2"}],
                },
            },
            sources=[
                router.EnsembleSource(
                    source_id="input",
                    prompt="Question?",
                    messages=[{"role": "user", "content": "Question?"}],
                    sampling_params={},
                )
            ],
        )

        events = await collect_events(router.run_gateway_serial_ensemble(req, self.tenant))
        done = done_payload(events)
        event_names = [event for event, _data in events]

        self.assertIn("step-2__summary", [item["source_id"] for item in seen])
        step2_call = [item for item in seen if item["source_id"] == "step-2"][-1]
        self.assertIn("Compressed context", step2_call["prompt"])
        self.assertIn("compact serial context", step2_call["prompt"])
        self.assertEqual(done["text"], "final answer")
        self.assertTrue(done["metadata"]["used_summaries"])
        self.assertIn("modelnet_event", event_names)
        summary = done["metadata"]["serial_steps"][1]["summary"]
        self.assertEqual(summary["metadata"]["summary_method"], "model")
        self.assertIn("prompt_tokens_before", summary["metadata"])
        self.assertIn("prompt_tokens_after", summary["metadata"])

    async def test_gateway_serial_uses_deterministic_summary_fallback(self) -> None:
        async def fake_pick(_tenant, source, required_capabilities=None):
            return candidate(str(source.model_alias), metadata={"max_model_len": 260}), 10.0, "ready"

        async def fake_generate(_candidate, source, **_kwargs):
            if source.source_id.endswith("__summary"):
                raise RuntimeError("summary unavailable")
            return {"text": "detail " * 200 if source.source_id == "step-1" else "final answer", "metadata": {}}

        router.pick_source_candidate = fake_pick
        router.generate_text = fake_generate
        req = router.EnsembleRequest(
            request_id="serial-summary-fallback",
            runner="dynamic_collab_route",
            aggregator="judge_refine",
            runner_config={
                "native_runner": "response.serial",
                "serial_reserved_output_tokens": 64,
                "serial_topology": {
                    "version": "modelnet.serial.v1",
                    "nodes": [
                        {"id": "step-1", "modelId": "model-a"},
                        {"id": "step-2", "modelId": "model-b"},
                    ],
                    "edges": [{"source": "step-1", "target": "step-2"}],
                },
            },
            sources=[router.EnsembleSource(source_id="input", prompt="Question?")],
        )

        events = await collect_events(router.run_gateway_serial_ensemble(req, self.tenant))
        done = done_payload(events)
        summary = done["metadata"]["serial_steps"][1]["summary"]

        self.assertEqual(done["text"], "final answer")
        self.assertEqual(summary["metadata"]["summary_method"], "deterministic_truncate")
        self.assertIn("summary unavailable", summary["metadata"]["summary_error"])

    async def test_gateway_serial_reports_invalid_topology(self) -> None:
        req = router.EnsembleRequest(
            request_id="serial-invalid",
            runner="dynamic_collab_route",
            aggregator="judge_refine",
            runner_config={
                "native_runner": "response.serial",
                "serial_topology": {
                    "version": "modelnet.serial.v1",
                    "nodes": [{"id": "step-1", "modelId": "model-a"}],
                    "edges": [],
                },
            },
            sources=[router.EnsembleSource(source_id="input", prompt="Question?")],
        )

        preflight = router.serial_dify_preflight_error(req)
        events = await collect_events(router.run_gateway_serial_ensemble(req, self.tenant))

        self.assertIsNotNone(preflight)
        assert preflight is not None
        self.assertEqual(preflight["stage"], "serial.topology")
        self.assertEqual(router.serial_dify_preflight_status(preflight), 400)
        self.assertEqual(events[0][0], "error")
        self.assertEqual(events[0][1]["stage"], "serial.topology")

    async def test_response_source_uses_model_budget_without_explicit_max_tokens(self) -> None:
        seen: dict[str, Any] = {}

        async def fake_backend_generate_text(_candidate, _source, *, params, messages, prompt, http_client, headers):
            seen["params"] = dict(params)
            seen["messages"] = list(messages)
            seen["prompt"] = prompt
            return {"text": "complete source answer", "metadata": {}}

        router.backend_generate_text = fake_backend_generate_text
        router.http_client = object()
        source = router.EnsembleSource(
            source_id="source-1",
            model_alias="qwen-35b",
            prompt="Question?",
            messages=[{"role": "user", "content": "Question?"}],
            sampling_params={},
        )
        source_candidate = candidate("qwen-35b", metadata={"max_model_len": 8192})

        await router.generate_text(source_candidate, source, prefer_model_max_tokens=True)

        expected_budget = router.usable_completion_token_budget(
            8192,
            router.estimate_context_prompt_tokens(router.text_from_messages(source.messages or [])),
        )
        self.assertEqual(seen["params"]["max_tokens"], expected_budget)
        self.assertGreater(seen["params"]["max_tokens"], 1024)

    async def test_response_source_explicit_max_tokens_is_respected_and_clamped(self) -> None:
        source_candidate = candidate("qwen-35b", metadata={"max_model_len": 8192})
        prompt_tokens = router.estimate_token_count("Question?")
        small = router.EnsembleSource(
            source_id="source-1",
            prompt="Question?",
            sampling_params={"max_tokens": 512},
        )
        huge = router.EnsembleSource(
            source_id="source-1",
            prompt="Question?",
            sampling_params={"max_tokens": 999999},
        )

        small_max = await router.resolve_generation_max_tokens(
            source_candidate,
            small,
            prompt_tokens=prompt_tokens,
            prefer_model_max=True,
        )
        huge_max = await router.resolve_generation_max_tokens(
            source_candidate,
            huge,
            prompt_tokens=prompt_tokens,
            prefer_model_max=True,
        )

        self.assertEqual(small_max, 512)
        self.assertEqual(huge_max, router.usable_completion_token_budget(8192, prompt_tokens))

    def test_response_synthesizer_prefers_strong_qwen_source_model(self) -> None:
        qwen_35b = "inference-qwen-qwen3-5-35b-a3b-gptq-int4"
        deepseek_14b = "inference-deepseek-r1-14b"
        granite = "inference-granite-4b"
        router.load_candidates = lambda: [candidate(granite), candidate(deepseek_14b), candidate(qwen_35b)]
        req = router.EnsembleRequest(
            request_id="response-synthesizer-select",
            runner="response_aggregate",
            aggregator="synthesize",
            sources=[router.EnsembleSource(source_id="source-1", prompt="Question?")],
        )
        responses = [
            {"source_id": "source-1", "backend": {"id": granite}, "text": "a"},
            {"source_id": "source-2", "backend": {"id": deepseek_14b}, "text": "b"},
            {"source_id": "source-3", "backend": {"id": qwen_35b}, "text": "c"},
        ]

        self.assertEqual(router.response_synthesizer_model_alias(req, responses), qwen_35b)

    async def test_response_synthesizer_falls_back_when_requested_model_unavailable(self) -> None:
        calls: list[set[str] | None] = []

        async def fake_pick_candidate(*, tenant=None, candidate_aliases=None, required_capabilities=None):
            calls.append(candidate_aliases)
            if candidate_aliases:
                raise router.HTTPException(status_code=503, detail="not ready")
            return candidate("fallback-ready"), 12.0, "ready"

        router.pick_candidate = fake_pick_candidate
        req = router.EnsembleRequest(
            request_id="response-synthesizer-fallback",
            runner="response_aggregate",
            aggregator="synthesize",
            runner_config={"response_synthesizer_model": "qwen-35b"},
            sources=[router.EnsembleSource(source_id="source-1", prompt="Question?")],
        )

        selected, score, reason = await router.pick_response_synthesizer_candidate(req, self.tenant, [])

        self.assertEqual(selected.model_id, "fallback-ready")
        self.assertEqual(score, 12.0)
        self.assertEqual(reason, "ready")
        self.assertEqual(calls, [{"qwen-35b"}, None])

    async def test_response_synthesizer_caps_output_at_aggregate_max_tokens(self) -> None:
        req = router.EnsembleRequest(
            request_id="response-synthesizer-budget",
            runner="response_aggregate",
            aggregator="synthesize",
            sources=[router.EnsembleSource(source_id="source-1", prompt="Question?")],
        )
        responses = [
            {"source_id": "source-1", "text": "first complete response", "weight": 1.0},
            {"source_id": "source-2", "text": "second complete response", "weight": 1.0},
        ]
        source, _instruction, _user_prompt = router.build_response_synthesis_source(
            req,
            candidate("qwen-35b", metadata={"max_model_len": 8192}),
            responses,
        )

        self.assertNotIn("max_tokens", source.sampling_params)
        resolved = await router.source_with_synthesis_max_tokens(
            candidate("qwen-35b", metadata={"max_model_len": 8192}),
            source,
            req,
            context_length=8192,
        )

        self.assertEqual(resolved.sampling_params["max_tokens"], router.RESPONSE_AGGREGATE_MAX_TOKENS)

    def test_response_synthesizer_trims_prompt_to_preserve_output_budget(self) -> None:
        req = router.EnsembleRequest(
            request_id="response-synthesizer-trim",
            runner="response_aggregate",
            aggregator="synthesize",
            sources=[router.EnsembleSource(source_id="source-1", prompt="Question?")],
        )
        long_text = "detail " * 3000
        responses = [
            {"source_id": "source-1", "text": long_text, "weight": 1.0},
            {"source_id": "source-2", "text": long_text, "weight": 1.0},
        ]

        _source, _instruction, user_prompt = router.build_response_synthesis_source(
            req,
            candidate("qwen-35b", metadata={"max_model_len": 8192}),
            responses,
            max_prompt_tokens=1200,
        )

        self.assertLessEqual(router.estimate_context_prompt_tokens(user_prompt), 1200)
        self.assertIn("[truncated]", user_prompt)

    def test_response_synthesis_fallback_closes_truncated_summaries(self) -> None:
        long_text = "Zhu Yuanzhang consolidated resources and built institutions " * 600
        summary = router.deterministic_response_summary(
            {"source_id": "source-1", "text": long_text, "weight": 1.0}
        )

        fallback = router.response_synthesis_fallback_text(
            [{"source_id": "source-1", "text": long_text, "weight": 1.0}],
            "synthesis returned no visible final answer",
        )

        short_cutoff = router.deterministic_response_summary(
            {"source_id": "source-2", "text": ("detail " * 40) + "unfinished:", "weight": 1.0}
        )

        self.assertTrue(summary.endswith("[truncated]."))
        self.assertFalse(router.answer_looks_cut_off(summary))
        self.assertTrue(short_cutoff.endswith("[truncated]."))
        self.assertFalse(router.answer_looks_cut_off(short_cutoff))
        self.assertTrue(fallback.endswith("以上为可用源回答的降级摘要。"))
        self.assertNotIn("The response synthesizer could not complete", fallback)
        self.assertNotIn("Synthesis error", fallback)
        self.assertNotIn("synthesis returned no visible final answer", fallback)
        self.assertFalse(router.answer_looks_cut_off(fallback))

    async def test_response_aggregate_sources_receive_original_payloads(self) -> None:
        seen: dict[str, dict[str, Any]] = {}

        async def fake_generate(_tenant, source, **_kwargs):
            seen[source.source_id] = {
                "prompt": source.prompt,
                "messages": list(source.messages or []),
                "sampling_params": dict(source.sampling_params),
                "extra": dict(source.extra),
            }
            return {
                "source_id": source.source_id,
                "backend": {"id": source.model_alias or source.source_id},
                "text": f"answer from {source.source_id}",
                "metadata": {},
                "weight": source.weight,
                "error": None,
                "latency_ms": 1,
            }

        async def fake_synthesis(_request, _tenant, responses):
            self.assertEqual(
                {item["source_id"]: item["text"] for item in responses},
                {
                    "source-1": "answer from source-1",
                    "source-2": "answer from source-2",
                },
            )
            yield {
                "event": "selected",
                "synthesis": {"source_id": "__response_aggregator__", "backend": {"id": "aggregator"}},
            }
            yield {"event": "token", "delta": "combined answer"}
            yield {
                "event": "done",
                "synthesis": {
                    "source_id": "__response_aggregator__",
                    "backend": {"id": "aggregator"},
                    "text": "combined answer",
                    "metadata": {},
                },
                "metadata": {"instruction": "test", "prompt_chars": 8},
            }

        async def fake_stream(_tenant, source, **_kwargs):
            result = await fake_generate(_tenant, source, **_kwargs)
            async for item in fake_stream_response_source_from_result(source, result):
                yield item

        router.stream_response_source = fake_stream
        router.stream_response_synthesis = fake_synthesis
        source_messages = [{"role": "user", "content": "Question?"}]
        req = router.EnsembleRequest(
            request_id="response-aggregate-original-payloads",
            runner="response_aggregate",
            aggregator="synthesize",
            sources=[
                router.EnsembleSource(
                    source_id="source-1",
                    model_alias="qwen-7b",
                    prompt="Question?",
                    messages=source_messages,
                    sampling_params={"max_tokens": 64},
                    extra={"chat_template_kwargs": {"enable_thinking": True}},
                ),
                router.EnsembleSource(source_id="source-2", model_alias="llama-8b", prompt="Question?"),
            ],
        )
        events = await collect_events(router.run_response_aggregate_ensemble(req, self.tenant))

        self.assertEqual(done_payload(events)["text"], "combined answer")
        self.assertEqual(seen["source-1"]["prompt"], "Question?")
        self.assertEqual(seen["source-1"]["messages"], source_messages)
        self.assertEqual(seen["source-1"]["sampling_params"], {"max_tokens": 64})
        self.assertEqual(seen["source-1"]["extra"], {"chat_template_kwargs": {"enable_thinking": True}})
        self.assertEqual(seen["source-2"]["prompt"], "Question?")
        self.assert_no_response_prompt_control_leakage(json.dumps(seen, ensure_ascii=False))

    async def test_response_aggregate_streams_source_modelnet_events(self) -> None:
        async def fake_stream(_tenant, source, **_kwargs):
            backend = {"id": source.model_alias or source.source_id}
            model = str(backend["id"])
            yield {"event": "selected", "source_id": source.source_id, "backend": backend, "model": model}
            yield {"event": "started", "source_id": source.source_id, "backend": backend, "model": model}
            if source.source_id == "source-1":
                yield {
                    "event": "delta",
                    "source_id": source.source_id,
                    "backend": backend,
                    "model": model,
                    "delta": "alpha ",
                    "text": "alpha ",
                }
                await asyncio.sleep(0.01)
                text = "alpha done"
                yield {
                    "event": "delta",
                    "source_id": source.source_id,
                    "backend": backend,
                    "model": model,
                    "delta": "done",
                    "text": text,
                }
            else:
                text = "beta done"
                yield {
                    "event": "delta",
                    "source_id": source.source_id,
                    "backend": backend,
                    "model": model,
                    "delta": text,
                    "text": text,
                }
            yield {
                "event": "completed",
                "source_id": source.source_id,
                "backend": backend,
                "model": model,
                "result": {
                    "source_id": source.source_id,
                    "backend": backend,
                    "text": text,
                    "metadata": {},
                    "weight": source.weight,
                    "error": None,
                    "latency_ms": 3,
                },
            }

        async def fake_synthesis(_request, _tenant, responses):
            yield {
                "event": "done",
                "synthesis": {
                    "source_id": "__response_aggregator__",
                    "backend": {"id": "aggregator"},
                    "text": "combined",
                    "metadata": {},
                },
                "metadata": {"instruction": "test", "prompt_chars": 8},
            }

        router.stream_response_source = fake_stream
        router.stream_response_synthesis = fake_synthesis
        req = router.EnsembleRequest(
            request_id="response-aggregate-source-stream",
            runner="response_aggregate",
            aggregator="synthesize",
            sources=[
                router.EnsembleSource(source_id="source-1", model_alias="qwen-7b", prompt="Question?"),
                router.EnsembleSource(source_id="source-2", model_alias="llama-8b", prompt="Question?"),
            ],
        )

        events = await collect_events(router.run_response_aggregate_ensemble(req, self.tenant))
        modelnet_events = [data for event, data in events if event == "modelnet_event"]
        delta_events = [data for data in modelnet_events if data.get("type") == "source.delta"]

        self.assertGreaterEqual(len(delta_events), 2)
        self.assertIn("source.started", [data.get("type") for data in modelnet_events])
        self.assertIn("source.completed", [data.get("type") for data in modelnet_events])
        self.assertEqual(done_payload(events)["text"], "combined")

    def test_litellm_safe_openai_stream_chunk_fills_empty_choices(self) -> None:
        chunk = (
            b'data: {"id":"chatcmpl","object":"chat.completion.chunk",'
            b'"choices":[],"usage":{"prompt_tokens":1}}\n\n'
        )

        _event, data = router.parse_sse_chunk(router.litellm_safe_openai_stream_chunk(chunk))

        self.assertEqual(len(data["choices"]), 1)
        self.assertEqual(data["choices"][0]["delta"], {})
        self.assertEqual(data["usage"]["prompt_tokens"], 1)

    def test_openai_modelnet_event_payload_keeps_non_empty_choices_for_litellm(self) -> None:
        event = {
            "type": "source.started",
            "sourceId": "source-1",
            "source_id": "source-1",
            "model": "qwen",
        }

        chunk = router.openai_modelnet_event_payload(
            request_id="req",
            model="modelnet",
            modelnet_event=event,
        )
        _event, data = router.parse_sse_chunk(chunk)

        self.assertEqual(len(data["choices"]), 1)
        self.assertEqual(data["choices"][0]["delta"], {})
        self.assertIsNone(data["choices"][0]["finish_reason"])
        self.assertEqual(data["modelnet_event"]["type"], "source.started")

    def test_openai_modelnet_content_marker_uses_compact_delta_event(self) -> None:
        event = {
            "type": "source.delta",
            "sourceId": "source-1",
            "source_id": "source-1",
            "model": "qwen",
            "backend": {"id": "qwen", "capabilities": ["chat"]},
            "delta": "beta",
            "text": "alpha beta",
        }

        chunk = router.openai_modelnet_event_payload(
            request_id="req",
            model="modelnet",
            modelnet_event=event,
            include_content_marker=True,
        )
        _event, data = router.parse_sse_chunk(chunk)
        marker = data["choices"][0]["delta"]["content"]
        self.assertTrue(marker.startswith(router.MODELNET_EVENT_CONTENT_PREFIX))
        raw_marker = marker[
            len(router.MODELNET_EVENT_CONTENT_PREFIX) : -len(router.MODELNET_EVENT_CONTENT_SUFFIX)
        ]
        marker_event = json.loads(raw_marker)

        self.assertEqual(data["modelnet_event"]["text"], "alpha beta")
        self.assertEqual(marker_event["type"], "source.delta")
        self.assertEqual(marker_event["sourceId"], "source-1")
        self.assertEqual(marker_event["delta"], "beta")
        self.assertNotIn("text", marker_event)
        self.assertNotIn("backend", marker_event)

    def test_response_synthesizer_ignores_empty_source_responses(self) -> None:
        router.load_candidates = lambda: [
            candidate("large-empty", metadata={"family": "qwen", "size": "35b"}),
            candidate("smaller-visible", metadata={"family": "qwen", "size": "14b"}),
        ]
        req = router.EnsembleRequest(
            request_id="response-synthesizer-nonempty",
            runner="response_aggregate",
            aggregator="synthesize",
            sources=[router.EnsembleSource(source_id="source-1", prompt="Question?")],
        )
        responses = [
            {"source_id": "source-1", "backend": {"id": "large-empty"}, "text": "", "weight": 1.0},
            {"source_id": "source-2", "backend": {"id": "smaller-visible"}, "text": "visible", "weight": 1.0},
        ]
        self.assertEqual(router.response_synthesizer_model_alias(req, responses), "smaller-visible")

    def test_response_synthesizer_skips_configured_source_alias_without_visible_output(self) -> None:
        router.load_candidates = lambda: [
            candidate("large-empty", metadata={"family": "qwen", "size": "35b"}),
            candidate("smaller-visible", metadata={"family": "qwen", "size": "14b"}),
        ]
        req = router.EnsembleRequest(
            request_id="response-synthesizer-configured-empty",
            runner="response_aggregate",
            aggregator="synthesize",
            runner_config={"response_synthesizer_model": "large-empty"},
            sources=[
                router.EnsembleSource(source_id="source-1", model_alias="large-empty", prompt="Question?"),
                router.EnsembleSource(source_id="source-2", model_alias="smaller-visible", prompt="Question?"),
            ],
        )
        responses = [
            {"source_id": "source-2", "backend": {"id": "smaller-visible"}, "text": "visible", "weight": 1.0},
        ]

        self.assertEqual(router.response_synthesizer_model_alias(req, responses), "smaller-visible")

    def test_response_synthesizer_honors_configured_external_alias(self) -> None:
        req = router.EnsembleRequest(
            request_id="response-synthesizer-external",
            runner="response_aggregate",
            aggregator="synthesize",
            runner_config={"response_synthesizer_model": "dedicated-synth"},
            sources=[router.EnsembleSource(source_id="source-1", model_alias="source-model", prompt="Question?")],
        )
        responses = [
            {"source_id": "source-1", "backend": {"id": "source-model"}, "text": "visible", "weight": 1.0},
        ]

        self.assertEqual(router.response_synthesizer_model_alias(req, responses), "dedicated-synth")

    def test_response_stream_filter_splits_think_tags_into_reasoning(self) -> None:
        stream_filter = router.ResponseVisibleTextStreamFilter()
        text, reasoning = stream_filter.feed("<think>hidden</think>visible")
        tail, tail_reasoning = stream_filter.flush()

        self.assertEqual(reasoning, "hidden")
        self.assertEqual(text + tail, "visible")
        self.assertEqual(tail_reasoning, "")

        stream_filter = router.ResponseVisibleTextStreamFilter()
        text, reasoning = stream_filter.feed("implicit hidden</think>visible")
        tail, tail_reasoning = stream_filter.flush()

        self.assertEqual(reasoning, "implicit hidden")
        self.assertEqual(text + tail, "visible")
        self.assertEqual(tail_reasoning, "")

    async def test_response_synthesis_disabled_thinking_keeps_plain_content_from_think_candidate(self) -> None:
        seen_body: dict[str, Any] = {}

        async def fake_pick_candidate(*, tenant=None, candidate_aliases=None, required_capabilities=None):
            return candidate(
                "qwen-think",
                metadata={"type": "think", "stop_think": "</think>", "max_model_len": 8192},
            ), 10.0, "ready"

        async def fake_backend_stream_chat(_candidate, body, *, http_client, headers):
            seen_body.update(body)
            yield b'data: {"choices":[{"delta":{"content":"visible final answer."}}]}\n\n'
            yield b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
            yield b"data: [DONE]\n\n"

        router.pick_candidate = fake_pick_candidate
        router.backend_stream_chat = fake_backend_stream_chat
        router.http_client = object()
        req = router.EnsembleRequest(
            request_id="response-synthesis-thinking-disabled",
            runner="response_aggregate",
            aggregator="synthesize",
            sources=[router.EnsembleSource(source_id="source-1", prompt="Question?")],
        )
        responses = [
            {"source_id": "source-1", "text": "first complete response", "weight": 1.0},
            {"source_id": "source-2", "text": "second complete response", "weight": 1.0},
        ]

        events = []
        async for event in router.stream_response_synthesis(req, self.tenant, responses):
            events.append(event)

        done = [event for event in events if event.get("event") == "done"][0]
        self.assertEqual(seen_body["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(done["synthesis"]["text"], "visible final answer.")
        self.assertNotEqual(done["synthesis"]["metadata"].get("fallback_reason"), "empty_synthesis")

    async def test_response_synthesis_streams_reasoning_content_separately(self) -> None:
        async def fake_pick_candidate(*, tenant=None, candidate_aliases=None, required_capabilities=None):
            return candidate("qwen-reasoning", metadata={"max_model_len": 8192}), 10.0, "ready"

        async def fake_backend_stream_chat(_candidate, body, *, http_client, headers):
            yield b'data: {"choices":[{"delta":{"reasoning_content":"thinking "}}]}\n\n'
            yield b'data: {"choices":[{"delta":{"content":"final answer."}}]}\n\n'
            yield b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
            yield b"data: [DONE]\n\n"

        router.pick_candidate = fake_pick_candidate
        router.backend_stream_chat = fake_backend_stream_chat
        router.http_client = object()
        req = router.EnsembleRequest(
            request_id="response-synthesis-reasoning",
            runner="response_aggregate",
            aggregator="synthesize",
            sources=[router.EnsembleSource(source_id="source-1", prompt="Question?")],
        )
        responses = [
            {"source_id": "source-1", "text": "first complete response", "weight": 1.0},
            {"source_id": "source-2", "text": "second complete response", "weight": 1.0},
        ]

        events = []
        async for event in router.stream_response_synthesis(req, self.tenant, responses):
            events.append(event)

        self.assertEqual([event["delta"] for event in events if event.get("event") == "reasoning"], ["thinking "])
        done = [event for event in events if event.get("event") == "done"][0]
        self.assertEqual(done["synthesis"]["text"], "final answer.")
        self.assertEqual(done["synthesis"]["metadata"]["reasoning_content"], "thinking ")

    async def test_openai_ensemble_stream_maps_reasoning_event_to_reasoning_content(self) -> None:
        original_run_ensemble_stream = router.run_ensemble_stream

        async def fake_run_ensemble_stream(_request, _tenant):
            yield router.sse("reasoning", {"delta": "thinking "})
            yield router.sse("token", {"delta": "answer", "text": "answer"})
            yield router.sse("done", {"text": "answer", "metadata": {}})

        router.run_ensemble_stream = fake_run_ensemble_stream
        try:
            req = router.EnsembleRequest(
                request_id="openai-reasoning",
                runner="response_aggregate",
                aggregator="synthesize",
                sources=[router.EnsembleSource(source_id="source-1", prompt="Question?")],
            )
            chunks = []
            async for chunk in router.stream_openai_ensemble_response(
                req,
                self.tenant,
                request_id="req",
                model="modelnet-parallel",
            ):
                _event, data = router.parse_sse_chunk(chunk)
                if data.get("raw") != "[DONE]":
                    chunks.append(data)
        finally:
            router.run_ensemble_stream = original_run_ensemble_stream

        deltas = [
            choice.get("delta", {})
            for data in chunks
            for choice in data.get("choices", [])
            if isinstance(choice, dict)
        ]
        self.assertIn({"reasoning_content": "thinking "}, deltas)
        self.assertIn({"content": "answer"}, deltas)

    async def test_openai_stream_exposes_serial_source_outputs_as_modelnet_events(self) -> None:
        original_run_ensemble_stream = router.run_ensemble_stream

        async def fake_run_ensemble_stream(_request, _tenant):
            yield router.sse(
                "source_selected",
                {
                    "source_id": "step-1",
                    "backend": {"id": "model-a"},
                    "role": "serial_step",
                    "stage": "serial.step",
                    "step": 1,
                },
            )
            yield router.sse(
                "full_response",
                {
                    "source_id": "step-1",
                    "text": "step 1 visible answer",
                    "metadata": {"finish_reason": "stop"},
                },
            )
            yield router.sse("token", {"delta": "final answer", "text": "final answer"})
            yield router.sse("done", {"text": "final answer", "metadata": {}})

        router.run_ensemble_stream = fake_run_ensemble_stream
        try:
            req = router.EnsembleRequest(
                request_id="openai-serial-modelnet-events",
                runner="dynamic_collab_route",
                aggregator="judge_refine",
                runner_config={"native_runner": "response.serial", "show_serial_flow": True},
                sources=[router.EnsembleSource(source_id="input", prompt="Question?")],
            )
            events = await collect_openai_modelnet_events(
                router.stream_openai_ensemble_response(
                    req,
                    self.tenant,
                    request_id="openai-serial-modelnet-events",
                    model="modelnet",
                )
            )
        finally:
            router.run_ensemble_stream = original_run_ensemble_stream

        self.assertEqual([event["type"] for event in events], ["source.started", "source.completed"])
        self.assertEqual(events[0]["source_id"], "step-1")
        self.assertEqual(events[0]["model"], "model-a")
        self.assertEqual(events[0]["role"], "serial_step")
        self.assertEqual(events[1]["source_id"], "step-1")
        self.assertEqual(events[1]["model"], "model-a")
        self.assertEqual(events[1]["text"], "step 1 visible answer")
        self.assertEqual(events[1]["metadata"]["finish_reason"], "stop")

    async def test_openai_stream_exposes_auto_candidate_outputs_as_modelnet_events(self) -> None:
        original_run_ensemble_stream = router.run_ensemble_stream

        async def fake_run_ensemble_stream(_request, _tenant):
            yield router.sse(
                "source_selected",
                {
                    "source_id": "candidate-1",
                    "backend": {"id": "model-a"},
                    "role": "candidate",
                    "stage": "candidates.parallel",
                },
            )
            yield router.sse(
                "full_response",
                {
                    "source_id": "candidate-1",
                    "role": "candidate",
                    "text": "candidate visible answer",
                    "metadata": {"finish_reason": "stop"},
                },
            )
            yield router.sse("token", {"delta": "final answer", "text": "final answer"})
            yield router.sse("done", {"text": "final answer", "metadata": {}})

        router.run_ensemble_stream = fake_run_ensemble_stream
        try:
            req = router.EnsembleRequest(
                request_id="openai-auto-modelnet-events",
                runner="dynamic_collab_route",
                aggregator="auto",
                runner_config={"native_runner": "auto.network", "show_auto_flow": True},
                sources=[router.EnsembleSource(source_id="input", prompt="Question?")],
            )
            events = await collect_openai_modelnet_events(
                router.stream_openai_ensemble_response(
                    req,
                    self.tenant,
                    request_id="openai-auto-modelnet-events",
                    model="modelnet-auto",
                )
            )
        finally:
            router.run_ensemble_stream = original_run_ensemble_stream

        self.assertEqual([event["type"] for event in events], ["source.started", "source.completed"])
        self.assertEqual(events[0]["source_id"], "candidate-1")
        self.assertEqual(events[0]["model"], "model-a")
        self.assertEqual(events[0]["role"], "candidate")
        self.assertEqual(events[1]["source_id"], "candidate-1")
        self.assertEqual(events[1]["text"], "candidate visible answer")
        self.assertEqual(events[1]["stage"], "candidates.parallel")

    async def test_openai_stream_renders_serial_flow_as_reasoning_content(self) -> None:
        original_run_ensemble_stream = router.run_ensemble_stream

        async def fake_run_ensemble_stream(_request, _tenant):
            yield router.sse(
                "run_started",
                {
                    "runner": "dynamic_collab_route",
                    "native_runner": "response.serial",
                    "aggregator": "judge_refine",
                },
            )
            yield router.sse(
                "trace_step",
                {
                    "stage": "serial.gateway.started",
                    "total_steps": 2,
                    "model_ids": ["model-a", "model-b"],
                },
            )
            yield router.sse(
                "source_selected",
                {
                    "source_id": "step-1",
                    "backend": {"id": "model-a"},
                    "role": "serial_step",
                    "stage": "serial.step",
                    "step": 1,
                },
            )
            yield router.sse(
                "trace_step",
                {
                    "stage": "serial.summary.completed",
                    "source_id": "step-2",
                    "step": 2,
                    "prompt_tokens_before": 1200,
                    "prompt_tokens_after": 500,
                },
            )
            yield router.sse(
                "trace_step",
                {
                    "stage": "serial.visible_answer_recovered",
                    "source_id": "step-2",
                    "step": 2,
                    "reason": "empty_visible_answer",
                    "recovered": True,
                },
            )
            yield router.sse(
                "trace_step",
                {
                    "stage": "serial.step.completed",
                    "source_id": "step-2",
                    "step": 2,
                    "backend": {"id": "model-b"},
                    "latency_ms": 42,
                    "text_chars": 12,
                    "text": "intermediate answer should not leak",
                },
            )
            yield router.sse("token", {"delta": "final answer", "text": "final answer"})
            yield router.sse("done", {"text": "final answer", "metadata": {}})

        router.run_ensemble_stream = fake_run_ensemble_stream
        try:
            req = router.EnsembleRequest(
                request_id="openai-serial-flow",
                runner="dynamic_collab_route",
                aggregator="judge_refine",
                runner_config={"native_runner": "response.serial", "show_serial_flow": True},
                sources=[router.EnsembleSource(source_id="input", prompt="Question?")],
            )
            content_deltas, reasoning_deltas = await collect_openai_deltas(
                router.stream_openai_ensemble_response(
                    req,
                    self.tenant,
                    request_id="openai-serial-flow",
                    model="modelnet",
                )
            )
        finally:
            router.run_ensemble_stream = original_run_ensemble_stream

        reasoning_content = "".join(reasoning_deltas)
        content = "".join(content_deltas)
        self.assertIn("ModelNet 串联流程", reasoning_content)
        self.assertIn("串联拓扑已就绪", reasoning_content)
        self.assertIn("第 1 步选中模型", reasoning_content)
        self.assertIn("第 2 步上下文已压缩", reasoning_content)
        self.assertIn("第 2 步触发可见答案恢复", reasoning_content)
        self.assertIn("第 2 步完成", reasoning_content)
        self.assertIn("model-a", reasoning_content)
        self.assertIn("model-b", reasoning_content)
        self.assertNotIn("intermediate answer should not leak", reasoning_content)
        self.assertEqual(content, "final answer")
        self.assertNotIn("ModelNet 串联流程", content)

    async def test_openai_stream_renders_auto_network_flow_when_enabled(self) -> None:
        original_run_ensemble_stream = router.run_ensemble_stream

        async def fake_run_ensemble_stream(_request, _tenant):
            yield router.sse(
                "run_started",
                {
                    "request_id": "openai-auto-flow",
                    "runner": "auto",
                    "native_runner": "auto.network",
                    "aggregator": "auto",
                },
            )
            yield router.sse(
                "auto_plan",
                {
                    "strategy": "adaptive_sparse_graph",
                    "runner": "auto.rank_fuse",
                    "aggregator": "rank_then_fuse",
                    "source_count": 2,
                    "confidence_score": 0.41,
                    "escalation_reason": "rank_fuse_complex_or_low_confidence",
                    "stages": ["candidates.parallel", "ranker.select"],
                    "selected_sources": [
                        {"source_id": "candidate-1", "backend": {"id": "model-a"}},
                        {"source_id": "candidate-2", "backend": {"id": "model-b"}},
                    ],
                },
            )
            yield router.sse(
                "source_selected",
                {
                    "source_id": "candidate-1",
                    "backend": {"id": "model-a"},
                    "role": "candidate",
                    "stage": "candidates.parallel",
                },
            )
            yield router.sse(
                "trace_step",
                {
                    "stage": "source.completed",
                    "source_id": "candidate-1",
                    "backend": {"id": "model-a"},
                    "latency_ms": 17,
                    "text_chars": 12,
                },
            )
            yield router.sse("token", {"delta": "final answer", "text": "final answer"})
            yield router.sse(
                "done",
                {
                    "text": "final answer",
                    "metadata": {
                        "auto_plan": {
                            "internal_call_count": 3,
                            "internal_total_tokens": 456,
                        }
                    },
                },
            )

        router.run_ensemble_stream = fake_run_ensemble_stream
        try:
            req = router.EnsembleRequest(
                request_id="openai-auto-flow",
                runner="dynamic_collab_route",
                aggregator="auto",
                runner_config={"native_runner": "auto.network", "show_auto_flow": True},
                sources=[router.EnsembleSource(source_id="input", prompt="Question?")],
            )
            content_deltas, reasoning_deltas = await collect_openai_deltas(
                router.stream_openai_ensemble_response(
                    req,
                    self.tenant,
                    request_id="openai-auto-flow",
                    model="modelnet-auto",
                )
            )
        finally:
            router.run_ensemble_stream = original_run_ensemble_stream

        reasoning_content = "".join(reasoning_deltas)
        content = "".join(content_deltas)
        self.assertIn("ModelNet 自动组网流程", reasoning_content)
        self.assertIn("规划完成", reasoning_content)
        self.assertIn("adaptive_sparse_graph", reasoning_content)
        self.assertIn("candidates.parallel", reasoning_content)
        self.assertIn("candidate-1", reasoning_content)
        self.assertIn("model-a", reasoning_content)
        self.assertIn("自动组网执行完成", reasoning_content)
        self.assertEqual(content, "final answer")
        self.assertNotIn("ModelNet 自动组网流程", content)

    async def test_openai_stream_hides_serial_flow_when_disabled(self) -> None:
        original_run_ensemble_stream = router.run_ensemble_stream

        async def fake_run_ensemble_stream(_request, _tenant):
            yield router.sse(
                "run_started",
                {"native_runner": "response.serial", "aggregator": "judge_refine"},
            )
            yield router.sse(
                "trace_step",
                {"stage": "serial.gateway.started", "total_steps": 2, "model_ids": ["model-a", "model-b"]},
            )
            yield router.sse("token", {"delta": "final answer", "text": "final answer"})
            yield router.sse("done", {"text": "final answer", "metadata": {}})

        router.run_ensemble_stream = fake_run_ensemble_stream
        try:
            req = router.EnsembleRequest(
                request_id="openai-serial-flow-hidden",
                runner="dynamic_collab_route",
                aggregator="judge_refine",
                runner_config={"native_runner": "response.serial"},
                sources=[router.EnsembleSource(source_id="input", prompt="Question?")],
            )
            content_deltas, reasoning_deltas = await collect_openai_deltas(
                router.stream_openai_ensemble_response(
                    req,
                    self.tenant,
                    request_id="openai-serial-flow-hidden",
                    model="modelnet",
                )
            )
        finally:
            router.run_ensemble_stream = original_run_ensemble_stream

        self.assertEqual(reasoning_deltas, [])
        self.assertEqual("".join(content_deltas), "final answer")

    async def test_response_synthesis_continues_cut_off_final_answer(self) -> None:
        calls: list[str] = []

        async def fake_pick_candidate(*, tenant=None, candidate_aliases=None, required_capabilities=None):
            return candidate("qwen-35b", metadata={"max_model_len": 8192}), 10.0, "ready"

        async def fake_backend_stream_chat(_candidate, body, *, http_client, headers):
            messages = body.get("messages") or []
            prompt = "\n".join(str(message.get("content") or "") for message in messages)
            if "Partial final answer already sent" in prompt:
                calls.append("continue")
                yield (
                    'data: {"choices":[{"delta":{"content":"白手起家，最终建立明朝。'
                    '综合来看，若看创业难度朱元璋更强；若看制度与盛世，李世民更强。"}}]}\n\n'
                ).encode()
                yield b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
                yield b"data: [DONE]\n\n"
                return

            calls.append("initial")
            yield (
                'data: {"choices":[{"delta":{"content":"朱元璋出身贫寒，从社会最底层"}}]}\n\n'
            ).encode()
            yield b'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'
            yield b"data: [DONE]\n\n"

        router.pick_candidate = fake_pick_candidate
        router.backend_stream_chat = fake_backend_stream_chat
        router.http_client = object()
        req = router.EnsembleRequest(
            request_id="response-synthesis-continue",
            runner="response_aggregate",
            aggregator="synthesize",
            sources=[router.EnsembleSource(source_id="source-1", prompt="Question?")],
        )
        responses = [
            {"source_id": "source-1", "text": "李世民善治。", "weight": 1.0},
            {"source_id": "source-2", "text": "朱元璋创业难度高。", "weight": 1.0},
        ]

        events = []
        async for event in router.stream_response_synthesis(req, self.tenant, responses):
            events.append(event)

        done = [event for event in events if event.get("event") == "done"][0]
        self.assertEqual(calls, ["initial", "continue"])
        self.assertIn("最终建立明朝", done["synthesis"]["text"])
        self.assertTrue(done["synthesis"]["text"].endswith("李世民更强。"))
        self.assertTrue(done["synthesis"]["metadata"]["response_synthesis_continuation"]["applied"])

    async def test_response_synthesis_context_400_summarizes_and_retries(self) -> None:
        attempts: list[int] = []
        seen_max_tokens: list[int] = []

        async def fake_pick_candidate(*, tenant=None, candidate_aliases=None, required_capabilities=None):
            return candidate("qwen-35b", metadata={"max_model_len": 8192}), 10.0, "ready"

        async def fake_generate_text(_candidate, source, **_kwargs):
            return {"text": f"summary for {source.source_id}", "metadata": {}}

        async def fake_backend_stream_chat(_candidate, body, *, http_client, headers):
            attempts.append(1)
            seen_max_tokens.append(int(body.get("max_tokens") or 0))
            if len(attempts) == 1:
                response = types.SimpleNamespace(status_code=400)
                raise router.httpx.HTTPStatusError(
                    "This model's maximum context length is 8192 tokens. However, you requested "
                    "1536 output tokens and your prompt contains at least 6657 input tokens, for "
                    "a total of at least 8193 tokens.",
                    response=response,
                )
            yield b'data: {"choices":[{"delta":{"content":"final answer"}}]}\n\n'
            yield b"data: [DONE]\n\n"

        router.pick_candidate = fake_pick_candidate
        router.generate_text = fake_generate_text
        router.backend_stream_chat = fake_backend_stream_chat
        router.http_client = object()
        req = router.EnsembleRequest(
            request_id="response-synthesis-context-retry",
            runner="response_aggregate",
            aggregator="synthesize",
            sources=[router.EnsembleSource(source_id="source-1", prompt="Question?")],
        )
        responses = [
            {"source_id": "source-1", "text": "first complete response", "weight": 1.0},
            {"source_id": "source-2", "text": "second complete response", "weight": 1.0},
        ]

        events = []
        async for event in router.stream_response_synthesis(req, self.tenant, responses):
            events.append(event)

        self.assertEqual(len(attempts), 2)
        self.assertTrue(all(value <= router.RESPONSE_AGGREGATE_MAX_TOKENS for value in seen_max_tokens))
        self.assertIn("source_summarized", [event.get("event") for event in events])
        done = [event for event in events if event.get("event") == "done"][0]
        self.assertEqual(done["synthesis"]["text"], "final answer")
        self.assertTrue(done["metadata"]["used_summaries"])

    def test_response_hidden_reasoning_filter_removes_think_blocks(self) -> None:
        text, removed = router.strip_response_hidden_reasoning("<think>secret</think>\nfinal")

        self.assertEqual(text, "final")
        self.assertTrue(removed)

        text, removed = router.strip_response_hidden_reasoning("implicit secret</think>\nfinal")

        self.assertEqual(text, "final")
        self.assertTrue(removed)

    def test_response_hidden_reasoning_filter_removes_visible_thinking_preamble(self) -> None:
        text, removed = router.strip_response_hidden_reasoning(
            "Thinking Process:\ninternal notes\n\nFinal Answer:\nvisible"
        )

        self.assertEqual(text, "visible")
        self.assertTrue(removed)

        text, removed = router.strip_response_hidden_reasoning("Here's a thinking process that has no answer yet")

        self.assertEqual(text, "")
        self.assertTrue(removed)

    async def test_response_source_filters_hidden_reasoning_without_prompt_controls(self) -> None:
        async def fake_pick(_tenant, source, required_capabilities=None):
            self.assertEqual(source.prompt, "Question?")
            self.assertIsNone(required_capabilities)
            return candidate("qwen-7b"), 10.0, "ready"

        async def fake_generate_text(_candidate, source, prompt_override=None, **_kwargs):
            self.assertEqual(source.prompt, "Question?")
            self.assertIsNone(prompt_override)
            return {"text": "<think>secret</think>visible", "metadata": {}}

        router.pick_source_candidate = fake_pick
        router.generate_text = fake_generate_text
        result = await router.generate_response_source(
            self.tenant,
            router.EnsembleSource(source_id="source-1", model_alias="qwen-7b", prompt="Question?"),
        )

        self.assertEqual(result["text"], "visible")
        self.assertTrue(result["metadata"]["source_hidden_reasoning_removed"])

    def test_openai_parallel_flow_delta_explains_empty_source_completion(self) -> None:
        delta = router.openai_parallel_flow_delta(
            "trace_step",
            {
                "stage": "source.completed",
                "source_id": "source-1",
                "backend": {"id": "qwen"},
                "latency_ms": 123,
                "text_chars": 0,
                "hidden_reasoning_removed": True,
                "hidden_reasoning_chars": 42,
                "finish_reason": "length",
                "usage_present": False,
            },
        )

        self.assertIn("返回 0 字符", delta)
        self.assertIn("已剥离 hidden reasoning 42 字符", delta)
        self.assertIn("finish_reason=length", delta)
        self.assertIn("后端未返回 usage", delta)


    async def test_response_aggregate_emits_parallel_flow_when_enabled(self) -> None:
        async def fake_generate(_tenant, source, **_kwargs):
            if source.source_id == "source-1":
                await asyncio.sleep(0.01)
            return {
                "source_id": source.source_id,
                "backend": {"id": source.model_alias or source.source_id},
                "text": f"answer from {source.source_id}",
                "metadata": {},
                "weight": source.weight,
                "error": None,
                "latency_ms": 10,
            }

        async def fake_synthesis(_request, _tenant, responses):
            self.assertEqual([item["source_id"] for item in responses], ["source-1", "source-2"])
            yield {
                "event": "selected",
                "synthesis": {"source_id": "__response_aggregator__", "backend": {"id": "aggregator"}},
            }
            yield {"event": "token", "delta": "combined "}
            yield {"event": "token", "delta": "answer"}
            yield {
                "event": "done",
                "synthesis": {
                    "source_id": "__response_aggregator__",
                    "backend": {"id": "aggregator"},
                    "text": "combined answer",
                    "metadata": {},
                    "latency_ms": 7,
                },
                "metadata": {"instruction": "test", "prompt_chars": 8},
            }

        async def fake_stream(_tenant, source, **_kwargs):
            result = await fake_generate(_tenant, source, **_kwargs)
            async for item in fake_stream_response_source_from_result(source, result):
                yield item

        router.stream_response_source = fake_stream
        router.stream_response_synthesis = fake_synthesis
        req = router.EnsembleRequest(
            request_id="response-aggregate-flow",
            runner="response_aggregate",
            aggregator="synthesize",
            runner_config={"show_parallel_flow": True},
            sources=[
                router.EnsembleSource(source_id="source-1", model_alias="qwen-7b", prompt="Question?"),
                router.EnsembleSource(source_id="source-2", model_alias="llama-8b", prompt="Question?"),
            ],
        )
        events = await collect_events(router.run_response_aggregate_ensemble(req, self.tenant))
        stages = [data.get("stage") for event, data in events if event == "trace_step"]

        self.assertEqual(stages[0], "sources.parallel.started")
        self.assertEqual(stages[-2:], ["synthesis.started", "synthesis.completed"])
        self.assertEqual(stages.count("source.completed"), 2)
        completed_sources = [
            data["source_id"]
            for event, data in events
            if event == "trace_step" and data.get("stage") == "source.completed"
        ]
        self.assertEqual(completed_sources[0], "source-2")

    async def test_openai_stream_renders_parallel_flow_as_reasoning_when_enabled(self) -> None:
        async def fake_generate(_tenant, source, **_kwargs):
            return {
                "source_id": source.source_id,
                "backend": {"id": source.model_alias or source.source_id},
                "text": f"answer from {source.source_id}",
                "metadata": {},
                "weight": source.weight,
                "error": None,
                "latency_ms": 11,
            }

        async def fake_synthesis(_request, _tenant, responses):
            self.assertEqual(len(responses), 2)
            yield {
                "event": "selected",
                "synthesis": {"source_id": "__response_aggregator__", "backend": {"id": "aggregator"}},
            }
            yield {"event": "token", "delta": "combined "}
            yield {"event": "token", "delta": "answer"}
            yield {
                "event": "done",
                "synthesis": {
                    "source_id": "__response_aggregator__",
                    "backend": {"id": "aggregator"},
                    "text": "combined answer",
                    "metadata": {},
                    "latency_ms": 5,
                },
                "metadata": {"instruction": "test", "prompt_chars": 8},
            }

        async def fake_stream(_tenant, source, **_kwargs):
            result = await fake_generate(_tenant, source, **_kwargs)
            async for item in fake_stream_response_source_from_result(source, result):
                yield item

        router.stream_response_source = fake_stream
        router.stream_response_synthesis = fake_synthesis
        base_sources = [
            router.EnsembleSource(source_id="source-1", model_alias="qwen-7b", prompt="Question?"),
            router.EnsembleSource(source_id="source-2", model_alias="llama-8b", prompt="Question?"),
        ]
        visible_req = router.EnsembleRequest(
            request_id="openai-visible-flow",
            runner="response_aggregate",
            aggregator="synthesize",
            runner_config={"native_runner": "response.parallel", "show_parallel_flow": True},
            sources=base_sources,
        )
        visible_deltas, visible_reasoning_deltas = await collect_openai_deltas(
            router.stream_openai_ensemble_response(
                visible_req,
                self.tenant,
                request_id="openai-visible-flow",
                model="modelnet",
            )
        )
        visible_content = "".join(visible_deltas)
        visible_reasoning = "".join(visible_reasoning_deltas)

        self.assertEqual(visible_deltas, ["combined ", "answer"])
        self.assertEqual(visible_content, "combined answer")
        self.assertIn("ModelNet 并联流程", visible_reasoning)
        self.assertIn("并联发起", visible_reasoning)
        self.assertIn("source-1", visible_reasoning)
        self.assertIn("进入合成", visible_reasoning)
        self.assertNotIn("最终回答", visible_content)

        hidden_req = visible_req.model_copy(
            update={
                "request_id": "openai-hidden-flow",
                "runner_config": {"native_runner": "response.parallel"},
            }
        )
        hidden_deltas = await collect_openai_content_deltas(
            router.stream_openai_ensemble_response(
                hidden_req,
                self.tenant,
                request_id="openai-hidden-flow",
                model="modelnet",
            )
        )
        self.assertEqual(hidden_deltas, ["combined ", "answer"])
        self.assertEqual("".join(hidden_deltas), "combined answer")

    async def test_auto_plan_metadata_has_budget_confidence_and_ranker_result(self) -> None:
        router.scored_candidate_pool = self.stub_scored

        async def fake_generate(_tenant, source, **_kwargs):
            if source.source_id == "ranker":
                text = '{"winner_source_id": "candidate-2", "confidence": 0.88, "should_fuse": false, "reason": "ok"}'
            elif source.source_id == "candidate-2":
                text = "selected answer"
            else:
                text = "other answer"
            return {
                "source_id": source.source_id,
                "backend": {"id": source.model_alias or source.source_id},
                "text": text,
                "metadata": {},
                "weight": source.weight,
                "error": None,
            }

        router.generate_response_source = fake_generate
        events = await collect_events(
            router.run_auto_ensemble(
                request_for(
                    "Analyze the design tradeoffs and give a careful implementation plan.",
                    {"strategy": "adaptive_sparse_graph"},
                ),
                self.tenant,
            )
        )
        done = done_payload(events)
        auto_plan = done["metadata"]["auto_plan"]

        self.assertEqual(auto_plan["strategy"], "adaptive_sparse_graph")
        self.assertEqual(auto_plan['entry_runner'], 'auto.network')
        self.assertEqual(auto_plan["runner"], "auto.rank_fuse")
        self.assertEqual(auto_plan["plan_version"], "rank_fuse_v2")
        self.assertIn("call_budget", auto_plan)
        self.assertIn("load_state", auto_plan)
        self.assertIn("confidence_score", auto_plan)
        self.assertEqual(auto_plan["escalation_reason"], "ranker_selected")
        self.assertIn("ranker_decision", auto_plan)
        self.assertIn("compressed_contributions", auto_plan)
        self.assertIn("call_ledger_summary", auto_plan)
        self.assertIn("internal_total_tokens", auto_plan)


class BackendAdapterTests(unittest.TestCase):
    def test_context_limit_retry_uses_backend_token_count(self) -> None:
        detail = (
            "This model's maximum context length is 8192 tokens. However, you requested "
            "7600 output tokens and your prompt contains at least 593 input tokens, for "
            "a total of at least 8193 tokens."
        )

        self.assertEqual(backend_adapters.context_limit_retry_max_tokens(detail, 7600), 3800)

    def test_context_limit_retry_skips_when_prompt_exceeds_context(self) -> None:
        detail = (
            "This model's maximum context length is 8192 tokens. However, you requested "
            "1024 output tokens and your prompt contains 10816 input tokens, for a total "
            "of 11840 tokens."
        )

        self.assertIsNone(backend_adapters.context_limit_retry_max_tokens(detail, 1024))
        self.assertIsNone(backend_adapters.context_limit_retry_max_tokens("other bad request", 1024))


class RegistryObservabilityTests(unittest.TestCase):
    def test_registry_observability_reads_bundle_version_and_checksum_manifest(self) -> None:
        original_registry_path = router.REGISTRY_PATH
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                bundle = Path(temp_dir)
                registry = bundle / "model_net.yaml"
                registry.write_text("models: []\n", encoding="utf-8")
                digest = hashlib.sha256(registry.read_bytes()).hexdigest()
                (bundle / "version.json").write_text(
                    json.dumps(
                        {
                            "version": "2026-06-21T00-00-00Z",
                            "generated_at": "2026-06-21T00:00:00Z",
                        }
                    ),
                    encoding="utf-8",
                )
                (bundle / "checksums.sha256").write_text(
                    f"{digest}  model_net.yaml\n",
                    encoding="utf-8",
                )

                router.REGISTRY_PATH = registry
                info = router.registry_observability()

                self.assertEqual(info["registry_path"], str(registry))
                self.assertEqual(info["registry_version"], "2026-06-21T00-00-00Z")
                self.assertEqual(info["registry_generated_at"], "2026-06-21T00:00:00Z")
                self.assertEqual(info["registry_checksum"], digest)
                self.assertEqual(info["registry_checksum_source"], "checksums.sha256")
        finally:
            router.REGISTRY_PATH = original_registry_path

    def test_registry_observability_computes_checksum_without_bundle_metadata(self) -> None:
        original_registry_path = router.REGISTRY_PATH
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                registry = Path(temp_dir) / "model_net.yaml"
                registry.write_text("models: []\n", encoding="utf-8")
                digest = hashlib.sha256(registry.read_bytes()).hexdigest()

                router.REGISTRY_PATH = registry
                info = router.registry_observability()

                self.assertIsNone(info["registry_version"])
                self.assertEqual(info["registry_checksum"], digest)
                self.assertEqual(info["registry_checksum_source"], "computed")
        finally:
            router.REGISTRY_PATH = original_registry_path


if __name__ == "__main__":
    unittest.main()
