from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RunnerPlugin:
    name: str
    legacy_name: str
    scope: str
    description: str
    supported_aggregators: tuple[str, ...]
    required_capabilities: tuple[str, ...] = ()
    status: str = "implemented"
    status_reason: str = ""


@dataclass(frozen=True)
class AggregatorPlugin:
    name: str
    scope: str
    description: str
    required_capabilities: tuple[str, ...] = ()
    status: str = "implemented"
    status_reason: str = ""


RUNNER_ALIASES = {
    "auto": "auto.network",
    "auto_network": "auto.network",
    "auto.network": "auto.network",
    "role_graph": "auto.role_graph",
    "auto_role_graph": "auto.role_graph",
    "auto.role_graph": "auto.role_graph",
    "claim_graph": "auto.claim_graph",
    "auto_claim_graph": "auto.claim_graph",
    "auto.claim_graph": "auto.claim_graph",
    "route": "route.once",
    "route_once": "route.once",
    "route.once": "route.once",
    "token_step": "token.parallel",
    "token_parallel": "token.parallel",
    "token.parallel": "token.parallel",
    "token_serial": "token.serial",
    "token.serial": "token.serial",
    "response_aggregate": "response.parallel",
    "response_parallel": "response.parallel",
    "response.parallel": "response.parallel",
    "dynamic_collab_route": "response.serial",
    "response_serial": "response.serial",
    "response.serial": "response.serial",
    "hybrid_graph": "hybrid.graph",
    "hybrid.graph": "hybrid.graph",
}

RUNNER_PLUGINS = {
    "auto.network": RunnerPlugin(
        name="auto.network",
        legacy_name="auto",
        scope="graph",
        description="Plan a query-conditioned model network, then execute it through an implemented runner.",
        supported_aggregators=("auto",),
    ),
    "auto.role_graph": RunnerPlugin(
        name="auto.role_graph",
        legacy_name="role_graph",
        scope="graph",
        description="Run role-specialized expert responses with optional critic review and synthesis.",
        supported_aggregators=("synthesize",),
    ),
    "auto.claim_graph": RunnerPlugin(
        name="auto.claim_graph",
        legacy_name="claim_graph",
        scope="graph",
        description="Run explicit claim-level draft, extraction, verification, and conservative assembly.",
        supported_aggregators=("auto",),
    ),
    "route.once": RunnerPlugin(
        name="route.once",
        legacy_name="route",
        scope="route",
        description="Select one backend by capability, health, load and policy, then run a normal chat.",
        supported_aggregators=("load_aware", "capability_aware"),
    ),
    "token.parallel": RunnerPlugin(
        name="token.parallel",
        legacy_name="token_step",
        scope="token",
        description="Fan out multiple models one token at a time and aggregate each token decision.",
        supported_aggregators=("sum_score", "max_score"),
        required_capabilities=("token_step", "top_probs"),
    ),
    "token.serial": RunnerPlugin(
        name="token.serial",
        legacy_name="token_step",
        scope="token",
        description="Token or chunk level serial refinement.",
        supported_aggregators=("sum_score", "max_score"),
        required_capabilities=("token_step", "top_probs"),
        status="reserved",
        status_reason="Token-serial execution is not implemented as a distinct v1 runner.",
    ),
    "response.parallel": RunnerPlugin(
        name="response.parallel",
        legacy_name="response_aggregate",
        scope="response",
        description="Fan out complete source responses, then synthesize the final response.",
        supported_aggregators=("synthesize",),
    ),
    "response.serial": RunnerPlugin(
        name="response.serial",
        legacy_name="dynamic_collab_route",
        scope="response",
        description="Run complete responses in sequence, with later models judging or refining earlier output.",
        supported_aggregators=("judge_refine", "synthesize"),
        status="degraded",
        status_reason="Implemented through the legacy serial-refinement fallback, not a full native v1 runner.",
    ),
    "hybrid.graph": RunnerPlugin(
        name="hybrid.graph",
        legacy_name="dynamic_collab_route",
        scope="graph",
        description="Execute a DAG-shaped collaboration plan.",
        supported_aggregators=("synthesize", "judge_refine", "load_aware"),
        status="reserved",
        status_reason="The native DAG scheduler is not implemented yet.",
    ),
}

