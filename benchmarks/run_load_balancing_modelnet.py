#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import csv
import datetime as dt
import hashlib
import json
import math
import os
import random
import statistics
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


MT_BENCH_URL = (
    "https://raw.githubusercontent.com/lm-sys/FastChat/main/"
    "fastchat/llm_judge/data/mt_bench/question.jsonl"
)
DEFAULT_ENDPOINT = "http://127.0.0.1:3092/v1/chat/completions"
DEFAULT_MODELS_ENDPOINT = "http://127.0.0.1:3092/v1/models"
FIXED_QWEN35B = "inference-qwen-qwen3-5-35b-a3b-gptq-int4"

SYSTEMS = {
    "modelnet_auto": {"model": "modelnet-auto", "runner_config": {"strategy": "role_graph"}},
    "adaptive_sparse_graph": {
        "model": "modelnet-auto",
        "runner_config": {"strategy": "adaptive_sparse_graph", "max_auto_sources": 2},
    },
    "single_best": {"model": "modelnet-auto", "runner_config": {"strategy": "single_best"}},
    "fixed_qwen35b": {"model": FIXED_QWEN35B, "runner_config": None},
    "parallel_consensus": {"model": "modelnet-auto", "runner_config": {"strategy": "parallel_consensus"}},
}


@dataclass(frozen=True)
class WorkItem:
    request_id: int
    scheduled_at_s: float
    question_id: int | None
    category: str
    prompt: str
    max_tokens: int
    input_tokens_hint: int | None
    output_tokens_hint: int | None
    trace_model: str
    session_id: str
    source: str


def utc8_now() -> str:
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds")


def json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, sort_keys=False)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json_dumps(record) + "\n")


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_manifest(output_dir: Path) -> None:
    rows = []
    for path in sorted(item for item in output_dir.iterdir() if item.is_file() and item.name != "MANIFEST.sha256"):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        rows.append(f"{digest}  {path.name}")
    (output_dir / "MANIFEST.sha256").write_text("\n".join(rows) + ("\n" if rows else ""), encoding="utf-8")


def ensure_mtbench(question_file: Path) -> None:
    if question_file.exists() and question_file.stat().st_size > 0:
        return
    question_file.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(MT_BENCH_URL, headers={"User-Agent": "modelnet-load-balance/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        question_file.write_bytes(response.read())


def http_json(
    url: str,
    payload: dict[str, Any] | None = None,
    *,
    timeout: int = 300,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    request_headers = {"User-Agent": "modelnet-load-balance/1.0", **(headers or {})}
    if payload is None:
        request = urllib.request.Request(url, headers=request_headers)
    else:
        request_headers.setdefault("Content-Type", "application/json")
        request = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=request_headers,
            method="POST",
        )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {body[:600]}") from exc


def available_model_ids(models_endpoint: str) -> list[str]:
    payload = http_json(models_endpoint, timeout=30)
    ids = [
        str(item.get("id"))
        for item in payload.get("data", [])
        if item.get("id") not in {"modelnet", "modelnet-auto"}
    ]
    if not ids:
        raise RuntimeError("No ModelNet backend models are available")
    return ids


def percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil((pct / 100.0) * len(ordered)) - 1))
    return ordered[index]


def gini(values: list[float]) -> float | None:
    filtered = [max(0.0, float(item)) for item in values]
    if not filtered or sum(filtered) <= 0:
        return None
    ordered = sorted(filtered)
    n = len(ordered)
    weighted = sum((index + 1) * value for index, value in enumerate(ordered))
    return (2 * weighted) / (n * sum(ordered)) - (n + 1) / n


def coefficient_of_variation(values: list[float]) -> float | None:
    filtered = [float(item) for item in values]
    if not filtered:
        return None
    mean = statistics.mean(filtered)
    if mean == 0:
        return None
    return statistics.pstdev(filtered) / mean


def jain_fairness(values: list[float]) -> float | None:
    filtered = [max(0.0, float(item)) for item in values]
    denom = len(filtered) * sum(value * value for value in filtered)
    if not filtered or denom == 0:
        return None
    return (sum(filtered) ** 2) / denom


def safe_float(value: Any, default: float | None = None) -> float | None:
    if value is None:
        return default
    text = str(value).strip()
    if not text:
        return default
    try:
        return float(text)
    except ValueError:
        return default


def safe_int(value: Any, default: int | None = None) -> int | None:
    number = safe_float(value, None)
    if number is None:
        return default
    return int(round(number))


def parse_seconds(value: Any, fallback: float) -> float:
    text = str(value or "").strip()
    if not text:
        return fallback
    number = safe_float(text, None)
    if number is not None:
        return number
    if ":" in text:
        parts = [safe_float(part, 0.0) or 0.0 for part in text.split(":")]
        total = 0.0
        for part in parts:
            total = total * 60.0 + part
        return total
    return fallback


