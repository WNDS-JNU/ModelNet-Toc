from __future__ import annotations

from typing import Any

from modelnet_gateway.plugins import canonical_runner, legacy_runner_name
from modelnet_gateway.schemas import EnsembleRequest, EnsembleSource, ModelNetRunRequest

OPENAI_SAMPLING_KEYS = {
    "frequency_penalty",
    "logit_bias",
    "max_completion_tokens",
    "max_tokens",
    "n",
    "presence_penalty",
    "response_format",
    "seed",
    "stop",
    "temperature",
    "tool_choice",
    "top_k",
    "top_logprobs",
    "top_p",
}


def redact_modelnet_options(value: Any) -> Any:
    if not isinstance(value, dict):
        return value

    redacted = dict(value)
    if "runtime_candidates" in redacted:
        runtime_candidates = redacted.pop("runtime_candidates")
        redacted["runtime_candidates_redacted"] = (
            len(runtime_candidates) if isinstance(runtime_candidates, list) else True
        )
    return redacted


def redact_openai_metadata_value(key: str, value: Any) -> Any:
    if key == "modelnet":
        return redact_modelnet_options(value)
    return value


def openai_chat_to_ir(body: dict[str, Any]) -> ModelNetRunRequest:
    modelnet_options = body.get("modelnet") if isinstance(body.get("modelnet"), dict) else {}
    sampling_params = {
        key: body[key]
        for key in OPENAI_SAMPLING_KEYS
        if key in body and body[key] is not None
    }
    required_capabilities = list(modelnet_options.get("required_capabilities") or [])
    if body.get("tools"):
        required_capabilities.append("tools")
    if body.get("response_format"):
        required_capabilities.append("structured_output")

    collaboration_plan = dict(modelnet_options.get("collaboration_plan") or {})
    requested_model = str(body.get("model") or "")
    requested_runner = collaboration_plan.get("runner")
    if requested_model == "modelnet-auto" and not requested_runner:
        collaboration_plan["runner"] = "auto.network"
        collaboration_plan.setdefault("aggregator", "auto")
    else:
        if requested_runner:
            runner = canonical_runner(str(requested_runner))
            collaboration_plan["runner"] = runner
            collaboration_plan.setdefault("aggregator", default_aggregator_for(runner))
        else:
            collaboration_plan.setdefault("runner", "route.once")
    if "candidate_aliases" in modelnet_options:
        collaboration_plan["candidate_aliases"] = modelnet_options["candidate_aliases"]
    if "runtime_candidates" in modelnet_options:
        collaboration_plan["runtime_candidates"] = modelnet_options["runtime_candidates"]

    return ModelNetRunRequest(
        request_id=str(body.get("request_id") or "") or None,
        model=str(body.get("model") or "") or None,
        messages=list(body.get("messages") or []),
        tools=list(body.get("tools") or []),
        required_capabilities=dedupe(required_capabilities),
        policy=dict(modelnet_options.get("policy") or {}),
        collaboration_plan=collaboration_plan,
        sampling_params=sampling_params,
        stream=bool(body.get("stream")),
        stream_options=dict(modelnet_options.get("stream_options") or {}),
        metadata={
            "northbound_protocol": "openai-compatible",
            "raw_model": body.get("model"),
            "raw_request_metadata": {
                key: redact_openai_metadata_value(key, value)
                for key, value in body.items()
                if key not in {"messages", "tools"}
            },
        },
    )


def native_to_ir(payload: dict[str, Any]) -> ModelNetRunRequest:
    request = ModelNetRunRequest.model_validate(payload)
    plan = dict(request.collaboration_plan)
    plan["runner"] = canonical_runner(plan.get("runner"))
    return request.model_copy(update={"collaboration_plan": plan})


