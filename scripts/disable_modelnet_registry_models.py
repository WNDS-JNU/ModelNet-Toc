#!/usr/bin/env python3
"""Remove selected model IDs from a ModelNet registry atomically."""

from __future__ import annotations

import argparse
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

import yaml


class RegistryDisableError(RuntimeError):
    pass


def parse_model_ids(raw: str) -> set[str]:
    return {item.strip() for item in raw.split(",") if item.strip()}


def load_registry(path: Path) -> dict[str, Any]:
    try:
        payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise RegistryDisableError(f"Cannot load registry {path}: {exc}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
        raise RegistryDisableError("registry must contain a models list")
    return payload


def disable_models(
    payload: dict[str, Any], disabled_ids: set[str]
) -> tuple[dict[str, Any], list[str]]:
    models = [item for item in payload.get("models", []) if isinstance(item, dict)]
    present_ids = {str(item.get("id") or "").strip() for item in models}
    removed_ids = sorted(present_ids & disabled_ids)

    filtered = dict(payload)
    filtered["models"] = [
        item for item in models if str(item.get("id") or "").strip() not in disabled_ids
    ]

    capabilities = payload.get("capabilities")
    if isinstance(capabilities, dict):
        filtered_capabilities: dict[str, Any] = {}
        for capability_id, capability in capabilities.items():
            if not isinstance(capability, dict):
                filtered_capabilities[capability_id] = capability
                continue
            filtered_capability = dict(capability)
            candidates = capability.get("candidates")
            if isinstance(candidates, list):
                filtered_capability["candidates"] = [
                    candidate
                    for candidate in candidates
                    if not isinstance(candidate, dict)
                    or str(candidate.get("model") or "").strip() not in disabled_ids
                ]
            filtered_capabilities[capability_id] = filtered_capability
        filtered["capabilities"] = filtered_capabilities

    return filtered, removed_ids


def render_registry(payload: dict[str, Any]) -> str:
    return yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)


def write_registry(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    try:
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--disabled-models", required=True)
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--require-all", action="store_true")
    args = parser.parse_args()

    disabled_ids = parse_model_ids(args.disabled_models)
    if not disabled_ids:
        raise SystemExit("--disabled-models must contain at least one model ID")

    try:
        payload = load_registry(args.source)
        filtered, removed_ids = disable_models(payload, disabled_ids)
    except RegistryDisableError as exc:
        raise SystemExit(str(exc)) from exc

    missing_ids = sorted(disabled_ids - set(removed_ids))
    if args.require_all and missing_ids:
        raise SystemExit("Requested model IDs are absent from registry: " + ", ".join(missing_ids))
    if not filtered["models"]:
        raise SystemExit("Refusing to write an empty model registry")

    if args.backup:
        args.backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(args.source, args.backup)
    write_registry(args.output, render_registry(filtered))

    print(f"Removed {len(removed_ids)} model(s):")
    for model_id in removed_ids:
        print(f"- {model_id}")
    if missing_ids:
        print("Already absent:")
        for model_id in missing_ids:
            print(f"- {model_id}")
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
