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


@dataclass(frozen=True)
class AggregatorPlugin:
    name: str
    scope: str
    description: str
    required_capabilities: tuple[str, ...] = ()


RUNNER_ALIASES = {
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
    "route.once": RunnerPlugin(
        name="route.once",
        legacy_name="route",
        scope="route",
        description="Select one backend by capability, health, load and policy, then run a normal chat.",
        supported_aggregators=("load_aware", "capability_aware", "cost_aware", "latency_aware"),
    ),
    "token.parallel": RunnerPlugin(
        name="token.parallel",
        legacy_name="token_step",
        scope="token",
        description="Fan out multiple models one token at a time and aggregate each token decision.",
        supported_aggregators=("sum_score", "max_score", "duet_net", "learned_router"),
        required_capabilities=("token_step", "top_probs"),
    ),
    "token.serial": RunnerPlugin(
        name="token.serial",
        legacy_name="token_step",
        scope="token",
        description="Token or chunk level serial refinement; currently executed through the token-step engine.",
        supported_aggregators=("sum_score", "max_score"),
        required_capabilities=("token_step", "top_probs"),
    ),
    "response.parallel": RunnerPlugin(
        name="response.parallel",
        legacy_name="response_aggregate",
        scope="response",
        description="Fan out complete source responses, then synthesize the final response.",
        supported_aggregators=("synthesize", "select_best", "rank_vote", "judge_refine"),
    ),
    "response.serial": RunnerPlugin(
        name="response.serial",
        legacy_name="dynamic_collab_route",
        scope="response",
        description="Run complete responses in sequence, with later models judging or refining earlier output.",
        supported_aggregators=("judge_refine", "synthesize"),
    ),
    "hybrid.graph": RunnerPlugin(
        name="hybrid.graph",
        legacy_name="dynamic_collab_route",
        scope="graph",
        description="Execute a DAG-shaped collaboration plan; currently lowered to serial response refinement.",
        supported_aggregators=("synthesize", "judge_refine", "load_aware"),
    ),
}

AGGREGATOR_PLUGINS = {
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
    ),
    "learned_router": AggregatorPlugin(
        name="learned_router",
        scope="token",
        description="Reserved learned token router aggregator.",
        required_capabilities=("token_step",),
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
    ),
    "rank_vote": AggregatorPlugin(
        name="rank_vote",
        scope="response",
        description="Reserved response-level ranked voting aggregator.",
    ),
    "judge_refine": AggregatorPlugin(
        name="judge_refine",
        scope="response",
        description="Judge and refine a previous response.",
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
    ),
    "latency_aware": AggregatorPlugin(
        name="latency_aware",
        scope="route",
        description="Reserved latency-sensitive route aggregator.",
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
            "description": plugin.description,
            "supported_aggregators": list(plugin.supported_aggregators),
            "required_capabilities": list(plugin.required_capabilities),
        }
        for plugin in RUNNER_PLUGINS.values()
    ]


def aggregator_payload() -> list[dict[str, Any]]:
    return [
        {
            "name": plugin.name,
            "scope": plugin.scope,
            "description": plugin.description,
            "required_capabilities": list(plugin.required_capabilities),
        }
        for plugin in AGGREGATOR_PLUGINS.values()
    ]