def first_present(row: dict[str, Any], names: tuple[str, ...]) -> Any:
    lower_to_key = {key.lower(): key for key in row}
    for name in names:
        key = lower_to_key.get(name.lower())
        if key is not None and row.get(key) not in {None, ""}:
            return row[key]
    return None


def synthetic_prompt(input_tokens: int, request_id: int, *, prefix: str = "") -> str:
    target = max(8, input_tokens)
    words = [
        "This",
        "is",
        "a",
        "load",
        "balancing",
        "benchmark",
        "request",
        "for",
        "a",
        "multi",
        "model",
        "serving",
        "router.",
    ]
    generated = [f"tok{(request_id + index) % 997}" for index in range(max(0, target - len(words)))]
    body = " ".join(words + generated)
    if prefix:
        return f"{prefix}\n\n{body}"
    return body


def sample_positive_int(rng: random.Random, mean: int, stddev: int, minimum: int, maximum: int) -> int:
    if stddev <= 0:
        value = mean
    else:
        value = int(round(rng.gauss(mean, stddev)))
    return min(maximum, max(minimum, value))


def load_mtbench_prompts(question_file: Path) -> list[dict[str, Any]]:
    ensure_mtbench(question_file)
    questions = read_jsonl(question_file)
    prompts: list[dict[str, Any]] = []
    for question in questions:
        turns = question.get("turns") or []
        if not turns:
            continue
        prompts.append(
            {
                "question_id": int(question.get("question_id") or len(prompts)),
                "category": str(question.get("category") or ""),
                "prompt": str(turns[0]),
            }
        )
    if not prompts:
        raise RuntimeError(f"No usable MT-Bench prompts found in {question_file}")
    return prompts


def make_arrivals(args: argparse.Namespace, count: int) -> list[float]:
    if count <= 0:
        return []
    if args.request_rate <= 0:
        raise RuntimeError("--request-rate must be positive for synthetic and mtbench workloads")
    rng = random.Random(args.seed)
    mean_interval = 1.0 / args.request_rate
    arrivals = [0.0]
    current = 0.0
    for index in range(1, count):
        if args.arrival_mode == "constant":
            interval = mean_interval
        elif args.arrival_mode == "poisson":
            interval = rng.expovariate(args.request_rate)
        elif args.arrival_mode == "bursty":
            interval = mean_interval / max(1.0, args.burstiness)
            if index % max(1, args.burst_size) == 0:
                interval += mean_interval * max(0.0, args.burst_gap_multiplier)
        else:
            raise RuntimeError(f"Unsupported arrival mode: {args.arrival_mode}")
        current += max(0.0, interval)
        arrivals.append(current)
    return arrivals


def make_mtbench_workload(args: argparse.Namespace) -> list[WorkItem]:
    prompts = load_mtbench_prompts(Path(args.question_file))
    rng = random.Random(args.seed)
    arrivals = make_arrivals(args, args.num_requests)
    workload: list[WorkItem] = []
    for index, scheduled_at_s in enumerate(arrivals):
        prompt_row = prompts[index % len(prompts)]
        output_tokens = sample_positive_int(
            rng,
            args.synthetic_output_tokens,
            args.synthetic_output_tokens_stddev,
            1,
            args.max_tokens,
        )
        workload.append(
            WorkItem(
                request_id=index,
                scheduled_at_s=scheduled_at_s,
                question_id=int(prompt_row["question_id"]),
                category=str(prompt_row["category"]),
                prompt=str(prompt_row["prompt"]),
                max_tokens=output_tokens,
                input_tokens_hint=None,
                output_tokens_hint=output_tokens,
                trace_model="",
                session_id="",
                source="mtbench",
            )
        )
    return workload


def make_synthetic_workload(args: argparse.Namespace) -> list[WorkItem]:
    rng = random.Random(args.seed)
    arrivals = make_arrivals(args, args.num_requests)
    workload: list[WorkItem] = []
    for index, scheduled_at_s in enumerate(arrivals):
        input_tokens = sample_positive_int(
            rng,
            args.synthetic_input_tokens,
            args.synthetic_input_tokens_stddev,
            8,
            args.max_input_tokens,
        )
        output_tokens = sample_positive_int(
            rng,
            args.synthetic_output_tokens,
            args.synthetic_output_tokens_stddev,
            1,
            args.max_tokens,
        )
        workload.append(
            WorkItem(
                request_id=index,
                scheduled_at_s=scheduled_at_s,
                question_id=None,
                category="synthetic",
                prompt=synthetic_prompt(input_tokens, index),
                max_tokens=output_tokens,
                input_tokens_hint=input_tokens,
                output_tokens_hint=output_tokens,
                trace_model="",
                session_id="",
                source="synthetic",
            )
        )
    return workload


