from __future__ import annotations

import asyncio
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


def candidate(model_id: str) -> router.Candidate:
    return router.Candidate(
        model_id=model_id,
        backend_type="custom_http",
        k8s_namespace="inference",
        backend_model=model_id,
        root_url="http://127.0.0.1",
        api_base="http://127.0.0.1/v1",
        service_names=(model_id,),
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


async def collect_openai_content(stream) -> str:
    return "".join(await collect_openai_content_deltas(stream))


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
        self.original_scored_candidate_pool = router.scored_candidate_pool
        self.original_visible_candidates = router.visible_candidates
        self.original_generate_text = router.generate_text
        self.original_generate_response_source = router.generate_response_source
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
        router.scored_candidate_pool = self.original_scored_candidate_pool
        router.visible_candidates = self.original_visible_candidates
        router.generate_text = self.original_generate_text
        router.generate_response_source = self.original_generate_response_source
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
        async def fake_generate(_tenant, source):
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
        async def fake_generate(_tenant, source):
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

        async def fake_generate_text(_candidate, _source, *, prompt_override=None):
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
        async def fake_generate(_tenant, source):
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
        async def fake_generate(_tenant, source):
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
        async def fake_generate(_tenant, source):
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
        async def fake_generate(_tenant, source):
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
        async def fake_generate(_tenant, source):
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

        router.generate_response_source = fake_generate
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

    async def test_response_aggregate_sources_receive_original_payloads(self) -> None:
        seen: dict[str, dict[str, Any]] = {}

        async def fake_generate(_tenant, source):
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

        router.generate_response_source = fake_generate
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

    def test_response_hidden_reasoning_filter_removes_think_blocks(self) -> None:
        text, removed = router.strip_response_hidden_reasoning("<think>secret</think>\nfinal")

        self.assertEqual(text, "final")
        self.assertTrue(removed)

    async def test_response_source_filters_hidden_reasoning_without_prompt_controls(self) -> None:
        async def fake_pick(_tenant, source, required_capabilities=None):
            self.assertEqual(source.prompt, "Question?")
            self.assertIsNone(required_capabilities)
            return candidate("qwen-7b"), 10.0, "ready"

        async def fake_generate_text(_candidate, source, prompt_override=None):
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

    async def test_response_aggregate_emits_parallel_flow_when_enabled(self) -> None:
        async def fake_generate(_tenant, source):
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

        router.generate_response_source = fake_generate
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

    async def test_openai_stream_renders_parallel_flow_when_enabled(self) -> None:
        async def fake_generate(_tenant, source):
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

        router.generate_response_source = fake_generate
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
        visible_deltas = await collect_openai_content_deltas(
            router.stream_openai_ensemble_response(
                visible_req,
                self.tenant,
                request_id="openai-visible-flow",
                model="modelnet",
            )
        )
        visible_content = "".join(visible_deltas)

        self.assertIn("ModelNet 并联流程", visible_content)
        self.assertIn("并联发起", visible_content)
        self.assertIn("source-1", visible_content)
        self.assertIn("进入合成", visible_content)
        self.assertIn("最终回答", visible_content)
        answer_deltas = [delta for delta in visible_deltas if delta in {"combined ", "answer"}]
        self.assertEqual(answer_deltas, ["combined ", "answer"])
        self.assertTrue(visible_content.endswith("combined answer"))

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

        async def fake_generate(_tenant, source):
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


if __name__ == "__main__":
    unittest.main()
