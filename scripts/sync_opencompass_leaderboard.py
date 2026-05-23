#!/usr/bin/env python3
"""Build the public ModelNet ToC leaderboard data from OpenCompass."""

from __future__ import annotations

import argparse
import gzip
import json
import math
import re
import sys
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


DEFAULT_SOURCE = Path("/home/duxianghe/dify/api/configs/model_net.yaml")
DEFAULT_OUTPUT = Path("leaderboard/public/leaderboard/data/opencompass-leaderboard.json")
CHAT_BACKENDS = {"vllm_chat", "llama_cpp"}

OPENCOMPASS_MONTHS_URL = (
    "https://rank.opencompass.org.cn/gw/opencompass-be/api/v1/rank/listRankTableAvailableMonths"
)
OPENCOMPASS_CDN_BASE_URL = "https://cdn.opencompass.org.cn/"
OPENCOMPASS_LEADERBOARD_URL = "https://rank.opencompass.org.cn/leaderboard-llm"
OPENCOMPASS_CAPABILITY_DOC_URL = (
    "https://opencompass.readthedocs.io/zh-cn/latest/advanced_guides/compassbench_intro.html"
)
OPENCOMPASS_ACADEMIC_META_URL = (
    "http://opencompass.oss-cn-shanghai.aliyuncs.com/dev-assets/hf-research/model-meta-info.json"
)
OPENCOMPASS_ACADEMIC_DATA_URL = (
    "http://opencompass.oss-cn-shanghai.aliyuncs.com/dev-assets/hf-research/hf-academic.json"
)
OPENCOMPASS_SCORE_KEYS = ("Average", "Language", "Knowledge", "Reasoning", "Math", "Code", "Agent")
OPENCOMPASS_METADATA_KEYS = {"model", "org", "num", "time", "update_time", "chat_or_base"}
OPENCOMPASS_DIMENSION_KEYS = ("Language", "Knowledge", "Reason", "Math", "Code", "Agent")
OPENCOMPASS_ACADEMIC_METADATA_KEYS = {"dataset", "version", "metric", "mode"}
OPENCOMPASS_ACADEMIC_DIMENSION_BY_DATASET = {
    "IFEval": ("Instruction", {"zh-CN": "Instruction", "en-US": "Instruction"}),
    "BBH": ("Reasoning", {"zh-CN": "Reasoning", "en-US": "Reasoning"}),
    "GPQA_diamond": ("Knowledge", {"zh-CN": "Knowledge", "en-US": "Knowledge"}),
    "Math-500": ("Math", {"zh-CN": "Math", "en-US": "Math"}),
    "AIME2024": ("Math", {"zh-CN": "Math", "en-US": "Math"}),
    "MMLU-Pro": ("Knowledge", {"zh-CN": "Knowledge", "en-US": "Knowledge"}),
    "LiveCodeBench": ("Code", {"zh-CN": "Code", "en-US": "Code"}),
    "HumanEval": ("Code", {"zh-CN": "Code", "en-US": "Code"}),
    "Drop": ("Language", {"zh-CN": "Language", "en-US": "Language"}),
    "Hellaswag": ("Reasoning", {"zh-CN": "Reasoning", "en-US": "Reasoning"}),
    "MUSR": ("Reasoning", {"zh-CN": "Reasoning", "en-US": "Reasoning"}),
    "KorBench": ("Reasoning", {"zh-CN": "Reasoning", "en-US": "Reasoning"}),
    "CMMLU": ("Knowledge", {"zh-CN": "Knowledge", "en-US": "Knowledge"}),
    "MMLU": ("Knowledge", {"zh-CN": "Knowledge", "en-US": "Knowledge"}),
    "BigCodeBench": ("Code", {"zh-CN": "Code", "en-US": "Code"}),
}


def now() -> str:
    return datetime.now(UTC).isoformat()


def parse_scalar(value: str) -> Any:
    value = value.strip()
    if value == "":
        return ""
    if (value.startswith("'") and value.endswith("'")) or (value.startswith('"') and value.endswith('"')):
        return value[1:-1]
    try:
        return int(value)
    except ValueError:
        return value


