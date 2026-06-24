#!/usr/bin/env python3
"""Publish a versioned ModelNet registry bundle.

The bundle is the runtime contract shared by Router and LiteLLM.  It keeps the
raw ModelNet registry and derived configs in one published version instead of
binding individual files into containers.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

import sync_modelnet_litellm


DEFAULT_SOURCE = Path("/home/duxianghe/modelnet-runtime/registry-source/capability-registry.yaml")
DEFAULT_ROOT = Path("/home/duxianghe/modelnet-runtime/registry-dev")
CHECKSUM_FILES = (
    "capability-registry.yaml",
    "litellm/modelnet-config.yaml",
    "version.json",
)
CHAT_BACKENDS = {"llama_cpp", "ollama", "openai_compatible", "vllm_chat"}
RUNTIME_BY_BACKEND = {
    "llama_cpp": "llama_cpp",
    "openai_compatible": "openai_compatible",
    "vllm_chat": "vllm",
}
CAPABILITY_SPECS: dict[str, dict[str, Any]] = {
    "audio.transcribe": {
        "task": "transcription",
        "modality": "audio",
        "sync": True,
        "async": True,
        "cost_unit": "audio_minute",
    },
    "chat.general": {
        "task": "chat",
        "modality": "text",
        "sync": True,
        "stream": True,
        "default_policy": "balanced",
    },
    "code.modify": {
        "task": "code",
        "modality": "text",
        "sync": True,
        "stream": True,
        "default_policy": "balanced",
        "requires_tools": ["file.read", "file.write", "git.diff", "shell.test"],
    },
    "image.generate": {
        "task": "text_to_image",
        "modality": "image",
        "sync": False,
        "async": True,
        "cost_unit": "image",
    },
    "rag.embed": {
        "task": "embedding",
        "modality": "text",
        "sync": True,
    },
}
TERM_KEYS = (
    "capability",
    "capabilities",
    "model_capabilities",
    "supported_capabilities",
    "supported_tasks",
    "tags",
    "task",
    "tasks",
    "type",
)
CHAT_TERMS = {
    "chat",
    "chat_completion",
    "chat_completions",
    "completion",
    "conversational",
    "instruct",
    "text_generation",
}
CODE_TERMS = {"code", "code_modification", "code_modify", "coding", "programming"}
EMBEDDING_TERMS = {"embed", "embedding", "embeddings", "text_embedding"}
NON_CHAT_TERMS = {"classification", "cross_encoder", "embed", "embedding", "embeddings", "rerank", "reranker", "score"}
TRANSCRIPTION_TERMS = {
    "asr",
    "audio_transcription",
    "speech_to_text",
    "transcribe",
    "transcription",
}
IMAGE_GENERATION_TERMS = {
    "image_generate",
    "image_generation",
    "text2image",
    "text_to_image",
    "txt2img",
}


class RegistryPublishError(RuntimeError):
    """Raised when a registry bundle cannot be safely published."""


@dataclass(frozen=True)
class PublishResult:
    version: str
    bundle_dir: Path
    current_link: Path | None
    dry_run: bool
    checksums: dict[str, str]


def utc_version() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%SZ")


def safe_version(version: str) -> str:
    version = str(version).strip()
    if not version:
        raise RegistryPublishError("Registry version must not be empty")
    if version in {".", ".."}:
        raise RegistryPublishError(f"Registry version must be a safe basename: {version!r}")
    if "/" in version or "\\" in version:
        raise RegistryPublishError(f"Registry version must not contain path separators: {version!r}")
    if Path(version).is_absolute() or Path(version).name != version:
        raise RegistryPublishError(f"Registry version must be a safe basename: {version!r}")
    return version


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_model_net(path: Path) -> dict[str, Any]:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise RegistryPublishError(f"Cannot load model registry {path}: {exc}") from exc

    if not isinstance(raw, dict):
        raise RegistryPublishError("registry source top-level value must be a mapping")
    models = raw.get("models")
    if not isinstance(models, list) or not models:
        raise RegistryPublishError("registry source must contain a non-empty models list")

    seen_ids: set[str] = set()
    for index, model in enumerate(models):
        if not isinstance(model, dict):
            raise RegistryPublishError(f"models[{index}] must be a mapping")
        model_id = str(model.get("id") or "").strip()
        backend = str(model.get("backend") or "").strip()
        if not model_id:
            raise RegistryPublishError(f"models[{index}] missing required id")
        if not backend:
            raise RegistryPublishError(f"models[{index}] missing required backend")
        if model_id in seen_ids:
            raise RegistryPublishError(f"duplicate model id: {model_id}")
        seen_ids.add(model_id)
    return raw


def scalar_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value else []
    if isinstance(value, list):
        return [str(item) for item in value if item is not None and str(item)]
    return [str(value)] if str(value) else []


def normalize_term(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value).strip().lower()).strip("_")


def registry_terms(model: dict[str, Any]) -> set[str]:
    terms: set[str] = set()
    for key in TERM_KEYS:
        for item in scalar_list(model.get(key)):
            for part in re.split(r"[,;\s]+", item):
                term = normalize_term(part)
                if term:
                    terms.add(term)
    return terms


def model_haystack(model: dict[str, Any]) -> str:
    fields = (
        "backend",
        "capability",
        "capabilities",
        "id",
        "model_capabilities",
        "model_name",
        "model_url",
        "supported_capabilities",
        "supported_tasks",
        "tags",
        "task",
        "tasks",
        "type",
    )
    values: list[str] = []
    for field in fields:
        value = model.get(field)
        if isinstance(value, list):
            values.extend(str(item) for item in value if item is not None)
        elif value is not None:
            values.append(str(value))
    return normalize_term(" ".join(values))


def contains_any(haystack: str, markers: set[str]) -> bool:
    return any(marker in haystack for marker in markers)


def infer_capability_ids(model: dict[str, Any]) -> set[str]:
    terms = registry_terms(model)
    haystack = model_haystack(model)
    backend = str(model.get("backend") or "").strip()
    capabilities: set[str] = set()

    is_embedding = bool(terms & EMBEDDING_TERMS) or contains_any(haystack, EMBEDDING_TERMS)
    is_non_chat = bool(terms & NON_CHAT_TERMS) or contains_any(haystack, NON_CHAT_TERMS)
    is_transcription = bool(terms & TRANSCRIPTION_TERMS) or contains_any(
        haystack,
        TRANSCRIPTION_TERMS | {"whisper"},
    )
    is_image_generation = bool(terms & IMAGE_GENERATION_TERMS) or contains_any(
        haystack,
        IMAGE_GENERATION_TERMS | {"sd35", "sdxl", "stable_diffusion"},
    )

    if is_embedding:
        capabilities.add("rag.embed")
    if is_transcription:
        capabilities.add("audio.transcribe")
    if is_image_generation:
        capabilities.add("image.generate")
    if terms & CODE_TERMS:
        capabilities.add("code.modify")

    explicit_chat = bool(terms & CHAT_TERMS)
    explicit_non_chat = is_non_chat or is_transcription or is_image_generation
    if explicit_chat or (backend in CHAT_BACKENDS and not explicit_non_chat):
        capabilities.add("chat.general")

    return capabilities


def infer_runtime(model: dict[str, Any]) -> str:
    runtime = str(model.get("runtime") or "").strip()
    if runtime:
        return runtime
    backend = str(model.get("backend") or "").strip()
    return RUNTIME_BY_BACKEND.get(backend, "unknown")


def candidate_metadata_value(model: dict[str, Any], key: str) -> str:
    value = str(model.get(key) or "").strip()
    return value or "unknown"


def render_capability_candidate(model: dict[str, Any]) -> dict[str, Any]:
    return {
        "model": str(model.get("id") or "").strip(),
        "runtime": infer_runtime(model),
        "resource_class": candidate_metadata_value(model, "resource_class"),
        "quality": candidate_metadata_value(model, "quality"),
        "cost_weight": candidate_metadata_value(model, "cost_weight"),
    }


def render_runtime_models(model_net: dict[str, Any]) -> list[dict[str, Any]]:
    models: list[dict[str, Any]] = []
    for model in model_net.get("models", []):
        if not isinstance(model, dict):
            continue
        model_id = str(model.get("id") or "").strip()
        if not model_id:
            continue
        entry = dict(model)
        entry["id"] = model_id
        if "runtime" not in entry:
            entry["runtime"] = infer_runtime(model)
        models.append(entry)
    return sorted(models, key=lambda item: str(item.get("id") or ""))


def render_capability_registry(
    model_net: dict[str, Any],
    *,
    generated_at: str,
    version: str,
    source: str = "capability-registry.yaml",
) -> str:
    capability_candidates: dict[str, dict[str, dict[str, Any]]] = {}
    for model in model_net.get("models", []):
        if not isinstance(model, dict):
            continue
        model_id = str(model.get("id") or "").strip()
        if not model_id:
            continue
        candidate = render_capability_candidate(model)
        for capability_id in infer_capability_ids(model):
            capability_candidates.setdefault(capability_id, {})[model_id] = candidate

    capabilities: dict[str, dict[str, Any]] = {}
    for capability_id in sorted(capability_candidates):
        candidates = [
            capability_candidates[capability_id][model_id]
            for model_id in sorted(capability_candidates[capability_id])
        ]
        if candidates:
            capabilities[capability_id] = {
                **CAPABILITY_SPECS[capability_id],
                "candidates": candidates,
            }

    return yaml.safe_dump(
        {
            "schema_version": "modelnet.capabilities.v1",
            "version": version,
            "generated_at": generated_at,
            "source": source,
            "capabilities": capabilities,
            "models": render_runtime_models(model_net),
        },
        allow_unicode=True,
        sort_keys=False,
    )


def render_litellm_config(source: Path, output: Path) -> list[str]:
    models = sync_modelnet_litellm.load_registry(source)
    config, model_names = sync_modelnet_litellm.build_config(models)
    if len(model_names) <= 2:
        raise RegistryPublishError(f"No concrete backend chat models generated from {source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(config, encoding="utf-8")
    validate_litellm_config(output)
    return model_names


def validate_litellm_config(path: Path) -> None:
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise RegistryPublishError(f"Cannot load LiteLLM config {path}: {exc}") from exc
    if not isinstance(raw, dict):
        raise RegistryPublishError("LiteLLM config top-level value must be a mapping")
    model_list = raw.get("model_list")
    if not isinstance(model_list, list):
        raise RegistryPublishError("LiteLLM config must contain model_list")
    names = {item.get("model_name") for item in model_list if isinstance(item, dict)}
    missing = {"modelnet", "modelnet-auto"} - names
    if missing:
        raise RegistryPublishError(f"LiteLLM config missing required entries: {sorted(missing)}")
    concrete = names - {"modelnet", "modelnet-auto"}
    if not concrete:
        raise RegistryPublishError("LiteLLM config must include at least one concrete backend model")


def write_checksums(bundle_dir: Path) -> dict[str, str]:
    checksums = {relative: sha256_file(bundle_dir / relative) for relative in CHECKSUM_FILES}
    lines = [f"{digest}  {relative}" for relative, digest in checksums.items()]
    (bundle_dir / "checksums.sha256").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return checksums


def build_bundle(source: Path, build_dir: Path, *, version: str, generated_at: str) -> dict[str, str]:
    build_dir.mkdir(parents=True, exist_ok=False)
    model_net = load_model_net(source)

    capability_text = render_capability_registry(
        model_net,
        generated_at=generated_at,
        version=version,
        source=source.name,
    )
    capability_registry_target = build_dir / "capability-registry.yaml"
    capability_registry_target.write_text(capability_text, encoding="utf-8")
    render_litellm_config(capability_registry_target, build_dir / "litellm" / "modelnet-config.yaml")

    version_payload = {
        "version": version,
        "generated_at": generated_at,
        "publisher": "scripts/publish_modelnet_registry.py",
        "source": str(source),
        "source_sha256": sha256_file(source),
    }
    (build_dir / "version.json").write_text(
        json.dumps(version_payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    checksums = write_checksums(build_dir)
    return checksums


def publish_registry(
    source: Path = DEFAULT_SOURCE,
    root: Path = DEFAULT_ROOT,
    *,
    version: str | None = None,
    dry_run: bool = False,
) -> PublishResult:
    source = source.expanduser().resolve()
    if not source.exists():
        raise RegistryPublishError(f"Source registry does not exist: {source}")
    version = safe_version(utc_version() if version is None else version)
    generated_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    if dry_run:
        dry_run_root = Path(tempfile.mkdtemp(prefix=f"modelnet-registry-{version}-", dir="/tmp"))
        bundle_dir = dry_run_root / "bundle"
        checksums = build_bundle(source, bundle_dir, version=version, generated_at=generated_at)
        return PublishResult(
            version=version,
            bundle_dir=bundle_dir,
            current_link=None,
            dry_run=True,
            checksums=checksums,
        )

    root = root.expanduser()
    current = root / "current"
    if current.exists() and not current.is_symlink():
        raise RegistryPublishError(f"Refusing to replace non-symlink current path: {current}")

    build_dir = root / ".build" / version
    bundle_dir = root / "versions" / version
    if build_dir.exists() or bundle_dir.exists():
        raise RegistryPublishError(f"Registry version already exists: {version}")

    checksums = build_bundle(source, build_dir, version=version, generated_at=generated_at)

    versions_dir = root / "versions"
    versions_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(build_dir), str(bundle_dir))

    tmp_link = root / f".current.{version}.{os.getpid()}"
    if tmp_link.exists() or tmp_link.is_symlink():
        tmp_link.unlink()
    tmp_link.symlink_to(Path("versions") / version)
    os.replace(tmp_link, current)

    return PublishResult(
        version=version,
        bundle_dir=bundle_dir,
        current_link=current,
        dry_run=False,
        checksums=checksums,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--version")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true", help="Print result as JSON.")
    args = parser.parse_args()

    try:
        result = publish_registry(
            source=args.source,
            root=args.root,
            version=args.version,
            dry_run=args.dry_run,
        )
    except RegistryPublishError as exc:
        raise SystemExit(str(exc)) from exc

    payload = {
        "version": result.version,
        "bundle_dir": str(result.bundle_dir),
        "current_link": str(result.current_link) if result.current_link else None,
        "dry_run": result.dry_run,
        "checksums": result.checksums,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        action = "validated dry-run bundle" if result.dry_run else "published registry version"
        print(f"{action}: {result.version}")
        print(f"bundle: {result.bundle_dir}")
        if result.current_link:
            print(f"current: {result.current_link}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
