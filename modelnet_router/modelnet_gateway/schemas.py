from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


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
