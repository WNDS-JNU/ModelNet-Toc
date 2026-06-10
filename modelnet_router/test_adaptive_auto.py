from __future__ import annotations

import sys
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


class AdaptiveAutoTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.tenant = FakeTenant()
        self.scored = [
            (candidate("qwen-7b"), 10.0, "ready"),
            (candidate("llama-8b"), 120.0, "ready"),
            (candidate("granite-3b"), 240.0, "ready"),
        ]
        self.original_scored_candidate_pool = router.scored_candidate_pool
        self.original_generate_response_source = router.generate_response_source
        self.original_generate_response_synthesis = router.generate_response_synthesis
        self.original_trace_path = router.AUTO_ROUTER_TRACE_PATH
        router.AUTO_ROUTER_TRACE_PATH = Path("/tmp/modelnet-router-test-trace.jsonl")

    def tearDown(self) -> None:
        router.scored_candidate_pool = self.original_scored_candidate_pool
        router.generate_response_source = self.original_generate_response_source
        router.generate_response_synthesis = self.original_generate_response_synthesis
        router.AUTO_ROUTER_TRACE_PATH = self.original_trace_path

    async def stub_scored(self, *args, **kwargs):
        return list(self.scored)

    async def test_low_complexity_selects_route_once(self) -> None:
        router.scored_candidate_pool = self.stub_scored
        planned, plan = await router.plan_auto_ensemble(request_for("Say hello."), self.tenant)

        self.assertEqual(planned.runner, "route")
        self.assertEqual(plan["runner"], "route.once")
        self.assertEqual(plan["strategy"], "adaptive_sparse_graph")
        self.assertEqual(plan["call_budget"]["max_sources"], 2)

    async def test_complex_default_selects_rank_fuse(self) -> None:
        router.scored_candidate_pool = self.stub_scored
        planned, plan = await router.plan_auto_ensemble(
            request_for("Analyze and compare the design tradeoffs, risks, and implementation plan."),
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
        done = [data for event, data in events if event == "done"][0]

        self.assertEqual(done["text"], "primary answer")
        self.assertEqual(done["metadata"]["source_count"], 1)
        self.assertEqual(done["metadata"]["escalation_reason"], "verifier_passed")

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
        done = [data for event, data in events if event == "done"][0]

        self.assertEqual(done["text"], "escalated answer")
        self.assertEqual(done["metadata"]["source_count"], 2)
        self.assertEqual(done["metadata"]["escalation_reason"], "verifier_failed_escalated")

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
        done = [data for event, data in events if event == "done"][0]

        self.assertEqual(done["text"], "better answer")
        self.assertEqual(done["metadata"]["selected_source_id"], "candidate-2")
        self.assertEqual(done["metadata"]["escalation_reason"], "ranker_selected")

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
        done = [data for event, data in events if event == "done"][0]

        self.assertEqual(done["text"], "fused answer")
        self.assertEqual(done["metadata"]["escalation_reason"], "ranker_fused")
        self.assertIn("response_aggregator", done["metadata"])

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
        done = [data for event, data in events if event == "done"][0]
        auto_plan = done["metadata"]["auto_plan"]

        self.assertEqual(auto_plan["strategy"], "adaptive_sparse_graph")
        self.assertEqual(auto_plan["runner"], "auto.rank_fuse")
        self.assertEqual(auto_plan["plan_version"], "rank_fuse_v2")
        self.assertIn("call_budget", auto_plan)
        self.assertIn("load_state", auto_plan)
        self.assertIn("confidence_score", auto_plan)
        self.assertEqual(auto_plan["escalation_reason"], "ranker_selected")
        self.assertIn("ranker_decision", auto_plan)
        self.assertIn("compressed_contributions", auto_plan)


if __name__ == "__main__":
    unittest.main()