def load_registry(path: Path) -> list[dict[str, Any]]:
    models: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    in_models = False

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        stripped = raw_line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped == "models:":
            in_models = True
            continue
        if not in_models:
            continue
        if stripped.startswith("- "):
            if current:
                models.append(current)
            current = {}
            remainder = stripped[2:].strip()
            if remainder and ":" in remainder:
                key, _, value = remainder.partition(":")
                current[key.strip()] = parse_scalar(value)
            continue
        if current is not None and ":" in stripped:
            key, _, value = stripped.partition(":")
            current[key.strip()] = parse_scalar(value)

    if current:
        models.append(current)
    return models


def is_embedding_model(model: dict[str, Any]) -> bool:
    haystack = " ".join(str(model.get(key, "")) for key in ("id", "model_name", "model_url", "type")).lower()
    return "embedding" in haystack or "embed" in haystack


def chat_models(models: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for model in models:
        if str(model.get("backend", "")) not in CHAT_BACKENDS:
            continue
        if is_embedding_model(model):
            continue
        if str(model.get("id", "")).strip():
            out.append(model)
    return out


def fetch_json(url: str, *, timeout: int, method: str = "GET", data: dict[str, Any] | None = None) -> Any:
    body = None
    headers = {
        "Accept": "application/json,text/plain,*/*",
        "User-Agent": "ModelNet-ToC-Leaderboard/1.0",
        "Client-Type": "app",
        "client-type": "app",
        "type": "0",
        "lang": "en-US",
        "Referer": OPENCOMPASS_LEADERBOARD_URL,
    }
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
            if raw.startswith(b"\x1f\x8b"):
                raw = gzip.decompress(raw)
            return json.loads(raw.decode("utf-8"))
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"{url} returned HTTP {exc.code}: {detail}") from exc
    except (URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{url} fetch failed: {exc}") from exc


def float_value(value: object) -> float | None:
    try:
        number = float(str(value).replace("%", ""))
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def score_value(value: object) -> float | None:
    number = float_value(value)
    if number is None:
        return None
    return round(number, 3)


def compact_strings(*values: object) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value or "").strip()
        if not text or text in seen:
            continue
        out.append(text)
        seen.add(text)
    return out


def localized_label(value: object) -> dict[str, str] | str:
    if isinstance(value, dict):
        out = {str(key): str(item) for key, item in value.items() if item not in (None, "")}
        return out or ""
    return str(value or "")


def link_from_pair(value: object) -> dict[str, str] | None:
    if isinstance(value, dict):
        url = str(value.get("url") or value.get("href") or "").strip()
        label = str(value.get("label") or value.get("name") or url).strip()
        return {"label": label or url, "url": url} if url else None
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        label = str(value[0] or "").strip()
        url = str(value[1] or "").strip()
        return {"label": label or url, "url": url} if url else None
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        return {"label": value.rstrip("/").rsplit("/", 1)[-1], "url": value}
    return None


def date_sort_tuple(*values: object) -> tuple[int, int, int]:
    best = (0, 0, 0)
    for value in values:
        parts = [int(part) for part in re.findall(r"\d+", str(value or ""))]
        if len(parts) >= 3:
            current = (parts[0], parts[1], parts[2])
        elif len(parts) >= 2 and 0 < parts[0] < 100:
            current = (2000 + parts[0], parts[1], 0)
        elif len(parts) >= 2:
            current = (parts[0], parts[1], 0)
        else:
            current = (0, 0, 0)
        if current > best:
            best = current
    return best


def mean_score(values: list[object]) -> float | None:
    numbers = [float_value(value) for value in values]
    clean = [value for value in numbers if value is not None]
    if not clean:
        return None
    return round(sum(clean) / len(clean), 3)


def capability_item_sort_key(item: dict[str, Any]) -> tuple[tuple[int, int, int], float, int]:
    source = item.get("source") if isinstance(item.get("source"), dict) else {}
    rank = item.get("rank")
    rank_value = rank if isinstance(rank, int) else 100000
    average = next((score.get("value") for score in item.get("scores", []) if score.get("key") == "Average"), None)
    return (
        date_sort_tuple(item.get("update_time"), source.get("update_time"), source.get("month")),
        float_value(average) or -1,
        -rank_value,
    )


def rows_by_model(rows: object) -> dict[str, dict[str, Any]]:
    if not isinstance(rows, list):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        if isinstance(row, dict):
            model = str(row.get("model") or "").strip()
            if model:
                out[model] = row
    return out