def read_trace_records(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".jsonl":
        return read_jsonl(path)
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def make_trace_workload(args: argparse.Namespace) -> list[WorkItem]:
    if not args.trace_file:
        raise RuntimeError("--trace-file is required when --workload-source trace")
    trace_path = Path(args.trace_file)
    records = read_trace_records(trace_path)
    if not records:
        raise RuntimeError(f"No trace records found in {trace_path}")

    workload: list[WorkItem] = []
    first_timestamp: float | None = None
    previous_timestamp = 0.0
    for raw_index, row in enumerate(records):
        if len(workload) >= args.num_requests:
            break
        timestamp_raw = first_present(row, ("Timestamp", "timestamp", "time", "arrival_time", "scheduled_at"))
        timestamp = parse_seconds(timestamp_raw, previous_timestamp)
        previous_timestamp = timestamp
        if first_timestamp is None:
            first_timestamp = timestamp
        scheduled_at_s = max(0.0, (timestamp - first_timestamp) * args.trace_time_scale)

        request_tokens = safe_int(
            first_present(row, ("Request tokens", "request_tokens", "input_length", "input_tokens", "prompt_tokens")),
            args.synthetic_input_tokens,
        )
        response_tokens = safe_int(
            first_present(row, ("Response tokens", "response_tokens", "output_length", "output_tokens", "completion_tokens")),
            args.synthetic_output_tokens,
        )
        request_tokens = min(max(8, request_tokens or args.synthetic_input_tokens), args.max_input_tokens)
        response_tokens = min(max(1, response_tokens or args.synthetic_output_tokens), args.max_tokens)

        prompt_text = first_present(row, ("text_input", "prompt", "input", "user_input", "question"))
        prompt = str(prompt_text) if prompt_text else synthetic_prompt(
            request_tokens,
            len(workload),
            prefix="Replay this trace-like request and answer concisely.",
        )
        model = str(first_present(row, ("Model", "model", "trace_model")) or "")
        session_id = str(first_present(row, ("Session ID", "session_id", "conversation_id")) or "")

        workload.append(
            WorkItem(
                request_id=len(workload),
                scheduled_at_s=scheduled_at_s,
                question_id=safe_int(first_present(row, ("question_id", "Question ID")), None),
                category=str(first_present(row, ("category", "Log Type", "log_type")) or "trace"),
                prompt=prompt,
                max_tokens=response_tokens,
                input_tokens_hint=request_tokens,
                output_tokens_hint=response_tokens,
                trace_model=model,
                session_id=session_id,
                source=f"trace:{trace_path.name}",
            )
        )
    if not workload:
        raise RuntimeError(f"No usable workload entries found in {trace_path}")
    return workload


def make_workload(args: argparse.Namespace) -> list[WorkItem]:
    if args.workload_source == "mtbench":
        return make_mtbench_workload(args)
    if args.workload_source == "synthetic":
        return make_synthetic_workload(args)
    if args.workload_source == "trace":
        return make_trace_workload(args)
    raise RuntimeError(f"Unsupported workload source: {args.workload_source}")


def metadata_summary(data: dict[str, Any]) -> dict[str, Any]:
    metadata = data.get("modelnet", {}).get("metadata", {})
    plan = metadata.get("auto_plan", {})
    selected_roles = plan.get("selected_roles", {}) if isinstance(plan, dict) else {}
    return {
        "model": data.get("model"),
        "usage": data.get("usage"),
        "internal_usage": metadata.get("internal_usage"),
        "internal_total_tokens": metadata.get("internal_total_tokens"),
        "internal_call_count": metadata.get("internal_call_count"),
        "stage_latencies_ms": metadata.get("stage_latencies_ms"),
        "call_ledger_summary": metadata.get("call_ledger_summary"),
        "runner": plan.get("runner") if isinstance(plan, dict) else None,
        "strategy": plan.get("strategy") if isinstance(plan, dict) else None,
        "source_count": plan.get("source_count") if isinstance(plan, dict) else None,
        "selected": [
            item.get("backend", {}).get("id")
            for item in plan.get("selected_sources", [])
            if isinstance(item, dict)
        ] if isinstance(plan, dict) else [],
        "roles": [
            item.get("role")
            for item in selected_roles.get("experts", [])
            if isinstance(item, dict)
        ],
        "critic": bool(selected_roles.get("critic")) if isinstance(selected_roles, dict) else False,
        "synthesizer": bool(selected_roles.get("synthesizer")) if isinstance(selected_roles, dict) else False,
    }


def usage_for_cost(metadata: dict[str, Any]) -> dict[str, Any]:
    internal_usage = metadata.get("internal_usage")
    if isinstance(internal_usage, dict):
        return internal_usage
    usage = metadata.get("usage")
    return usage if isinstance(usage, dict) else {}


def add_token_usage(totals: dict[str, int], usage: dict[str, Any]) -> None:
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        totals[key] += safe_int(usage.get(key), 0) or 0


def summarize_stage_distribution(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_stage: dict[str, dict[str, Any]] = {}
    for entry in entries:
        stage = str(entry.get("stage") or "unknown")
        bucket = by_stage.setdefault(
            stage,
            {
                "stage": stage,
                "count": 0,
                "latencies": [],
                "internal_usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                "backend_counts": {},
                "status_counts": {},
            },
        )
        bucket["count"] += 1
        latency = safe_float(entry.get("latency_ms"), None)
        if latency is not None:
            bucket["latencies"].append(latency)
        add_token_usage(bucket["internal_usage"], entry)
        backend = str(entry.get("backend_id") or "")
        if backend:
            bucket["backend_counts"][backend] = bucket["backend_counts"].get(backend, 0) + 1
        status = str(entry.get("status") or "unknown")
        bucket["status_counts"][status] = bucket["status_counts"].get(status, 0) + 1

    summary: list[dict[str, Any]] = []
    for stage, bucket in sorted(by_stage.items()):
        latencies = bucket.pop("latencies")
        bucket["latency_ms"] = {
            "p50": percentile(latencies, 50),
            "p95": percentile(latencies, 95),
            "max": max(latencies) if latencies else None,
            "mean": statistics.mean(latencies) if latencies else None,
        }
        summary.append(bucket)
    return summary


def summarize_observability(rows: list[dict[str, Any]]) -> dict[str, Any]:
    ok = [row for row in rows if row.get("status") == "ok"]
    total_internal_calls = 0
    total_internal_tokens = 0
    internal_usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    stage_entries: list[dict[str, Any]] = []
    missing = {
        "internal_total_tokens": 0,
        "internal_usage": 0,
        "call_ledger_summary": 0,
    }

    for row in ok:
        metadata = row.get("metadata") or {}
        call_count = safe_int(metadata.get("internal_call_count"), None)
        if call_count is not None:
            total_internal_calls += call_count

        internal_total_tokens = safe_int(metadata.get("internal_total_tokens"), None)
        if internal_total_tokens is None:
            missing["internal_total_tokens"] += 1
        else:
            total_internal_tokens += internal_total_tokens

        usage = metadata.get("internal_usage")
        if isinstance(usage, dict):
            add_token_usage(internal_usage, usage)
        else:
            missing["internal_usage"] += 1

        ledger = metadata.get("call_ledger_summary")
        if isinstance(ledger, list) and ledger:
            stage_entries.extend(entry for entry in ledger if isinstance(entry, dict))
        else:
            missing["call_ledger_summary"] += 1

    return {
        "ok": len(ok),
        "missing_metadata": missing,
        "internal_call_count": {
            "total": total_internal_calls,
            "mean_per_ok_request": (total_internal_calls / len(ok)) if ok else None,
        },
        "internal_total_tokens": {
            "total": total_internal_tokens,
            "mean_per_ok_request": (total_internal_tokens / len(ok)) if ok else None,
        },
        "internal_usage": internal_usage,
        "call_ledger_summary": summarize_stage_distribution(stage_entries),
    }


def build_modelnet_options(args: argparse.Namespace, runner_config: dict[str, Any]) -> dict[str, Any]:
    config = {
        "max_auto_sources": args.max_auto_sources,
        "expert_max_tokens": args.expert_max_tokens,
        "critic_max_tokens": args.critic_max_tokens,
        "aggregation_max_tokens": args.aggregation_max_tokens,
        **runner_config,
    }
    return {
        "candidate_aliases": args.candidate_aliases_resolved,
        "stream_options": {"include_trace": True},
        "collaboration_plan": {"runner_config": config},
    }


def call_chat(
    *,
    endpoint: str,
    model: str,
    messages: list[dict[str, str]],
    max_tokens: int,
    temperature: float,
    top_p: float,
    timeout: int,
    modelnet_options: dict[str, Any] | None,
) -> tuple[dict[str, Any], int]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "top_p": top_p,
    }
    if modelnet_options:
        payload["modelnet"] = modelnet_options
    started = time.perf_counter()
    data = http_json(endpoint, payload, timeout=timeout)
    return data, int((time.perf_counter() - started) * 1000)


def selected_backends(system: str, metadata: dict[str, Any]) -> list[str]:
    selected = [str(item) for item in metadata.get("selected", []) if item]
    if selected:
        return selected
    model = str(metadata.get("model") or "")
    if system == "fixed_qwen35b":
        return [FIXED_QWEN35B]
    if model and model not in {"modelnet", "modelnet-auto"}:
        return [model]
    return []


def execute_request(
    item: WorkItem,
    system: str,
    args: argparse.Namespace,
    bench_started: float,
) -> dict[str, Any]:
    spec = SYSTEMS[system]
    model = str(spec["model"])
    runner_config = spec["runner_config"]
    modelnet_options = (
        build_modelnet_options(args, runner_config)
        if isinstance(runner_config, dict)
        else None
    )

    started_at_s = time.perf_counter() - bench_started
    queue_delay_ms = max(0, int((started_at_s - item.scheduled_at_s) * 1000))
    status = "ok"
    error = None
    text = ""
    metadata: dict[str, Any] = {}
    latency_ms = 0
    try:
        last_error: Exception | None = None
        for attempt in range(args.retries + 1):
            try:
                data, latency_ms = call_chat(
                    endpoint=args.endpoint,
                    model=model,
                    messages=[{"role": "user", "content": item.prompt}],
                    max_tokens=item.max_tokens,
                    temperature=args.temperature,
                    top_p=args.top_p,
                    timeout=args.request_timeout,
                    modelnet_options=modelnet_options,
                )
                break
            except Exception as exc:  # noqa: BLE001 - preserve benchmark failure text.
                last_error = exc
                if attempt < args.retries:
                    time.sleep(1.5 * (attempt + 1))
        else:
            raise RuntimeError(str(last_error))
        text = str(data["choices"][0]["message"]["content"])
        metadata = metadata_summary(data)
    except Exception as exc:  # noqa: BLE001 - benchmark should record failures.
        status = "error"
        error = str(exc)[:1000]

    completed_at_s = time.perf_counter() - bench_started
    return {
        "schema_version": "modelnet.load_balance.answer.v1",
        "created_at": utc8_now(),
        "system": system,
        "status": status,
        "request_id": item.request_id,
        "scheduled_at_s": item.scheduled_at_s,
        "started_at_s": started_at_s,
        "completed_at_s": completed_at_s,
        "queue_delay_ms": queue_delay_ms,
        "latency_ms": latency_ms,
        "e2e_ms": int((completed_at_s - item.scheduled_at_s) * 1000),
        "question_id": item.question_id,
        "category": item.category,
        "workload_source": item.source,
        "trace_model": item.trace_model,
        "session_id": item.session_id,
        "input_tokens_hint": item.input_tokens_hint,
        "output_tokens_hint": item.output_tokens_hint,
        "max_tokens": item.max_tokens,
        "answer": text,
        "metadata": metadata,
        "selected_backends": selected_backends(system, metadata),
        "error": error,
    }


def run_system_workload(
    system: str,
    workload: list[WorkItem],
    args: argparse.Namespace,
    answer_file: Path,
) -> list[dict[str, Any]]:
    print(
        f"[load] system={system} requests={len(workload)} "
        f"max_client_concurrency={args.max_client_concurrency}",
        flush=True,
    )
    bench_started = time.perf_counter()
    futures: list[concurrent.futures.Future[dict[str, Any]]] = []
    results: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.max_client_concurrency)) as executor:
        for item in workload:
            due = bench_started + item.scheduled_at_s
            delay = due - time.perf_counter()
            if delay > 0:
                time.sleep(delay)
            futures.append(executor.submit(execute_request, item, system, args, bench_started))
        for future in concurrent.futures.as_completed(futures):
            record = future.result()
            append_jsonl(answer_file, record)
            results.append(record)
            print(
                f"[answer] system={system} request={record['request_id']} "
                f"status={record['status']} latency_ms={record['latency_ms']} "
                f"queue_delay_ms={record['queue_delay_ms']}",
                flush=True,
            )
    return sorted(results, key=lambda item: int(item["request_id"]))