AGGREGATOR_PLUGINS = {
    "auto": AggregatorPlugin(
        name="auto",
        scope="graph",
        description="Planner-selected aggregator for query-conditioned automatic networking.",
    ),
    "sum_score": AggregatorPlugin(
        name="sum_score",
        scope="token",
        description="Weighted sum over source token probabilities.",
        required_capabilities=("top_probs",),
    ),
    "max_score": AggregatorPlugin(
        name="max_score",
        scope="token",
        description="Select the token with the highest weighted source probability.",
        required_capabilities=("top_probs",),
    ),
    "duet_net": AggregatorPlugin(
        name="duet_net",
        scope="token",
        description="Reserved token-level duet network aggregator.",
        required_capabilities=("token_step", "logits_raw"),
        status="reserved",
        status_reason="The duet network scorer is not implemented yet.",
    ),
    "learned_router": AggregatorPlugin(
        name="learned_router",
        scope="token",
        description="Reserved learned token router aggregator.",
        required_capabilities=("token_step",),
        status="reserved",
        status_reason="The learned token router is not implemented yet.",
    ),
    "synthesize": AggregatorPlugin(
        name="synthesize",
        scope="response",
        description="Use a selected model to synthesize complete upstream responses.",
    ),
    "select_best": AggregatorPlugin(
        name="select_best",
        scope="response",
        description="Reserved response-level best-answer selector.",
        status="reserved",
        status_reason="Response selection has no implemented scoring policy yet.",
    ),
    "rank_vote": AggregatorPlugin(
        name="rank_vote",
        scope="response",
        description="Reserved response-level ranked voting aggregator.",
        status="reserved",
        status_reason="Ranked voting has no implemented response ranking policy yet.",
    ),
    "judge_refine": AggregatorPlugin(
        name="judge_refine",
        scope="response",
        description="Judge and refine a previous response.",
        status="degraded",
        status_reason="Only available through the legacy response.serial fallback.",
    ),
    "load_aware": AggregatorPlugin(
        name="load_aware",
        scope="route",
        description="Route by health and live load score.",
    ),
    "capability_aware": AggregatorPlugin(
        name="capability_aware",
        scope="route",
        description="Route only across models satisfying required capabilities.",
    ),
    "cost_aware": AggregatorPlugin(
        name="cost_aware",
        scope="route",
        description="Reserved cost-sensitive route aggregator.",
        status="reserved",
        status_reason="Registry cost data is not wired into routing yet.",
    ),
    "latency_aware": AggregatorPlugin(
        name="latency_aware",
        scope="route",
        description="Reserved latency-sensitive route aggregator.",
        status="reserved",
        status_reason="Live latency histograms are not wired into routing yet.",
    ),
}

BACKEND_ADAPTERS = {
    "vllm_chat": {
        "adapter": "openai-compatible-backend",
        "chat": True,
        "completion": False,
        "token_step": True,
        "logits_raw": False,
        "vision": False,
        "tools": False,
        "structured_output": True,
    },
    "llama_cpp": {
        "adapter": "llama.cpp",
        "chat": True,
        "completion": True,
        "token_step": True,
        "logits_raw": True,
        "vision": False,
        "tools": False,
        "structured_output": True,
    },
    "openai_compatible": {
        "adapter": "openai-compatible-backend",
        "chat": True,
        "completion": False,
        "token_step": False,
        "logits_raw": False,
        "vision": False,
        "tools": True,
        "structured_output": True,
    },
    "anthropic": {
        "adapter": "anthropic-compatible-backend",
        "chat": True,
        "completion": False,
        "token_step": False,
        "logits_raw": False,
        "vision": True,
        "tools": True,
        "structured_output": True,
    },
    "ollama": {
        "adapter": "ollama",
        "chat": True,
        "completion": True,
        "token_step": False,
        "logits_raw": False,
        "vision": True,
        "tools": True,
        "structured_output": True,
    },
    "dify_provider": {
        "adapter": "dify-provider",
        "chat": True,
        "completion": False,
        "token_step": False,
        "logits_raw": False,
        "vision": False,
        "tools": True,
        "structured_output": False,
    },
    "custom_http": {
        "adapter": "custom-http",
        "chat": True,
        "completion": True,
        "token_step": False,
        "logits_raw": False,
        "vision": False,
        "tools": False,
        "structured_output": False,
    },
}


def canonical_runner(name: str | None) -> str:
    if not name:
        return "route.once"
    return RUNNER_ALIASES.get(name.strip(), name.strip())


def legacy_runner_name(name: str | None) -> str:
    canonical = canonical_runner(name)
    plugin = RUNNER_PLUGINS.get(canonical)
    return plugin.legacy_name if plugin else canonical


def runner_payload() -> list[dict[str, Any]]:
    return [
        {
            "name": plugin.name,
            "legacy_name": plugin.legacy_name,
            "scope": plugin.scope,
            "status": plugin.status,
            "available": plugin.status == "implemented",
            "description": plugin.description,
            "supported_aggregators": list(plugin.supported_aggregators),
            "required_capabilities": list(plugin.required_capabilities),
            "status_reason": plugin.status_reason,
        }
        for plugin in RUNNER_PLUGINS.values()
    ]


def aggregator_payload() -> list[dict[str, Any]]:
    return [
        {
            "name": plugin.name,
            "scope": plugin.scope,
            "status": plugin.status,
            "available": plugin.status == "implemented",
            "description": plugin.description,
            "required_capabilities": list(plugin.required_capabilities),
            "status_reason": plugin.status_reason,
        }
        for plugin in AGGREGATOR_PLUGINS.values()
    ]