def column_labels(column_payload: dict[str, Any], column_name: str) -> dict[str, dict[str, str] | str]:
    config = column_payload.get(column_name)
    columns = config.get("columns") if isinstance(config, dict) else []
    if not isinstance(columns, list):
        return {}
    out: dict[str, dict[str, str] | str] = {}
    for column in columns:
        if not isinstance(column, dict):
            continue
        key = str(column.get("key") or "")
        label = localized_label(column.get("title"))
        if key and label:
            out[key] = label
    return out


def opencompass_model_metadata(data_payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    models = data_payload.get("models")
    if not isinstance(models, dict):
        return {}
    return {str(model): metadata for model, metadata in models.items() if isinstance(metadata, dict)}


def opencompass_source(month: dict[str, Any]) -> dict[str, Any]:
    data_path = str(month.get("fileName") or "")
    column_path = str(month.get("columnFileName") or "")
    return {
        "name": "OpenCompass CompassBench LLM Leaderboard",
        "url": OPENCOMPASS_LEADERBOARD_URL,
        "capability_doc_url": OPENCOMPASS_CAPABILITY_DOC_URL,
        "month": month.get("month"),
        "update_time": month.get("updateTime"),
        "data_url": urljoin(OPENCOMPASS_CDN_BASE_URL, data_path),
        "column_url": urljoin(OPENCOMPASS_CDN_BASE_URL, column_path),
    }


def normalize_opencompass_capabilities(
    data_payload: dict[str, Any],
    column_payload: dict[str, Any],
    *,
    source: dict[str, Any],
) -> list[dict[str, Any]]:
    overall_rows = rows_by_model(data_payload.get("OverallTable"))
    metadata_by_model = opencompass_model_metadata(data_payload)
    overall_labels = column_labels(column_payload, "OverallColumn")
    tabs = column_payload.get("TabConfig")
    tab_by_key = {
        str(tab.get("key") or tab.get("index")): tab
        for tab in tabs
        if isinstance(tab, dict)
    } if isinstance(tabs, list) else {}
    table_rows_by_dimension = {
        dimension: rows_by_model(data_payload.get(f"{dimension}Table"))
        for dimension in OPENCOMPASS_DIMENSION_KEYS
    }
    labels_by_dimension = {
        dimension: column_labels(column_payload, f"{dimension}Column")
        for dimension in OPENCOMPASS_DIMENSION_KEYS
    }

    items: list[dict[str, Any]] = []
    for model_name, overall_row in overall_rows.items():
        metadata = metadata_by_model.get(model_name, {})
        scores = [
            {
                "key": key,
                "label": overall_labels.get(key, key),
                "value": score_value(overall_row.get(key)),
            }
            for key in OPENCOMPASS_SCORE_KEYS
            if score_value(overall_row.get(key)) is not None
        ]
        dimensions = []
        for dimension in OPENCOMPASS_DIMENSION_KEYS:
            row = table_rows_by_dimension.get(dimension, {}).get(model_name)
            if not row:
                continue
            labels = labels_by_dimension.get(dimension, {})
            tab = tab_by_key.get(dimension, {})
            dimension_scores = [
                {
                    "key": key,
                    "label": labels.get(key, key),
                    "value": score_value(value),
                }
                for key, value in row.items()
                if key not in OPENCOMPASS_METADATA_KEYS and key != "Average" and score_value(value) is not None
            ]
            dimensions.append(
                {
                    "key": dimension,
                    "label": localized_label(tab.get("name")) if isinstance(tab, dict) else labels.get("Average", dimension),
                    "average": score_value(row.get("Average")),
                    "scores": dimension_scores,
                }
            )

        links = {
            key: link
            for key, link in {
                "weight": link_from_pair(metadata.get("weight")),
                "website": link_from_pair(metadata.get("website-github")),
                "article": link_from_pair(metadata.get("article")),
            }.items()
            if link
        }
        items.append(
            {
                "model": model_name,
                "aliases": compact_strings(
                    model_name,
                    metadata.get("origin_name"),
                    metadata.get("display_name"),
                    (links.get("weight") or {}).get("label"),
                ),
                "org": overall_row.get("org") or metadata.get("org"),
                "num": overall_row.get("num") or metadata.get("num"),
                "time": overall_row.get("time") or metadata.get("time"),
                "update_time": overall_row.get("update_time") or metadata.get("update_time") or source.get("update_time"),
                "chat_or_base": overall_row.get("chat_or_base") or metadata.get("chat_or_base"),
                "rank": metadata.get("rank"),
                "release": metadata.get("release"),
                "description": localized_label(metadata.get("desc")),
                "scores": scores,
                "dimensions": dimensions,
                "links": links,
                "source": source,
            }
        )

    return sorted(items, key=capability_item_sort_key, reverse=True)


def normalize_opencompass_academic_capabilities(
    metadata_payload: list[Any],
    scores_payload: dict[str, Any],
    *,
    source: dict[str, Any],
) -> list[dict[str, Any]]:
    scores_by_model: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for dataset_key, dataset_payload in scores_payload.items():
        if not isinstance(dataset_payload, dict):
            continue
        dimension_key, dimension_label = OPENCOMPASS_ACADEMIC_DIMENSION_BY_DATASET.get(
            str(dataset_key),
            ("Academic", {"zh-CN": "Academic", "en-US": "Academic"}),
        )
        metric = str(dataset_payload.get("metric") or "").strip()
        for model_key, value in dataset_payload.items():
            if model_key in OPENCOMPASS_ACADEMIC_METADATA_KEYS:
                continue
            score = score_value(value)
            if score is None:
                continue
            scores_by_model[str(model_key)].append(
                {
                    "dimension_key": dimension_key,
                    "dimension_label": dimension_label,
                    "score": {
                        "key": str(dataset_key),
                        "label": str(dataset_key) if not metric else f"{dataset_key} ({metric})",
                        "value": score,
                    },
                }
            )

    items: list[dict[str, Any]] = []
    for metadata in metadata_payload:
        if not isinstance(metadata, dict):
            continue
        abbr = str(metadata.get("abbr") or "").strip()
        if not abbr or abbr not in scores_by_model:
            continue

        grouped_scores: dict[str, dict[str, Any]] = {}
        for score_entry in scores_by_model[abbr]:
            dimension_key = str(score_entry["dimension_key"])
            dimension = grouped_scores.setdefault(
                dimension_key,
                {"key": dimension_key, "label": score_entry["dimension_label"], "scores": []},
            )
            dimension["scores"].append(score_entry["score"])

        dimensions = []
        all_values: list[object] = []
        for dimension in grouped_scores.values():
            values = [score.get("value") for score in dimension["scores"] if isinstance(score, dict)]
            all_values.extend(values)
            dimensions.append(
                {
                    "key": dimension["key"],
                    "label": dimension["label"],
                    "average": mean_score(values),
                    "scores": dimension["scores"],
                }
            )
        dimensions.sort(key=lambda item: str(item.get("key")))

        links = {
            key: {"label": str(label), "url": str(url)}
            for key, label, url in (
                ("weight", metadata.get("model_weight_name"), metadata.get("model_weight_url")),
                ("website", metadata.get("website_name"), metadata.get("website_url")),
                ("article", metadata.get("report_name"), metadata.get("report_url")),
            )
            if isinstance(url, str) and url.strip()
        }
        display_name = str(metadata.get("display_name") or metadata.get("origin_name") or abbr)
        items.append(
            {
                "model": display_name,
                "aliases": compact_strings(
                    display_name,
                    metadata.get("origin_name"),
                    metadata.get("model_weight_name"),
                    metadata.get("abbr"),
                ),
                "org": metadata.get("org"),
                "num": metadata.get("num_param"),
                "time": metadata.get("release_time"),
                "update_time": metadata.get("update_time") or source.get("update_time"),
                "chat_or_base": metadata.get("model_type"),
                "release": metadata.get("release_type"),
                "description": {
                    key: value
                    for key, value in {
                        "zh-CN": metadata.get("intro_cn"),
                        "en-US": metadata.get("intro_en"),
                    }.items()
                    if isinstance(value, str) and value.strip()
                },
                "scores": [{"key": "Average", "label": "Academic average", "value": mean_score(all_values)}],
                "dimensions": dimensions,
                "links": links,
                "source": source,
            }
        )

    return sorted(items, key=capability_item_sort_key, reverse=True)


def fetch_compassbench(timeout: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, str]]]:
    months_payload = fetch_json(
        OPENCOMPASS_MONTHS_URL,
        timeout=timeout,
        method="POST",
        data={"rankingType": 0, "benchmarkType": 1},
    )
    months = months_payload.get("data") if isinstance(months_payload, dict) else None
    if not isinstance(months, list) or not months:
        raise RuntimeError("OpenCompass did not return available leaderboard months")

    errors: list[dict[str, str]] = []
    valid_months = [
        month
        for month in months
        if isinstance(month, dict) and month.get("fileName")
    ]
    if not valid_months:
        raise RuntimeError("OpenCompass did not return usable leaderboard months")

    for month in sorted(
        valid_months,
        key=lambda item: date_sort_tuple(item.get("updateTime"), item.get("month")),
        reverse=True,
    ):
        source = opencompass_source(month)
        try:
            data_payload = fetch_json(str(source["data_url"]), timeout=timeout)
            column_payload = fetch_json(str(source["column_url"]), timeout=timeout)
            if not isinstance(data_payload, dict) or not isinstance(column_payload, dict):
                raise RuntimeError("OpenCompass returned invalid leaderboard payloads")
            items = normalize_opencompass_capabilities(data_payload, column_payload, source=source)
            if not items:
                raise RuntimeError("OpenCompass returned an empty leaderboard payload")
            return items, [source], errors
        except Exception as exc:
            errors.append({"source": "opencompass_compassbench", "month": str(month.get("month")), "error": str(exc)})
    return [], [], errors


