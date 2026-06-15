from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException


@dataclass(frozen=True)
class GatewayTenant:
    tenant_id: str
    api_key: str
    allowed_models: frozenset[str] = field(default_factory=frozenset)
    allowed_runners: frozenset[str] = field(default_factory=frozenset)
    allowed_aggregators: frozenset[str] = field(default_factory=frozenset)
    trace_allowed: bool = True

    def allows_model(self, model_id: str) -> bool:
        return not self.allowed_models or model_id in self.allowed_models

    def allows_runner(self, runner: str) -> bool:
        return not self.allowed_runners or runner in self.allowed_runners

    def allows_aggregator(self, aggregator: str) -> bool:
        return not self.allowed_aggregators or aggregator in self.allowed_aggregators


def load_gateway_tenants(*, api_keys_json: str, api_keys_csv: str, legacy_api_key: str) -> list[GatewayTenant]:
    """Load API-key tenants from env while preserving the legacy single-key mode.

    Supported forms:
      - MODELNET_API_KEYS_JSON='[{"tenant_id":"dify","api_key":"...","allowed_models":["m1"]}]'
      - MODELNET_API_KEYS='dify:key1,toc:key2'
      - MODELNET_ROUTER_API_KEY='...' legacy allow-all key.
    """
    tenants: list[GatewayTenant] = []
    if api_keys_json.strip():
        raw = json.loads(api_keys_json)
        if not isinstance(raw, list):
            raise ValueError("MODELNET_API_KEYS_JSON must be a JSON list")
        for idx, item in enumerate(raw):
            if not isinstance(item, dict):
                raise ValueError(f"MODELNET_API_KEYS_JSON[{idx}] must be an object")
            tenant_id = str(item.get("tenant_id") or item.get("id") or "").strip()
            api_key = str(item.get("api_key") or item.get("key") or "").strip()
            if not tenant_id or not api_key:
                raise ValueError(f"MODELNET_API_KEYS_JSON[{idx}] requires tenant_id and api_key")
            tenants.append(
                GatewayTenant(
                    tenant_id=tenant_id,
                    api_key=api_key,
                    allowed_models=frozenset(_string_list(item.get("allowed_models"))),
                    allowed_runners=frozenset(_string_list(item.get("allowed_runners"))),
                    allowed_aggregators=frozenset(_string_list(item.get("allowed_aggregators"))),
                    trace_allowed=bool(item.get("trace_allowed", True)),
                )
            )

    if api_keys_csv.strip():
        for entry in api_keys_csv.split(","):
            if not entry.strip():
                continue
            tenant_id, sep, api_key = entry.partition(":")
            if not sep:
                raise ValueError("MODELNET_API_KEYS entries must be tenant:key")
            tenants.append(GatewayTenant(tenant_id=tenant_id.strip(), api_key=api_key.strip()))

    if not tenants and legacy_api_key and legacy_api_key != "none":
        tenants.append(GatewayTenant(tenant_id="legacy", api_key=legacy_api_key))
    return tenants


def authenticate_gateway(authorization: str | None, tenants: list[GatewayTenant]) -> GatewayTenant:
    if not tenants:
        return GatewayTenant(tenant_id="anonymous", api_key="")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    for tenant in tenants:
        if tenant.api_key == token:
            return tenant
    raise HTTPException(status_code=401, detail="Unauthorized")


def _string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return []