def peak_in_flight(rows: list[dict[str, Any]]) -> int:
    events: list[tuple[float, int]] = []
    for row in rows:
        if row.get("status") != "ok":
            continue
        events.append((float(row.get("started_at_s") or 0), 1))
        events.append((float(row.get("completed_at_s") or 0), -1))
    current = 0
    peak = 0
    for _ts, delta in sorted(events, key=lambda item: (item[0], -item[1])):
        current += delta
        peak = max(peak, current)
    return peak


def summarize_backend_load(
    rows: list[dict[str, Any]],
    candidate_aliases: list[str],
) -> dict[str, Any]:
    request_counts = {alias: 0.0 for alias in candidate_aliases}
    token_counts = {alias: 0.0 for alias in candidate_aliases}
    for row in rows:
        if row.get("status") != "ok":
            continue
        metadata = row.get("metadata") or {}
        ledger = metadata.get("call_ledger_summary")
        if isinstance(ledger, list) and ledger:
            for entry in ledger:
                if not isinstance(entry, dict):
                    continue
                backend = str(entry.get("backend_id") or "")
                if not backend:
                    continue
                completion_tokens = safe_int(entry.get("completion_tokens"), 0) or 0
                request_counts.setdefault(backend, 0.0)
                token_counts.setdefault(backend, 0.0)
                request_counts[backend] += 1.0
                token_counts[backend] += completion_tokens
            continue
        backends = [str(item) for item in row.get("selected_backends", []) if item]
        if not backends:
            continue
        completion_tokens = safe_int(
            usage_for_cost(metadata).get("completion_tokens"),
            row.get("output_tokens_hint") or 0,
        ) or 0
        for backend in backends:
            request_counts.setdefault(backend, 0.0)
            token_counts.setdefault(backend, 0.0)
            request_counts[backend] += 1.0
            token_counts[backend] += completion_tokens / max(1, len(backends))

    used_counts = {key: value for key, value in request_counts.items() if value > 0}
    all_values = list(request_counts.values())
    total = sum(request_counts.values())
    max_share = (max(all_values) / total) if total > 0 and all_values else None
    return {
        "request_counts": dict(sorted(request_counts.items(), key=lambda item: (-item[1], item[0]))),
        "token_counts": dict(sorted(token_counts.items(), key=lambda item: (-item[1], item[0]))),
        "used_backend_count": len(used_counts),
        "total_backend_selections": int(total),
        "max_backend_share": max_share,
        "gini": gini(all_values),
        "cv": coefficient_of_variation(all_values),
        "jain_fairness": jain_fairness(all_values),
    }