def fetch_academic(timeout: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, str]]]:
    source: dict[str, Any] = {
        "name": "OpenCompass CompassAcademic Leaderboard",
        "url": OPENCOMPASS_LEADERBOARD_URL,
        "capability_doc_url": OPENCOMPASS_CAPABILITY_DOC_URL,
        "data_url": OPENCOMPASS_ACADEMIC_DATA_URL,
        "metadata_url": OPENCOMPASS_ACADEMIC_META_URL,
    }
    try:
        metadata_payload = fetch_json(OPENCOMPASS_ACADEMIC_META_URL, timeout=timeout)
        scores_payload = fetch_json(OPENCOMPASS_ACADEMIC_DATA_URL, timeout=timeout)
        if not isinstance(metadata_payload, list) or not isinstance(scores_payload, dict):
            raise RuntimeError("OpenCompass returned invalid academic payloads")
        update_times = [
            str(item.get("update_time"))
            for item in metadata_payload
            if isinstance(item, dict) and item.get("update_time")
        ]
        if update_times:
            source["update_time"] = max(update_times, key=lambda value: date_sort_tuple(value))
        return normalize_opencompass_academic_capabilities(metadata_payload, scores_payload, source=source), [source], []
    except Exception as exc:
        return [], [], [{"source": "opencompass_academic", "error": str(exc)}]