def ir_to_ensemble_request(ir: ModelNetRunRequest) -> EnsembleRequest:
    plan = dict(ir.collaboration_plan)
    runner = canonical_runner(plan.get("runner"))
    aggregator = str(plan.get("aggregator") or default_aggregator_for(runner))
    runner_config = dict(plan.get("runner_config") or {})
    runner_config.setdefault("native_runner", runner)
    if "graph" in plan:
        runner_config["graph"] = plan["graph"]
    if "runtime_candidates" in plan:
        runner_config["runtime_candidates"] = plan["runtime_candidates"]
    if ir.required_capabilities:
        runner_config.setdefault("required_capabilities", list(ir.required_capabilities))
    if ir.policy:
        runner_config.setdefault("policy", ir.policy)

    diagnostics = dict(plan.get("diagnostics") or {})
    if ir.stream_options.include_trace:
        diagnostics["enable_trace_stream"] = True

    return EnsembleRequest(
        sources=build_sources(ir, plan),
        runner=legacy_runner_name(runner),
        runner_config=runner_config,
        aggregator=aggregator,
        aggregator_config=dict(plan.get("aggregator_config") or {}),
        diagnostics=diagnostics,
        request_id=ir.request_id,
    )


def build_sources(ir: ModelNetRunRequest, plan: dict[str, Any]) -> list[EnsembleSource]:
    source_items = plan.get("sources")
    if isinstance(source_items, list) and source_items:
        return [source_from_payload(index, item, ir) for index, item in enumerate(source_items)]

    aliases = plan.get("candidate_aliases") or plan.get("model_aliases") or plan.get("models")
    if isinstance(aliases, str):
        aliases = [aliases]
    if isinstance(aliases, list) and aliases:
        return [
            default_source(ir, source_id=f"source-{index + 1}", model_alias=str(alias))
            for index, alias in enumerate(aliases)
        ]

    model_alias = ir.model if ir.model and ir.model not in {"modelnet", "modelnet-auto"} else None
    return [default_source(ir, source_id="source-1", model_alias=model_alias)]


def source_from_payload(index: int, item: Any, ir: ModelNetRunRequest) -> EnsembleSource:
    payload = item if isinstance(item, dict) else {"model_alias": str(item)}
    sampling_params = dict(ir.sampling_params)
    sampling_params.update(dict(payload.get("sampling_params") or {}))
    return EnsembleSource(
        source_id=str(payload.get("source_id") or payload.get("id") or f"source-{index + 1}"),
        model_alias=str(payload.get("model_alias") or payload.get("model") or "") or None,
        prompt=str(payload.get("prompt") or prompt_from_messages(ir.messages)),
        messages=payload.get("messages") or ir.messages or None,
        sampling_params=sampling_params,
        extra=dict(payload.get("extra") or {}),
        weight=float(payload.get("weight", 1.0)),
    )


def default_source(ir: ModelNetRunRequest, *, source_id: str, model_alias: str | None) -> EnsembleSource:
    return EnsembleSource(
        source_id=source_id,
        model_alias=model_alias,
        prompt=prompt_from_messages(ir.messages),
        messages=ir.messages or None,
        sampling_params=dict(ir.sampling_params),
        extra={},
        weight=1.0,
    )


def prompt_from_messages(messages: list[dict[str, Any]]) -> str:
    if not messages:
        return ""
    parts: list[str] = []
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else ""
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = "\n".join(
                str(part.get("text", ""))
                for part in content
                if isinstance(part, dict)
            )
        else:
            text = str(content or "")
        if text:
            parts.append(text)
    return "\n".join(parts)


def default_aggregator_for(runner: str) -> str:
    if runner == "auto.network":
        return "auto"
    if runner.startswith("token."):
        return "sum_score"
    if runner == "response.serial":
        return "judge_refine"
    if runner.startswith("response."):
        return "synthesize"
    return "load_aware"


def dedupe(values: list[str]) -> list[str]:
    out: list[str] = []
    for value in values:
        if value and value not in out:
            out.append(value)
    return out
