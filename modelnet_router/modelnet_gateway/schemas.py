from __future__ import annotations

import time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

MODELNET_RUN_SCHEMA_VERSION = "modelnet.run.v1"
MODELNET_EVENT_SCHEMA_VERSION = "modelnet.event.v1"


class ModelNetStreamOptions(BaseModel):
    model_config = ConfigDict(extra="allow")

    include_usage: bool = True
    include_trace: bool = False


class ModelNetRunRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    schema_version: str = MODELNET_RUN_SCHEMA_VERSION
    request_id: str | None = None
    model: str | None = None
    messages: list[dict[str, Any]] = Field(default_factory=list)
    tools: list[dict[str, Any]] = Field(default_factory=list)
    files: list[dict[str, Any]] = Field(default_factory=list)
    constraints: dict[str, Any] = Field(default_factory=dict)
    required_capabilities: list[str] = Field(default_factory=list)
    policy: dict[str, Any] = Field(default_factory=dict)
    collaboration_plan: dict[str, Any] = Field(default_factory=dict)
    sampling_params: dict[str, Any] = Field(default_factory=dict)
    stream: bool = True
    stream_options: ModelNetStreamOptions = Field(default_factory=ModelNetStreamOptions)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ModelNetEvent(BaseModel):
    model_config = ConfigDict(extra="allow")

    schema_version: str = MODELNET_EVENT_SCHEMA_VERSION
    request_id: str
    event: Literal[
        "run_started",
        "model_selected",
        "token_delta",
        "source_response",
        "aggregation_step",
        "trace",
        "usage",
        "error",
        "done",
    ]
    data: dict[str, Any] = Field(default_factory=dict)
    created: float = Field(default_factory=time.time)


class ModelSpec(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    object: str = "model"
    owned_by: str = "modelnet"
    backend: str
    backend_model: str
    capabilities: list[str] = Field(default_factory=list)
    context_length: int | None = None
    cost: dict[str, Any] = Field(default_factory=dict)
    latency: dict[str, Any] = Field(default_factory=dict)
    health: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class BackendCapability(BaseModel):
    model_config = ConfigDict(extra="allow")

    backend: str
    adapter: str
    chat: bool = False
    completion: bool = False
    token_step: bool = False
    logits_raw: bool = False
    vision: bool = False
    tools: bool = False
    structured_output: bool = False
    context_length: int | None = None
    cost: dict[str, Any] = Field(default_factory=dict)
    latency: dict[str, Any] = Field(default_factory=dict)
    health: dict[str, Any] = Field(default_factory=dict)


class EnsembleSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_id: str = Field(min_length=1)
    model_alias: str | None = None
    prompt: str = ""
    messages: list[dict[str, Any]] | None = None
    sampling_params: dict[str, Any] = Field(default_factory=dict)
    extra: dict[str, Any] = Field(default_factory=dict)
    weight: float = Field(default=1.0, gt=0)

    @field_validator("source_id")
    @classmethod
    def _source_id_not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("source_id must not be blank")
        return stripped


class DiagnosticsConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enable_trace_stream: bool = False
    include_candidates: bool = True
    include_scores: bool = True
    storage: Literal["metadata", "inline"] = "metadata"


class EnsembleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sources: list[EnsembleSource] = Field(min_length=1)
    runner: str = "token_step"
    runner_config: dict[str, Any] = Field(default_factory=dict)
    aggregator: str = "sum_score"
    aggregator_config: dict[str, Any] = Field(default_factory=dict)
    diagnostics: DiagnosticsConfig = Field(default_factory=DiagnosticsConfig)
    request_id: str | None = None


class RouteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidate_aliases: list[str] | None = None
    source_id: str | None = None
    required_capabilities: list[str] = Field(default_factory=list)
    strategy: str = "load_aware"
    policy: dict[str, Any] = Field(default_factory=dict)