def normalize_model_key(value: object) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"\((high|medium|low)\)", "", text)
    text = re.sub(r"\.(gguf|safetensors|bin)$", "", text)
    text = re.sub(r"qwen(\d)(\d)\b", r"qwen\1.\2", text)
    text = re.sub(r"gemma(\d)\b", r"gemma-\1", text)
    text = re.sub(r"glm(\d)\b", r"glm-\1", text)
    text = re.sub(r"llama(\d)(\d)\b", r"llama-\1.\2", text)
    text = re.sub(r"[_\s.]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    removable_suffixes = {
        "ud", "unsloth", "bnb", "4bit", "awq", "gptq", "int4", "autoround", "mxfp4",
        "bf16", "f16", "f32", "q4", "q4-k", "q4-k-m", "q4km", "q5", "q5-k", "q5-k-m",
        "q5km", "q6", "q6-k", "q6-k-xl", "q6kxl", "q8", "q8-0", "q80", "q8-k",
        "q8-k-xl", "q8kxl",
    }
    changed = True
    while changed:
        changed = False
        for suffix in removable_suffixes:
            if text != suffix and text.endswith(f"-{suffix}"):
                text = text[: -len(suffix) - 1]
                changed = True
    return re.sub(r"[\s_-]+", "", text)


def model_keys(value: object) -> set[str]:
    text = str(value or "").strip()
    if not text:
        return set()
    tail = text.split("/")[-1]
    parsed_path = urlparse(text).path.strip("/")
    parsed_tail = parsed_path.split("/")[-1] if parsed_path else ""
    candidates = {
        text,
        tail,
        re.sub(r"\.(gguf|safetensors|bin)$", "", tail, flags=re.IGNORECASE),
        parsed_tail,
        re.sub(r"\.(gguf|safetensors|bin)$", "", parsed_tail, flags=re.IGNORECASE),
    }
    return {normalize_model_key(candidate) for candidate in candidates if normalize_model_key(candidate)}


