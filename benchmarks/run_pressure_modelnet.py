#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import os
import random
import re
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


MT_BENCH_URL = (
    "https://raw.githubusercontent.com/lm-sys/FastChat/main/"
    "fastchat/llm_judge/data/mt_bench/question.jsonl"
)
DEFAULT_ENDPOINT = "http://127.0.0.1:3092/v1/chat/completions"
DEFAULT_MODELS_ENDPOINT = "http://127.0.0.1:3092/v1/models"
DEFAULT_DEEPSEEK_BASE = "https://api.deepseek.com"
DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash"
FIXED_QWEN35B = "inference-qwen-qwen3-5-35b-a3b-gptq-int4"
DEFAULT_QUESTION_IDS = (
    81, 86, 91, 96,
    101, 106, 111, 116,
    121, 126, 131, 136,
    141, 146, 151, 156,
)
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
BASELINES = ("adaptive_sparse_graph", "single_best", "fixed_qwen35b", "parallel_consensus")
DIRECT_PAIRWISE = (("adaptive_sparse_graph", "single_best"),)


def now_cst() -> str:
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).isoformat(timespec="seconds")


def json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, sort_keys=False)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json_dumps(record) + "\n")


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def archive_router_trace(output_dir: Path) -> Path | None:
    trace_path = Path(os.environ.get("MODELNET_ROUTER_TRACE_PATH", "/tmp/router_trace.jsonl"))
    if not trace_path.exists():
        return None
    target = output_dir / "router_trace.jsonl"
    target.write_bytes(trace_path.read_bytes())
    return target


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
    request = urllib.request.Request(MT_BENCH_URL, headers={"User-Agent": "modelnet-pressure/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        question_file.write_bytes(response.read())


def load_questions(question_file: Path, question_ids: list[int]) -> list[dict[str, Any]]:
    ensure_mtbench(question_file)
    questions = read_jsonl(question_file)
    by_id = {int(item["question_id"]): item for item in questions}
    selected = [by_id[qid] for qid in question_ids if qid in by_id]
    if len(selected) != len(question_ids):
        missing = sorted(set(question_ids) - set(by_id))
        raise RuntimeError(f"Missing MT-Bench question ids: {missing}")
    return selected


def http_json(
    url: str,
    payload: dict[str, Any] | None = None,
    *,
    headers: dict[str, str] | None = None,
    timeout: int = 300,
) -> dict[str, Any]:
    request_headers = {"User-Agent": "modelnet-pressure/1.0", **(headers or {})}
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


def call_modelnet_chat(
    *,
    endpoint: str,
    model: str,
    messages: list[dict[str, str]],
    args: argparse.Namespace,
    modelnet_options: dict[str, Any] | None,
) -> tuple[dict[str, Any], int]:
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "max_tokens": args.max_tokens,
        "temperature": args.temperature,
        "top_p": args.top_p,
    }
    if modelnet_options:
        payload["modelnet"] = modelnet_options
    started = time.perf_counter()
    data = http_json(endpoint, payload, timeout=args.request_timeout)
    return data, int((time.perf_counter() - started) * 1000)


def metadata_summary(data: dict[str, Any]) -> dict[str, Any]:
    metadata = data.get("modelnet", {}).get("metadata", {})
    plan = metadata.get("auto_plan", {})
    selected_roles = plan.get("selected_roles", {}) if isinstance(plan, dict) else {}
    return {
        "model": data.get("model"),
        "usage": data.get("usage"),
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


def answer_key(record: dict[str, Any]) -> tuple[int, str, int]:
    return int(record["concurrency"]), str(record["system"]), int(record["question_id"])


def judgment_target(record: dict[str, Any]) -> str:
    return str(record.get("target_system") or "modelnet_auto")


def judgment_comparison(record: dict[str, Any]) -> str:
    return str(record.get("comparison_system") or record.get("baseline") or "")


def judgment_key(record: dict[str, Any]) -> tuple[int, int, str, str, str]:
    return (
        int(record["concurrency"]),
        int(record["question_id"]),
        judgment_target(record),
        judgment_comparison(record),
        str(record["order"]),
    )


def generate_answer(question: dict[str, Any], system: str, concurrency: int, args: argparse.Namespace) -> dict[str, Any]:
    spec = SYSTEMS[system]
    model = str(spec["model"])
    runner_config = spec["runner_config"]
    modelnet_options = (
        build_modelnet_options(args, runner_config)
        if isinstance(runner_config, dict)
        else None
    )
    messages: list[dict[str, str]] = []
    turns: list[dict[str, Any]] = []
    started = time.perf_counter()
    error = None
    status = "ok"
    try:
        for turn_index, prompt in enumerate(question.get("turns", []), start=1):
            messages.append({"role": "user", "content": str(prompt)})
            last_error: Exception | None = None
            for attempt in range(args.retries + 1):
                try:
                    data, elapsed_ms = call_modelnet_chat(
                        endpoint=args.endpoint,
                        model=model,
                        messages=messages,
                        args=args,
                        modelnet_options=modelnet_options,
                    )
                    break
                except Exception as exc:  # noqa: BLE001
                    last_error = exc
                    if attempt < args.retries:
                        time.sleep(1.5 * (attempt + 1))
            else:
                raise RuntimeError(str(last_error))
            text = str(data["choices"][0]["message"]["content"])
            messages.append({"role": "assistant", "content": text})
            turns.append(
                {
                    "turn": turn_index,
                    "prompt": str(prompt),
                    "answer": text,
                    "latency_ms": elapsed_ms,
                    "metadata": metadata_summary(data),
                }
            )
    except Exception as exc:  # noqa: BLE001
        status = "error"
        error = str(exc)[:1000]
    return {
        "schema_version": "modelnet.pressure.answer.v1",
        "created_at": now_cst(),
        "concurrency": concurrency,
        "question_id": int(question["question_id"]),
        "category": str(question.get("category") or ""),
        "system": system,
        "status": status,
        "total_latency_ms": int((time.perf_counter() - started) * 1000),
        "turns": turns,
        "error": error,
    }


def deepseek_key(secret_file: Path) -> str:
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if key:
        return key
    if secret_file.exists():
        for line in secret_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("DEEPSEEK_API_KEY="):
                return line.split("=", 1)[1].strip().strip("'\"")
    raise RuntimeError("DEEPSEEK_API_KEY is not set")


def judge_prompt(question: dict[str, Any], a_system: str, a_record: dict[str, Any], b_system: str, b_record: dict[str, Any]) -> str:
    question_text = "\n".join(
        f"Turn {index + 1} user: {turn}"
        for index, turn in enumerate(question.get("turns", []))
    )
    a_text = "\n".join(
        f"Turn {turn.get('turn')} assistant: {turn.get('answer', '')}"
        for turn in a_record.get("turns", [])
    )
    b_text = "\n".join(
        f"Turn {turn.get('turn')} assistant: {turn.get('answer', '')}"
        for turn in b_record.get("turns", [])
    )
    return f"""You are an impartial evaluator for MT-Bench style multi-turn assistant answers.
Judge the two assistants across the full conversation. First score each assistant independently,
then choose the winner from those scores. Prefer correctness, instruction-following, helpfulness,
completeness, consistency across turns, and concise reasoning. Do not favor verbosity. Do not favor
Assistant A or the first answer because of its position.

Category: {question.get('category')}

[User Conversation]
{question_text}

[Assistant A: {a_system}]
{a_text}

[Assistant B: {b_system}]
{b_text}

Return JSON only, with this schema:
{{"winner":"A"|"B"|"tie","score_a":1-10,"score_b":1-10,"confidence":0.0-1.0,"reason":"short reason"}}
"""


def parse_judge_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    candidates = [stripped]
    match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
    if match:
        candidates.append(match.group(0))
    for candidate in candidates:
        try:
            payload = json.loads(candidate)
            winner = str(payload.get("winner") or "").strip().lower()
            if winner in {"a", "assistant a"}:
                payload["winner"] = "A"
            elif winner in {"b", "assistant b"}:
                payload["winner"] = "B"
            elif winner in {"tie", "draw", "equal"}:
                payload["winner"] = "tie"
            else:
                payload["winner"] = "tie"
                payload["parse_warning"] = f"unknown winner: {winner}"
            return payload
        except Exception:
            continue
    return {"winner": "tie", "confidence": 0.0, "reason": stripped[:500], "parse_warning": "unparsed"}


def call_deepseek_judge(prompt: str, args: argparse.Namespace, api_key: str) -> tuple[str, int]:
    payload = {
        "model": args.deepseek_model,
        "messages": [
            {"role": "system", "content": "You are a strict evaluator. Return valid JSON only."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.0,
        "max_tokens": args.judge_max_tokens,
        "stream": False,
    }
    headers = {"Authorization": f"Bearer {api_key}"}
    started = time.perf_counter()
    data = http_json(
        args.deepseek_base.rstrip("/") + "/chat/completions",
        payload,
        headers=headers,
        timeout=args.judge_timeout,
    )
    return str(data["choices"][0]["message"]["content"]), int((time.perf_counter() - started) * 1000)


def generate_judgment(
    question: dict[str, Any],
    target_record: dict[str, Any],
    comparison_record: dict[str, Any],
    target_system: str,
    comparison_system: str,
    order: str,
    args: argparse.Namespace,
    api_key: str,
) -> dict[str, Any]:
    if order in {"auto_first", "target_first"}:
        a_system, a_record = target_system, target_record
        b_system, b_record = comparison_system, comparison_record
    else:
        a_system, a_record = comparison_system, comparison_record
        b_system, b_record = target_system, target_record
    started = time.perf_counter()
    try:
        prompt = judge_prompt(question, a_system, a_record, b_system, b_record)
        last_error: Exception | None = None
        for attempt in range(args.judge_retries + 1):
            try:
                raw_text, latency_ms = call_deepseek_judge(prompt, args, api_key)
                break
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                if attempt < args.judge_retries:
                    time.sleep(2.0 * (attempt + 1))
        else:
            raise RuntimeError(str(last_error))
        parsed = parse_judge_json(raw_text)
        winner = parsed.get("winner")
        if winner == "A":
            winning_system = a_system
        elif winner == "B":
            winning_system = b_system
        else:
            winning_system = "tie"
        if winning_system == target_system:
            target_score = 1.0
        elif winning_system == "tie":
            target_score = 0.5
        else:
            target_score = 0.0
        status = "ok"
        error = None
    except Exception as exc:  # noqa: BLE001
        latency_ms = int((time.perf_counter() - started) * 1000)
        raw_text = ""
        parsed = {}
        winning_system = ""
        target_score = None
        status = "error"
        error = str(exc)[:1000]
    return {
        "schema_version": "modelnet.pressure.judgment.v1",
        "created_at": now_cst(),
        "concurrency": int(target_record["concurrency"]),
        "question_id": int(question["question_id"]),
        "category": str(question.get("category") or ""),
        "baseline": comparison_system,
        "target_system": target_system,
        "comparison_system": comparison_system,
        "order": order,
        "a_system": a_system,
        "b_system": b_system,
        "status": status,
        "winner": winning_system,
        "auto_score": target_score,
        "target_score": target_score,
        "judge_model": args.deepseek_model,
        "judge_api_base": args.deepseek_base,
        "latency_ms": latency_ms,
        "judge_json": parsed,
        "raw_judge_text": raw_text[:2000],
        "error": error,
    }


def percentile(values: list[float], pct: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, math.ceil((pct / 100) * len(ordered)) - 1))
    return ordered[index]


def bootstrap_ci(values: list[float], *, iterations: int = 1000, seed: int = 0) -> list[float | None]:
    if not values:
        return [None, None]
    rng = random.Random(seed)
    means: list[float] = []
    for _ in range(iterations):
        sample = [values[rng.randrange(len(values))] for _ in values]
        means.append(statistics.mean(sample))
    return [percentile(means, 2.5), percentile(means, 97.5)]


def summarize(answers: list[dict[str, Any]], judgments: list[dict[str, Any]], args: argparse.Namespace) -> dict[str, Any]:
    answer_ok = [item for item in answers if item.get("status") == "ok"]
    judgment_ok = [item for item in judgments if item.get("status") == "ok" and item.get("auto_score") is not None]

    performance: dict[str, Any] = {}
    runner_counts: dict[str, dict[str, int]] = {}
    selected_counts: dict[str, int] = {}
    for concurrency in args.concurrency_levels:
        performance[str(concurrency)] = {}
        for system in SYSTEMS:
            rows = [item for item in answers if int(item.get("concurrency") or 0) == concurrency and item.get("system") == system]
            ok = [item for item in rows if item.get("status") == "ok"]
            latencies = [float(item.get("total_latency_ms") or 0) for item in ok]
            wall_ms = max(latencies) if latencies else 0.0
            performance[str(concurrency)][system] = {
                "total": len(rows),
                "ok": len(ok),
                "failed": len(rows) - len(ok),
                "success_rate": len(ok) / len(rows) if rows else None,
                "throughput_per_min": (len(ok) / (wall_ms / 60000.0)) if wall_ms else None,
                "p50_ms": percentile(latencies, 50),
                "p95_ms": percentile(latencies, 95),
                "p99_ms": percentile(latencies, 99),
                "mean_ms": statistics.mean(latencies) if latencies else None,
                "max_ms": max(latencies) if latencies else None,
            }
            for item in ok:
                for turn in item.get("turns", []):
                    meta = turn.get("metadata", {})
                    runner = str(meta.get("runner") or ("fixed.direct" if system == "fixed_qwen35b" else "unknown"))
                    runner_counts.setdefault(system, {})
                    runner_counts[system][runner] = runner_counts[system].get(runner, 0) + 1
                    for model in meta.get("selected", []):
                        if model:
                            selected_counts[str(model)] = selected_counts.get(str(model), 0) + 1

    grouped: dict[tuple[int, int, str, str], list[dict[str, Any]]] = {}
    for item in judgment_ok:
        grouped.setdefault(
            (
                int(item["concurrency"]),
                int(item["question_id"]),
                judgment_target(item),
                judgment_comparison(item),
            ),
            [],
        ).append(item)

    def summarize_quality_pair(target_system: str, comparison_system: str, concurrency: int) -> dict[str, Any]:
        scores: list[float] = []
        for key, rows in grouped.items():
            conc, _qid, target, comparison = key
            if conc == concurrency and target == target_system and comparison == comparison_system:
                scores.append(statistics.mean(float(row["auto_score"]) for row in rows))
        return {
            "question_count": len(scores),
            "average_score": statistics.mean(scores) if scores else None,
            "bootstrap_95ci": bootstrap_ci(scores),
            "wins": sum(score > 0.5 for score in scores),
            "ties": sum(score == 0.5 for score in scores),
            "losses": sum(score < 0.5 for score in scores),
        }

    quality: dict[str, Any] = {}
    direct_quality: dict[str, Any] = {}
    for concurrency in args.concurrency_levels:
        quality[str(concurrency)] = {}
        for baseline in BASELINES:
            quality[str(concurrency)][baseline] = summarize_quality_pair("modelnet_auto", baseline, concurrency)
        direct_quality[str(concurrency)] = {
            f"{target}_vs_{comparison}": {
                **summarize_quality_pair(target, comparison, concurrency),
                "target_system": target,
                "comparison_system": comparison,
            }
            for target, comparison in DIRECT_PAIRWISE
        }

    return {
        "schema_version": "modelnet.pressure.summary.v1",
        "generated_at": now_cst(),
        "dataset": {
            "name": "MT-Bench sampled pressure set",
            "source_url": MT_BENCH_URL,
            "question_ids": args.question_ids_resolved,
        },
        "systems": list(SYSTEMS),
        "concurrency_levels": args.concurrency_levels,
        "judge": {
            "provider": "deepseek",
            "model": args.deepseek_model,
            "api_base": args.deepseek_base,
        },
        "answer_status": {
            "total": len(answers),
            "ok": len(answer_ok),
            "failed": len(answers) - len(answer_ok),
        },
        "judgment_status": {
            "total": len(judgments),
            "ok": len(judgment_ok),
            "failed": len(judgments) - len(judgment_ok),
        },
        "performance": performance,
        "quality": quality,
        "direct_quality": direct_quality,
        "runner_counts": runner_counts,
        "selected_model_counts": dict(sorted(selected_counts.items(), key=lambda item: (-item[1], item[0]))),
    }


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        "# ModelNet High-Load Pressure Benchmark",
        "",
        f"- Generated at: `{summary['generated_at']}`",
        f"- Questions: `{summary['dataset']['question_ids']}`",
        f"- Judge: `{summary['judge']['provider']}:{summary['judge']['model']}`",
        "",
        "## Performance",
        "",
    ]
    for concurrency in summary["concurrency_levels"]:
        lines.append(f"### Concurrency {concurrency}")
        lines.append("| System | OK/Total | p50 ms | p95 ms | p99 ms | max ms | throughput/min |")
        lines.append("| --- | ---: | ---: | ---: | ---: | ---: | ---: |")
        for system, stats in summary["performance"][str(concurrency)].items():
            throughput = stats["throughput_per_min"]
            lines.append(
                f"| `{system}` | {stats['ok']}/{stats['total']} | {stats['p50_ms']} | {stats['p95_ms']} | "
                f"{stats['p99_ms']} | {stats['max_ms']} | "
                f"{'n/a' if throughput is None else f'{throughput:.2f}'} |"
            )
        lines.append("")
    lines.extend(["## Quality: modelnet_auto Pairwise Score", ""])
    for concurrency in summary["concurrency_levels"]:
        lines.append(f"### Concurrency {concurrency}")
        lines.append("| Baseline | Questions | Avg | 95% CI | Win/Tie/Loss |")
        lines.append("| --- | ---: | ---: | --- | --- |")
        for baseline, result in summary["quality"][str(concurrency)].items():
            avg = result["average_score"]
            ci = result["bootstrap_95ci"]
            avg_text = "n/a" if avg is None else f"{avg:.3f}"
            ci_text = "n/a" if ci[0] is None else f"[{ci[0]:.3f}, {ci[1]:.3f}]"
            lines.append(
                f"| `{baseline}` | {result['question_count']} | {avg_text} | {ci_text} | "
                f"{result['wins']}/{result['ties']}/{result['losses']} |"
            )
        lines.append("")
    if summary.get("direct_quality"):
        lines.extend(["## Direct Quality: Target Pairwise Score", ""])
        for concurrency in summary["concurrency_levels"]:
            lines.append(f"### Concurrency {concurrency}")
            lines.append("| Target vs Comparison | Questions | Avg | 95% CI | Win/Tie/Loss |")
            lines.append("| --- | ---: | ---: | --- | --- |")
            for name, result in summary["direct_quality"][str(concurrency)].items():
                avg = result["average_score"]
                ci = result["bootstrap_95ci"]
                avg_text = "n/a" if avg is None else f"{avg:.3f}"
                ci_text = "n/a" if ci[0] is None else f"[{ci[0]:.3f}, {ci[1]:.3f}]"
                lines.append(
                    f"| `{name}` | {result['question_count']} | {avg_text} | {ci_text} | "
                    f"{result['wins']}/{result['ties']}/{result['losses']} |"
                )
            lines.append("")
    lines.extend(["## Routing Mix", ""])
    for system, counts in summary.get("runner_counts", {}).items():
        lines.append(f"- `{system}`: " + ", ".join(f"{k}: {v}" for k, v in sorted(counts.items())))
    return "\n".join(lines).rstrip() + "\n"


def parse_int_list(raw: str) -> list[int]:
    return [int(item.strip()) for item in raw.split(",") if item.strip()]


def parse_args() -> argparse.Namespace:
    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    parser = argparse.ArgumentParser(description="Run ModelNet high-load pressure benchmark.")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--models-endpoint", default=DEFAULT_MODELS_ENDPOINT)
    parser.add_argument("--question-file", default="benchmarks/data/mt_bench_question.jsonl")
    parser.add_argument("--question-ids", default=",".join(str(item) for item in DEFAULT_QUESTION_IDS))
    parser.add_argument("--concurrency-levels", default="1,4,8,16")
    parser.add_argument("--judge-question-count", type=int, default=8)
    parser.add_argument("--output-dir", default=f"benchmarks/results/pressure-{timestamp}")
    parser.add_argument("--candidate-aliases", default="")
    parser.add_argument("--max-tokens", type=int, default=768)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--top-p", type=float, default=0.9)
    parser.add_argument("--max-auto-sources", type=int, default=3)
    parser.add_argument("--expert-max-tokens", type=int, default=384)
    parser.add_argument("--critic-max-tokens", type=int, default=256)
    parser.add_argument("--aggregation-max-tokens", type=int, default=768)
    parser.add_argument("--request-timeout", type=int, default=300)
    parser.add_argument("--retries", type=int, default=1)
    parser.add_argument("--deepseek-base", default=DEFAULT_DEEPSEEK_BASE)
    parser.add_argument("--deepseek-model", default=DEFAULT_DEEPSEEK_MODEL)
    parser.add_argument("--deepseek-secret-file", default=str(Path.home() / ".modelnet_secrets" / "deepseek.env"))
    parser.add_argument("--judge-workers", type=int, default=2)
    parser.add_argument("--judge-max-tokens", type=int, default=512)
    parser.add_argument("--judge-timeout", type=int, default=120)
    parser.add_argument("--judge-retries", type=int, default=1)
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.question_ids_resolved = parse_int_list(args.question_ids)
    args.concurrency_levels = parse_int_list(args.concurrency_levels)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    answer_file = output_dir / "answers.jsonl"
    judgment_file = output_dir / "judgments.jsonl"
    summary_file = output_dir / "summary.json"
    report_file = output_dir / "report.md"

    questions = load_questions(Path(args.question_file), args.question_ids_resolved)
    question_by_id = {int(item["question_id"]): item for item in questions}
    if args.candidate_aliases.strip():
        args.candidate_aliases_resolved = [item.strip() for item in args.candidate_aliases.split(",") if item.strip()]
    else:
        args.candidate_aliases_resolved = available_model_ids(args.models_endpoint)
    api_key = deepseek_key(Path(args.deepseek_secret_file))

    safe_args = vars(args).copy()
    safe_args["deepseek_secret_file"] = "<redacted>"
    write_json(
        output_dir / "run_config.json",
        {
            "created_at": now_cst(),
            "args": safe_args,
            "candidate_aliases": args.candidate_aliases_resolved,
        },
    )

    existing_answers = {} if args.force else {answer_key(item): item for item in read_jsonl(answer_file)}
    for concurrency in args.concurrency_levels:
        for system in SYSTEMS:
            jobs = [
                question
                for question in questions
                if (concurrency, system, int(question["question_id"])) not in existing_answers
            ]
            print(f"[answers] concurrency={concurrency} system={system} existing={len(existing_answers)} pending={len(jobs)}", flush=True)
            with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, concurrency)) as executor:
                futures = {
                    executor.submit(generate_answer, question, system, concurrency, args): question
                    for question in jobs
                }
                for future in concurrent.futures.as_completed(futures):
                    question = futures[future]
                    record = future.result()
                    append_jsonl(answer_file, record)
                    existing_answers[answer_key(record)] = record
                    print(
                        f"[answer] c={concurrency} q={question['question_id']} system={system} "
                        f"status={record['status']} latency_ms={record['total_latency_ms']}",
                        flush=True,
                    )

    answer_records = list({answer_key(item): item for item in read_jsonl(answer_file)}.values())
    answer_by_key = {answer_key(item): item for item in answer_records}
    existing_judgments = {} if args.force else {judgment_key(item): item for item in read_jsonl(judgment_file)}
    rng = random.Random(20260609)
    judgment_jobs: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any], str, str, str]] = []
    judgment_pairs = [("modelnet_auto", baseline) for baseline in BASELINES] + list(DIRECT_PAIRWISE)
    for concurrency in args.concurrency_levels:
        judge_questions = list(questions)
        rng.shuffle(judge_questions)
        judge_questions = judge_questions[: min(args.judge_question_count, len(judge_questions))]
        for question in judge_questions:
            qid = int(question["question_id"])
            for target_system, comparison_system in judgment_pairs:
                target_record = answer_by_key.get((concurrency, target_system, qid))
                comparison_record = answer_by_key.get((concurrency, comparison_system, qid))
                if (
                    not target_record
                    or not comparison_record
                    or target_record.get("status") != "ok"
                    or comparison_record.get("status") != "ok"
                ):
                    continue
                orders = (
                    ("auto_first", "baseline_first")
                    if target_system == "modelnet_auto"
                    else ("target_first", "comparison_first")
                )
                for order in orders:
                    key = (concurrency, qid, target_system, comparison_system, order)
                    if key not in existing_judgments:
                        judgment_jobs.append(
                            (question, target_record, comparison_record, target_system, comparison_system, order)
                        )

    print(f"[judgments] existing={len(existing_judgments)} pending={len(judgment_jobs)}", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.judge_workers)) as executor:
        futures = {
            executor.submit(
                generate_judgment,
                question,
                target_record,
                comparison_record,
                target_system,
                comparison_system,
                order,
                args,
                api_key,
            ): (
                question,
                target_record,
                target_system,
                comparison_system,
                order,
            )
            for question, target_record, comparison_record, target_system, comparison_system, order in judgment_jobs
        }
        for future in concurrent.futures.as_completed(futures):
            question, target_record, target_system, comparison_system, order = futures[future]
            record = future.result()
            append_jsonl(judgment_file, record)
            existing_judgments[judgment_key(record)] = record
            print(
                f"[judge] c={target_record['concurrency']} q={question['question_id']} "
                f"target={target_system} comparison={comparison_system} order={order} "
                f"status={record['status']} target_score={record['target_score']}",
                flush=True,
            )

    answer_records = list({answer_key(item): item for item in read_jsonl(answer_file)}.values())
    judgment_records = list({judgment_key(item): item for item in read_jsonl(judgment_file)}.values())
    summary = summarize(answer_records, judgment_records, args)
    write_json(summary_file, summary)
    report_file.write_text(render_report(summary), encoding="utf-8")
    archive_router_trace(output_dir)
    write_manifest(output_dir)
    print(f"[done] output_dir={output_dir}", flush=True)
    print(json.dumps({"answer_status": summary["answer_status"], "judgment_status": summary["judgment_status"]}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