def summarize_windows(rows: list[dict[str, Any]], window_sec: float) -> list[dict[str, Any]]:
    if window_sec <= 0:
        return []
    buckets: dict[int, list[dict[str, Any]]] = {}
    for row in rows:
        bucket = int(float(row.get("scheduled_at_s") or 0) // window_sec)
        buckets.setdefault(bucket, []).append(row)
    output: list[dict[str, Any]] = []
    for bucket, bucket_rows in sorted(buckets.items()):
        ok = [row for row in bucket_rows if row.get("status") == "ok"]
        latencies = [float(row.get("latency_ms") or 0) for row in ok]
        output.append(
            {
                "window_start_s": bucket * window_sec,
                "window_end_s": (bucket + 1) * window_sec,
                "total": len(bucket_rows),
                "ok": len(ok),
                "failed": len(bucket_rows) - len(ok),
                "p50_latency_ms": percentile(latencies, 50),
                "p95_latency_ms": percentile(latencies, 95),
            }
        )
    return output


def summarize(
    workload: list[WorkItem],
    answer_records: list[dict[str, Any]],
    args: argparse.Namespace,
) -> dict[str, Any]:
    systems = args.systems_resolved
    performance: dict[str, Any] = {}
    backend_load: dict[str, Any] = {}
    runner_counts: dict[str, dict[str, int]] = {}
    window_summary: dict[str, list[dict[str, Any]]] = {}
    observability: dict[str, Any] = {}
    answer_ok = [item for item in answer_records if item.get("status") == "ok"]

    for system in systems:
        rows = [item for item in answer_records if item.get("system") == system]
        ok = [item for item in rows if item.get("status") == "ok"]
        latencies = [float(item.get("latency_ms") or 0) for item in ok]
        e2e_latencies = [float(item.get("e2e_ms") or 0) for item in ok]
        queue_delays = [float(item.get("queue_delay_ms") or 0) for item in rows]
        completion_tokens = [
            float(usage_for_cost(item.get("metadata") or {}).get("completion_tokens") or 0)
            for item in ok
        ]
        elapsed_s = max((float(item.get("completed_at_s") or 0) for item in rows), default=0.0)
        slo_violations = sum(1 for value in latencies if value > args.slo_ms)
        performance[system] = {
            "total": len(rows),
            "ok": len(ok),
            "failed": len(rows) - len(ok),
            "success_rate": len(ok) / len(rows) if rows else None,
            "elapsed_s": elapsed_s,
            "request_throughput_per_min": (len(ok) / elapsed_s * 60.0) if elapsed_s > 0 else None,
            "output_token_throughput_per_s": (sum(completion_tokens) / elapsed_s) if elapsed_s > 0 else None,
            "slo_ms": args.slo_ms,
            "slo_violation_rate": slo_violations / len(ok) if ok else None,
            "peak_in_flight": peak_in_flight(rows),
            "latency_ms": {
                "p50": percentile(latencies, 50),
                "p95": percentile(latencies, 95),
                "p99": percentile(latencies, 99),
                "mean": statistics.mean(latencies) if latencies else None,
                "max": max(latencies) if latencies else None,
            },
            "e2e_ms": {
                "p50": percentile(e2e_latencies, 50),
                "p95": percentile(e2e_latencies, 95),
                "p99": percentile(e2e_latencies, 99),
                "mean": statistics.mean(e2e_latencies) if e2e_latencies else None,
                "max": max(e2e_latencies) if e2e_latencies else None,
            },
            "queue_delay_ms": {
                "p50": percentile(queue_delays, 50),
                "p95": percentile(queue_delays, 95),
                "p99": percentile(queue_delays, 99),
                "max": max(queue_delays) if queue_delays else None,
            },
        }
        backend_load[system] = summarize_backend_load(rows, args.candidate_aliases_resolved)
        window_summary[system] = summarize_windows(rows, args.window_sec)
        observability[system] = summarize_observability(rows)
        for row in ok:
            metadata = row.get("metadata") or {}
            runner = str(metadata.get("runner") or ("fixed.direct" if system == "fixed_qwen35b" else "unknown"))
            runner_counts.setdefault(system, {})
            runner_counts[system][runner] = runner_counts[system].get(runner, 0) + 1

    max_scheduled = max((item.scheduled_at_s for item in workload), default=0.0)
    return {
        "schema_version": "modelnet.load_balance.summary.v1",
        "generated_at": utc8_now(),
        "dataset": {
            "name": args.workload_source,
            "source": args.trace_file if args.workload_source == "trace" else args.question_file,
            "request_count": len(workload),
            "scheduled_duration_s": max_scheduled,
        },
        "systems": systems,
        "load_config": {
            "arrival_mode": args.arrival_mode,
            "request_rate": args.request_rate,
            "max_client_concurrency": args.max_client_concurrency,
            "trace_time_scale": args.trace_time_scale,
            "slo_ms": args.slo_ms,
        },
        "answer_status": {
            "total": len(answer_records),
            "ok": len(answer_ok),
            "failed": len(answer_records) - len(answer_ok),
        },
        "performance": performance,
        "backend_load": backend_load,
        "runner_counts": runner_counts,
        "observability": observability,
        "windows": window_summary,
    }


def format_number(value: Any, digits: int = 2) -> str:
    if value is None:
        return "n/a"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        "# ModelNet Load-Balancing Benchmark",
        "",
        f"- Generated at: `{summary['generated_at']}`",
        f"- Workload: `{summary['dataset']['name']}`",
        f"- Requests: `{summary['dataset']['request_count']}`",
        f"- Scheduled duration: `{format_number(summary['dataset']['scheduled_duration_s'])}s`",
        f"- SLO: `{summary['load_config']['slo_ms']} ms`",
        "",
        "## Performance",
        "",
        "| System | OK/Total | p50 ms | p95 ms | p99 ms | e2e p95 ms | queue p95 ms | SLO violation | req/min | out tok/s | peak in-flight |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for system, stats in summary["performance"].items():
        lines.append(
            f"| `{system}` | {stats['ok']}/{stats['total']} | "
            f"{format_number(stats['latency_ms']['p50'])} | "
            f"{format_number(stats['latency_ms']['p95'])} | "
            f"{format_number(stats['latency_ms']['p99'])} | "
            f"{format_number(stats['e2e_ms']['p95'])} | "
            f"{format_number(stats['queue_delay_ms']['p95'])} | "
            f"{format_number(stats['slo_violation_rate'], 3)} | "
            f"{format_number(stats['request_throughput_per_min'])} | "
            f"{format_number(stats['output_token_throughput_per_s'])} | "
            f"{stats['peak_in_flight']} |"
        )

    lines.extend(
        [
            "",
            "## Backend Load Balance",
            "",
            "| System | Used backends | Backend selections | Max share | Gini | CV | Jain fairness |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for system, load in summary["backend_load"].items():
        lines.append(
            f"| `{system}` | {load['used_backend_count']} | {load['total_backend_selections']} | "
            f"{format_number(load['max_backend_share'], 3)} | "
            f"{format_number(load['gini'], 3)} | "
            f"{format_number(load['cv'], 3)} | "
            f"{format_number(load['jain_fairness'], 3)} |"
        )

    lines.extend(["", "## Top Selected Backends", ""])
    for system, load in summary["backend_load"].items():
        nonzero = [(key, value) for key, value in load["request_counts"].items() if value > 0]
        top = ", ".join(f"{key}: {int(value)}" for key, value in nonzero[:8])
        lines.append(f"- `{system}`: {top or 'n/a'}")

    lines.extend(["", "## Routing Mix", ""])
    for system, counts in summary.get("runner_counts", {}).items():
        lines.append(f"- `{system}`: " + ", ".join(f"{key}: {value}" for key, value in sorted(counts.items())))

    lines.extend(
        [
            "",
            "## Observability",
            "",
            "| System | Missing metadata | Internal calls | Internal tokens | Stage distribution |",
            "| --- | ---: | ---: | ---: | --- |",
        ]
    )
    for system, stats in summary.get("observability", {}).items():
        missing = sum(int(value or 0) for value in stats.get("missing_metadata", {}).values())
        stages = ", ".join(
            f"{item['stage']}: {item['count']} calls, p95 {format_number(item['latency_ms']['p95'])} ms"
            for item in stats.get("call_ledger_summary", [])
        )
        lines.append(
            f"| `{system}` | {missing} | "
            f"{format_number(stats['internal_call_count']['total'])} | "
            f"{format_number(stats['internal_total_tokens']['total'])} | "
            f"{stages or 'n/a'} |"
        )
    return "\n".join(lines).rstrip() + "\n"


def parse_systems(raw: str) -> list[str]:
    systems = [item.strip() for item in raw.split(",") if item.strip()]
    unknown = [item for item in systems if item not in SYSTEMS]
    if unknown:
        raise RuntimeError(f"Unknown systems: {unknown}. Available: {sorted(SYSTEMS)}")
    if not systems:
        raise RuntimeError("At least one system must be selected")
    return systems


def parse_args() -> argparse.Namespace:
    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    parser = argparse.ArgumentParser(description="Run ModelNet load-balancing workload benchmark.")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--models-endpoint", default=DEFAULT_MODELS_ENDPOINT)
    parser.add_argument("--question-file", default="benchmarks/data/mt_bench_question.jsonl")
    parser.add_argument("--workload-source", choices=("mtbench", "synthetic", "trace"), default="mtbench")
    parser.add_argument("--trace-file", default="")
    parser.add_argument("--trace-time-scale", type=float, default=0.001)
    parser.add_argument("--num-requests", type=int, default=40)
    parser.add_argument("--request-rate", type=float, default=0.5, help="Requests per second for mtbench/synthetic workloads.")
    parser.add_argument("--arrival-mode", choices=("constant", "poisson", "bursty"), default="poisson")
    parser.add_argument("--burstiness", type=float, default=4.0)
    parser.add_argument("--burst-size", type=int, default=8)
    parser.add_argument("--burst-gap-multiplier", type=float, default=8.0)
    parser.add_argument("--max-client-concurrency", type=int, default=16)
    parser.add_argument("--systems", default="modelnet_auto,adaptive_sparse_graph,single_best,parallel_consensus")
    parser.add_argument("--candidate-aliases", default="")
    parser.add_argument("--max-input-tokens", type=int, default=4096)
    parser.add_argument("--synthetic-input-tokens", type=int, default=512)
    parser.add_argument("--synthetic-input-tokens-stddev", type=int, default=128)
    parser.add_argument("--synthetic-output-tokens", type=int, default=192)
    parser.add_argument("--synthetic-output-tokens-stddev", type=int, default=64)
    parser.add_argument("--max-tokens", type=int, default=512)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--top-p", type=float, default=0.9)
    parser.add_argument("--max-auto-sources", type=int, default=3)
    parser.add_argument("--expert-max-tokens", type=int, default=256)
    parser.add_argument("--critic-max-tokens", type=int, default=192)
    parser.add_argument("--aggregation-max-tokens", type=int, default=512)
    parser.add_argument("--request-timeout", type=int, default=300)
    parser.add_argument("--retries", type=int, default=1)
    parser.add_argument("--slo-ms", type=int, default=120000)
    parser.add_argument("--window-sec", type=float, default=60.0)
    parser.add_argument("--output-dir", default=f"benchmarks/results/load-balance-{timestamp}")
    parser.add_argument("--seed", type=int, default=20260610)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.systems_resolved = parse_systems(args.systems)
    if args.candidate_aliases.strip():
        args.candidate_aliases_resolved = [item.strip() for item in args.candidate_aliases.split(",") if item.strip()]
    else:
        args.candidate_aliases_resolved = available_model_ids(args.models_endpoint)

    output_dir = Path(args.output_dir)
    answer_file = output_dir / "answers.jsonl"
    if answer_file.exists() and not args.force:
        raise RuntimeError(f"{answer_file} already exists. Use --force or choose a new --output-dir.")
    output_dir.mkdir(parents=True, exist_ok=True)
    if args.force and answer_file.exists():
        answer_file.unlink()

    workload = make_workload(args)
    workload_file = output_dir / "workload.jsonl"
    for item in workload:
        append_jsonl(workload_file, asdict(item) | {"prompt_preview": item.prompt[:240]})

    safe_args = vars(args).copy()
    write_json(
        output_dir / "run_config.json",
        {
            "created_at": utc8_now(),
            "args": safe_args,
            "candidate_aliases": args.candidate_aliases_resolved,
        },
    )

    if args.dry_run:
        summary = summarize(workload, [], args)
        write_json(output_dir / "summary.json", summary)
        (output_dir / "report.md").write_text(render_report(summary), encoding="utf-8")
        write_manifest(output_dir)
        print(f"[dry-run] output_dir={output_dir}", flush=True)
        return 0

    all_records: list[dict[str, Any]] = []
    for system in args.systems_resolved:
        all_records.extend(run_system_workload(system, workload, args, answer_file))

    answer_records = read_jsonl(answer_file)
    summary = summarize(workload, answer_records, args)
    write_json(output_dir / "summary.json", summary)
    (output_dir / "report.md").write_text(render_report(summary), encoding="utf-8")
    write_manifest(output_dir)
    print(f"[done] output_dir={output_dir}", flush=True)
    print(json.dumps(summary["answer_status"], ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