def modelnet_index(models: list[dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
    index: dict[str, list[dict[str, str]]] = defaultdict(list)
    for model in models:
        entry = {
            "id": str(model.get("id") or "").strip(),
            "model_name": str(model.get("model_name") or "").strip(),
            "backend": str(model.get("backend") or "").strip(),
        }
        candidates = [model.get("id"), model.get("model_name"), model.get("model_url")]
        for key in set().union(*(model_keys(candidate) for candidate in candidates)):
            index[key].append(entry)
    return index


def annotate_modelnet_matches(items: list[dict[str, Any]], models: list[dict[str, Any]]) -> dict[str, Any]:
    index = modelnet_index(models)
    matched_modelnet_ids: set[str] = set()
    for item in items:
        aliases = item.get("aliases") if isinstance(item.get("aliases"), list) else []
        item_keys = set().union(*(model_keys(value) for value in [item.get("model"), *aliases]))
        matches_by_id: dict[str, dict[str, str]] = {}
        for key in item_keys:
            for match in index.get(key, []):
                if match["id"]:
                    matches_by_id[match["id"]] = match
        matches = sorted(matches_by_id.values(), key=lambda value: value["id"])
        for match in matches:
            matched_modelnet_ids.add(match["id"])
        item["modelnet_matched"] = bool(matches)
        item["modelnet_ids"] = [match["id"] for match in matches]
        item["modelnet_model_names"] = [match["model_name"] for match in matches if match["model_name"]]
        item["modelnet_backends"] = sorted({match["backend"] for match in matches if match["backend"]})

    return {
        "chat_model_count": len(models),
        "matched_modelnet_count": len(matched_modelnet_ids),
        "unmatched_modelnet_count": max(len(models) - len(matched_modelnet_ids), 0),
    }


def build_payload(registry_path: Path, timeout: int) -> dict[str, Any]:
    modelnet_models = chat_models(load_registry(registry_path))
    items: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    try:
        bench_items, bench_sources, bench_errors = fetch_compassbench(timeout)
        items.extend(bench_items)
        sources.extend(bench_sources)
        errors.extend(bench_errors)
    except Exception as exc:
        errors.append({"source": "opencompass_compassbench", "error": str(exc)})

    academic_items, academic_sources, academic_errors = fetch_academic(timeout)
    items.extend(academic_items)
    sources.extend(academic_sources)
    errors.extend(academic_errors)

    if not items:
        raise RuntimeError("; ".join(error["error"] for error in errors) or "OpenCompass returned no data")

    source: dict[str, Any] = {
        "name": "OpenCompass public leaderboards",
        "status": "available",
        "url": OPENCOMPASS_LEADERBOARD_URL,
        "capability_doc_url": OPENCOMPASS_CAPABILITY_DOC_URL,
        "sources": sorted(sources, key=lambda item: date_sort_tuple(item.get("update_time"), item.get("month")), reverse=True),
    }
    if sources:
        latest_source = max(sources, key=lambda item: date_sort_tuple(item.get("update_time"), item.get("month")))
        source["update_time"] = latest_source.get("update_time")
        source["month"] = latest_source.get("month")

    items = sorted(items, key=capability_item_sort_key, reverse=True)
    modelnet_summary = annotate_modelnet_matches(items, modelnet_models)
    return {
        "generated_at": now(),
        "source": source,
        "items": items,
        "errors": errors,
        "modelnet_summary": modelnet_summary,
    }


def load_stale_payload(output: Path, error: Exception) -> dict[str, Any] | None:
    if not output.exists():
        return None
    try:
        payload = json.loads(output.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    errors = payload.setdefault("errors", [])
    if isinstance(errors, list):
        errors.append({"source": "opencompass_refresh", "error": str(error)})
    payload["cache_status"] = "stale_fallback"
    return payload


def write_payload(output: Path, payload: dict[str, Any]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--timeout", type=int, default=20)
    args = parser.parse_args()

    try:
        payload = build_payload(args.source, args.timeout)
    except Exception as exc:
        stale = load_stale_payload(args.output, exc)
        if stale is None:
            raise SystemExit(str(exc)) from exc
        payload = stale

    write_payload(args.output, payload)
    print(
        "Wrote "
        f"{args.output} with {len(payload.get('items', []))} OpenCompass entries "
        f"and {payload.get('modelnet_summary', {}).get('matched_modelnet_count', 0)} ModelNet matches"
    )
    if payload.get("errors"):
        print(f"Source errors: {len(payload['errors'])}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
