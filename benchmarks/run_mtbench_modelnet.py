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
DEFAULT_JUDGE_MODEL = "inference-qwen-qwen3-5-35b-a3b-gptq-int4"
FIXED_QWEN35B = "inference-qwen-qwen3-5-35b-a3b-gptq-int4"
DEFAULT_TIMEOUT_SECONDS = 240

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


def utc8_now() -> str:
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
    req = urllib.request.Request(MT_BENCH_URL, headers={"User-Agent": "modelnet-mtbench/1.0"})
    with urllib.request.urlopen(req, timeout=60) as response:
        question_file.write_bytes(response.read())


def load_questions(question_file: Path, *, limit: int | None, question_ids: set[int] | None) -> list[dict[str, Any]]:
    ensure_mtbench(question_file)
    questions = read_jsonl(question_file)
    if question_ids:
        questions = [item for item in questions if int(item.get("question_id")) in question_ids]
    if limit is not None:
        questions = questions[:limit]
    return questions


def http_json(url: str, payload: dict[str, Any] | None = None, *, timeout: int = DEFAULT_TIMEOUT_SECONDS) -> dict[str, Any]:
    if payload is None:
        req = urllib.request.Request(url, headers={"User-Agent": "modelnet-mtbench/1.0"})
    else:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json", "User-Agent": "modelnet-mtbench/1.0"},
            method="POST",
        )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {body[:600]}") from exc


def call_chat(
    *,
    endpoint: str,
    model: str,
    messages: list[dict[str, str]],
    max_tokens: int,
    temperature: float,
    top_p: float,
    modelnet_options: dict[str, Any] | None = None,
    extra_body: dict[str, Any] | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
    retries: int = 2,
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
    if extra_body:
        payload.update(extra_body)

    last_error: Exception | None = None
    for attempt in range(retries + 1):
        started = time.perf_counter()
        try:
            data = http_json(endpoint, payload, timeout=timeout)
            elapsed_ms = int((time.perf_counter() - started) * 1000)
            return data, elapsed_ms
        except Exception as exc:  # noqa: BLE001 - preserve upstream error text in benchmark record.
            last_error = exc
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(str(last_error))


def available_model_ids(models_endpoint: str, judge_model: str) -> list[str]:
    payload = http_json(models_endpoint, timeout=30)
    ids = [
        str(item.get("id"))
        for item in payload.get("data", [])
        if item.get("id") not in {"modelnet", "modelnet-auto", judge_model}
    ]
    if not ids:
        raise RuntimeError("No non-judge ModelNet models are available")
    return ids


def answer_key(record: dict[str, Any]) -> tuple[int, str]:
    return int(record["question_id"]), str(record["system"])


def judgment_key(record: dict[str, Any]) -> tuple[int, str, str]:
    return int(record["question_id"]), str(record["baseline"]), str(record["order"])


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
        "stages": plan.get("stages") if isinstance(plan, dict) else None,
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


def build_modelnet_options(
    *,
    runner_config: dict[str, Any],
    candidate_aliases: list[str],
    max_auto_sources: int,
    expert_max_tokens: int,
    critic_max_tokens: int,
    aggregation_max_tokens: int,
) -> dict[str, Any]:
    config = {
        "max_auto_sources": max_auto_sources,
        "expert_max_tokens": expert_max_tokens,
        "critic_max_tokens": critic_max_tokens,
        "aggregation_max_tokens": aggregation_max_tokens,
        **runner_config,
    }
    return {
        "candidate_aliases": candidate_aliases,
        "stream_options": {"include_trace": True},
        "collaboration_plan": {"runner_config": config},
    }


def generate_answer_record(
    question: dict[str, Any],
    system: str,
    args: argparse.Namespace,
    candidate_aliases: list[str],
) -> dict[str, Any]:
    messages: list[dict[str, str]] = []
    turns: list[dict[str, Any]] = []
    spec = SYSTEMS[system]
    model = str(spec["model"])
    runner_config = spec["runner_config"]
    modelnet_options = (
        build_modelnet_options(
            runner_config=runner_config,
            candidate_aliases=candidate_aliases,
            max_auto_sources=args.max_auto_sources,
            expert_max_tokens=args.expert_max_tokens,
            critic_max_tokens=args.critic_max_tokens,
            aggregation_max_tokens=args.aggregation_max_tokens,
        )
        if isinstance(runner_config, dict)
        else None
    )
    started = time.perf_counter()
    try:
        for turn_index, prompt in enumerate(question.get("turns", []), start=1):
            messages.append({"role": "user", "content": str(prompt)})
            data, elapsed_ms = call_chat(
                endpoint=args.endpoint,
                model=model,
                messages=messages,
                max_tokens=args.max_tokens,
                temperature=args.temperature,
                top_p=args.top_p,
                modelnet_options=modelnet_options,
                timeout=args.request_timeout,
                retries=args.retries,
            )
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
        status = "ok"
        error = None
    except Exception as exc:  # noqa: BLE001 - benchmark should record failures.
        status = "error"
        error = str(exc)[:1000]
    return {
        "schema_version": "modelnet.mtbench.answer.v1",
        "created_at": utc8_now(),
        "question_id": int(question["question_id"]),
        "category": str(question.get("category") or ""),
        "system": system,
        "status": status,
        "total_latency_ms": int((time.perf_counter() - started) * 1000),
        "turns": turns,
        "error": error,
    }


def judge_prompt(question: dict[str, Any], a_system: str, a_record: dict[str, Any], b_system: str, b_record: dict[str, Any]) -> str:
    turns = question.get("turns", [])
    a_turns = a_record.get("turns", [])
    b_turns = b_record.get("turns", [])
    question_text = "\n".join(f"Turn {index + 1} user: {turn}" for index, turn in enumerate(turns))
    a_text = "\n".join(
        f"Turn {item.get('turn')} assistant: {item.get('answer', '')}"
        for item in a_turns
    )
    b_text = "\n".join(
        f"Turn {item.get('turn')} assistant: {item.get('answer', '')}"
        for item in b_turns
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
    lower = stripped.lower()
    if "winner" in lower and "a" in lower and "b" not in lower:
        return {"winner": "A", "confidence": 0.0, "reason": stripped[:500], "parse_warning": "heuristic"}
    if "winner" in lower and "b" in lower and "a" not in lower:
        return {"winner": "B", "confidence": 0.0, "reason": stripped[:500], "parse_warning": "heuristic"}
    return {"winner": "tie", "confidence": 0.0, "reason": stripped[:500], "parse_warning": "unparsed"}


def generate_judgment_record(
    question: dict[str, Any],
    auto_record: dict[str, Any],
    baseline_record: dict[str, Any],
    baseline: str,
    order: str,
    args: argparse.Namespace,
) -> dict[str, Any]:
    if order == "auto_first":
        a_system, a_record = "modelnet_auto", auto_record
        b_system, b_record = baseline, baseline_record
    else:
        a_system, a_record = baseline, baseline_record
        b_system, b_record = "modelnet_auto", auto_record

    prompt = judge_prompt(question, a_system, a_record, b_system, b_record)
    started = time.perf_counter()
    try:
        judge_extra_body = (
            {"chat_template_kwargs": {"enable_thinking": False}}
            if args.judge_disable_thinking
            else None
        )
        try:
            data, elapsed_ms = call_chat(
                endpoint=args.endpoint,
                model=args.judge_model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a strict evaluator. Return valid JSON only.",
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=args.judge_max_tokens,
                temperature=0.0,
                top_p=1.0,
                modelnet_options=None,
                extra_body=judge_extra_body,
                timeout=args.request_timeout,
                retries=args.retries,
            )
        except Exception:
            if not judge_extra_body:
                raise
            data, elapsed_ms = call_chat(
                endpoint=args.endpoint,
                model=args.judge_model,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a strict evaluator. Return valid JSON only.",
                    },
                    {"role": "user", "content": prompt},
                ],
                max_tokens=args.judge_max_tokens,
                temperature=0.0,
                top_p=1.0,
                modelnet_options=None,
                extra_body=None,
                timeout=args.request_timeout,
                retries=args.retries,
            )
        raw_text = str(data["choices"][0]["message"]["content"])
        parsed = parse_judge_json(raw_text)
        winner = parsed.get("winner")
        winning_system = "tie"
        if winner == "A":
            winning_system = a_system
        elif winner == "B":
            winning_system = b_system
        if winning_system == "modelnet_auto":
            auto_score = 1.0
        elif winning_system == "tie":
            auto_score = 0.5
        else:
            auto_score = 0.0
        status = "ok"
        error = None
    except Exception as exc:  # noqa: BLE001
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        raw_text = ""
        parsed = {}
        winning_system = ""
        auto_score = None
        status = "error"
        error = str(exc)[:1000]

    return {
        "schema_version": "modelnet.mtbench.judgment.v1",
        "created_at": utc8_now(),
        "question_id": int(question["question_id"]),
        "category": str(question.get("category") or ""),
        "baseline": baseline,
        "order": order,
        "a_system": a_system,
        "b_system": b_system,
        "status": status,
        "winner": winning_system,
        "auto_score": auto_score,
        "judge_model": args.judge_model,
        "latency_ms": elapsed_ms,
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


def bootstrap_ci(values: list[float], *, iterations: int = 2000, seed: int = 0) -> tuple[float | None, float | None]:
    if not values:
        return None, None
    rng = random.Random(seed)
    means = []
    for _ in range(iterations):
        sample = [values[rng.randrange(len(values))] for _ in values]
        means.append(statistics.mean(sample))
    return percentile(means, 2.5), percentile(means, 97.5)


def summarize(
    questions: list[dict[str, Any]],
    answer_records: list[dict[str, Any]],
    judgment_records: list[dict[str, Any]],
    args: argparse.Namespace,
) -> dict[str, Any]:
    answers_ok = [item for item in answer_records if item.get("status") == "ok"]
    judgments_ok = [item for item in judgment_records if item.get("status") == "ok" and item.get("auto_score") is not None]

    latency_by_system: dict[str, list[float]] = {}
    runner_counts: dict[str, dict[str, int]] = {}
    role_counts: dict[str, int] = {}
    selected_counts: dict[str, int] = {}
    for record in answers_ok:
        system = str(record.get("system"))
        latency_by_system.setdefault(system, []).append(float(record.get("total_latency_ms") or 0))
        for turn in record.get("turns", []):
            metadata = turn.get("metadata", {})
            runner = str(metadata.get("runner") or "unknown")
            runner_counts.setdefault(system, {})
            runner_counts[system][runner] = runner_counts[system].get(runner, 0) + 1
            for role in metadata.get("roles", []):
                role_counts[str(role)] = role_counts.get(str(role), 0) + 1
            for model in metadata.get("selected", []):
                if model:
                    selected_counts[str(model)] = selected_counts.get(str(model), 0) + 1

    pairwise: dict[str, dict[str, Any]] = {}
    for baseline in BASELINES:
        grouped: dict[int, list[dict[str, Any]]] = {}
        for item in judgments_ok:
            if item.get("baseline") == baseline:
                grouped.setdefault(int(item["question_id"]), []).append(item)
        question_scores = []
        category_scores: dict[str, list[float]] = {}
        for question in questions:
            qid = int(question["question_id"])
            scores = [float(item["auto_score"]) for item in grouped.get(qid, [])]
            if not scores:
                continue
            score = statistics.mean(scores)
            question_scores.append(score)
            category_scores.setdefault(str(question.get("category") or ""), []).append(score)
        wins = sum(1 for score in question_scores if score > 0.5)
        ties = sum(1 for score in question_scores if score == 0.5)
        losses = sum(1 for score in question_scores if score < 0.5)
        ci_low, ci_high = bootstrap_ci(question_scores)
        pairwise[baseline] = {
            "question_count": len(question_scores),
            "average_score": statistics.mean(question_scores) if question_scores else None,
            "bootstrap_95ci": [ci_low, ci_high],
            "wins": wins,
            "ties": ties,
            "losses": losses,
            "category_average": {
                category: statistics.mean(scores)
                for category, scores in sorted(category_scores.items())
            },
            "success_criterion_met": (
                bool(question_scores)
                and statistics.mean(question_scores) > 0.55
                and ci_low is not None
                and ci_low > 0.50
            ),
        }

    return {
        "schema_version": "modelnet.mtbench.summary.v1",
        "generated_at": utc8_now(),
        "dataset": {
            "name": "MT-Bench",
            "source_url": MT_BENCH_URL,
            "question_count": len(questions),
        },
        "systems": list(SYSTEMS),
        "judge_model": args.judge_model,
        "generation_config": {
            "temperature": args.temperature,
            "top_p": args.top_p,
            "max_tokens": args.max_tokens,
            "max_auto_sources": args.max_auto_sources,
            "expert_max_tokens": args.expert_max_tokens,
            "critic_max_tokens": args.critic_max_tokens,
            "aggregation_max_tokens": args.aggregation_max_tokens,
            "candidate_alias_count": len(args.candidate_aliases_resolved),
        },
        "answer_status": {
            "total": len(answer_records),
            "ok": len(answers_ok),
            "failed": len(answer_records) - len(answers_ok),
        },
        "judgment_status": {
            "total": len(judgment_records),
            "ok": len(judgments_ok),
            "failed": len(judgment_records) - len(judgments_ok),
        },
        "pairwise": pairwise,
        "latency_ms": {
            system: {
                "count": len(values),
                "p50": percentile(values, 50),
                "p95": percentile(values, 95),
                "mean": statistics.mean(values) if values else None,
            }
            for system, values in sorted(latency_by_system.items())
        },
        "runner_counts": runner_counts,
        "role_counts": role_counts,
        "selected_model_counts": dict(sorted(selected_counts.items(), key=lambda item: (-item[1], item[0]))),
    }


def render_report(summary: dict[str, Any]) -> str:
    lines = [
        "# ModelNet Auto MT-Bench Benchmark",
        "",
        f"- Generated at: `{summary['generated_at']}`",
        f"- Dataset: MT-Bench, {summary['dataset']['question_count']} questions",
        f"- Judge: `{summary['judge_model']}`",
        "",
        "## Pairwise Results",
        "",
        "| Baseline | Questions | Avg score | 95% CI | Win/Tie/Loss | Criterion |",
        "| --- | ---: | ---: | --- | --- | --- |",
    ]
    for baseline, result in summary["pairwise"].items():
        avg = result["average_score"]
        ci = result["bootstrap_95ci"]
        avg_text = "n/a" if avg is None else f"{avg:.3f}"
        ci_text = "n/a" if ci[0] is None else f"[{ci[0]:.3f}, {ci[1]:.3f}]"
        criterion = "met" if result["success_criterion_met"] else "not met"
        lines.append(
            f"| `{baseline}` | {result['question_count']} | {avg_text} | {ci_text} | "
            f"{result['wins']}/{result['ties']}/{result['losses']} | {criterion} |"
        )
    lines.extend(["", "## Routing Mix", ""])
    for system, counts in summary.get("runner_counts", {}).items():
        count_text = ", ".join(f"{runner}: {count}" for runner, count in sorted(counts.items()))
        lines.append(f"- `{system}`: {count_text}")
    lines.extend(["", "## Latency", ""])
    for system, stats in summary.get("latency_ms", {}).items():
        lines.append(
            f"- `{system}`: p50={stats['p50']} ms, p95={stats['p95']} ms, mean={stats['mean']:.1f} ms"
            if stats["mean"] is not None else f"- `{system}`: n/a"
        )
    lines.extend(["", "## Category Breakdown", ""])
    for baseline, result in summary["pairwise"].items():
        lines.append(f"### modelnet_auto vs {baseline}")
        for category, value in result.get("category_average", {}).items():
            lines.append(f"- `{category}`: {value:.3f}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def parse_args() -> argparse.Namespace:
    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    parser = argparse.ArgumentParser(description="Run ModelNet Auto on MT-Bench with local pairwise judge.")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT)
    parser.add_argument("--models-endpoint", default=DEFAULT_MODELS_ENDPOINT)
    parser.add_argument("--judge-model", default=DEFAULT_JUDGE_MODEL)
    parser.add_argument("--question-file", default="benchmarks/data/mt_bench_question.jsonl")
    parser.add_argument("--output-dir", default=f"benchmarks/results/mtbench-{timestamp}")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--question-ids", default="")
    parser.add_argument("--candidate-aliases", default="")
    parser.add_argument("--answer-workers", type=int, default=2)
    parser.add_argument("--judge-workers", type=int, default=2)
    parser.add_argument("--max-tokens", type=int, default=768)
    parser.add_argument("--judge-max-tokens", type=int, default=512)
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--top-p", type=float, default=0.9)
    parser.add_argument("--max-auto-sources", type=int, default=3)
    parser.add_argument("--expert-max-tokens", type=int, default=384)
    parser.add_argument("--critic-max-tokens", type=int, default=256)
    parser.add_argument("--aggregation-max-tokens", type=int, default=768)
    parser.add_argument("--request-timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--retries", type=int, default=2)
    parser.add_argument("--judge-disable-thinking", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--force", action="store_true", help="Ignore existing answer/judgment JSONL records.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir)
    question_file = Path(args.question_file)
    answer_file = output_dir / "answers.jsonl"
    judgment_file = output_dir / "judgments.jsonl"
    summary_file = output_dir / "summary.json"
    report_file = output_dir / "report.md"

    question_ids = {int(item) for item in args.question_ids.split(",") if item.strip()} or None
    questions = load_questions(question_file, limit=args.limit, question_ids=question_ids)
    if not questions:
        raise RuntimeError("No MT-Bench questions selected")

    if args.candidate_aliases.strip():
        candidate_aliases = [item.strip() for item in args.candidate_aliases.split(",") if item.strip()]
    else:
        candidate_aliases = available_model_ids(args.models_endpoint, args.judge_model)
    args.candidate_aliases_resolved = candidate_aliases

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "run_config.json").write_text(
        json.dumps(
            {
                "created_at": utc8_now(),
                "args": vars(args),
                "candidate_aliases": candidate_aliases,
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        )
        + "\n",
        encoding="utf-8",
    )

    existing_answers = {} if args.force else {answer_key(item): item for item in read_jsonl(answer_file)}
    answer_jobs = [
        (question, system)
        for question in questions
        for system in SYSTEMS
        if (int(question["question_id"]), system) not in existing_answers
    ]
    print(f"[answers] selected_questions={len(questions)} existing={len(existing_answers)} pending={len(answer_jobs)}", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.answer_workers)) as executor:
        futures = {
            executor.submit(generate_answer_record, question, system, args, candidate_aliases): (question, system)
            for question, system in answer_jobs
        }
        for future in concurrent.futures.as_completed(futures):
            question, system = futures[future]
            record = future.result()
            append_jsonl(answer_file, record)
            existing_answers[answer_key(record)] = record
            print(
                f"[answer] q={question['question_id']} system={system} status={record['status']} "
                f"latency_ms={record['total_latency_ms']}",
                flush=True,
            )

    answer_records = list(existing_answers.values())
    answer_by_key = {answer_key(item): item for item in answer_records}
    existing_judgments = {} if args.force else {judgment_key(item): item for item in read_jsonl(judgment_file)}
    judgment_jobs = []
    for question in questions:
        qid = int(question["question_id"])
        auto_record = answer_by_key.get((qid, "modelnet_auto"))
        if not auto_record or auto_record.get("status") != "ok":
            continue
        for baseline in BASELINES:
            baseline_record = answer_by_key.get((qid, baseline))
            if not baseline_record or baseline_record.get("status") != "ok":
                continue
            for order in ("auto_first", "baseline_first"):
                key = (qid, baseline, order)
                if key not in existing_judgments:
                    judgment_jobs.append((question, auto_record, baseline_record, baseline, order))
    print(f"[judgments] existing={len(existing_judgments)} pending={len(judgment_jobs)}", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.judge_workers)) as executor:
        futures = {
            executor.submit(generate_judgment_record, question, auto, baseline_record, baseline, order, args): (
                question,
                baseline,
                order,
            )
            for question, auto, baseline_record, baseline, order in judgment_jobs
        }
        for future in concurrent.futures.as_completed(futures):
            question, baseline, order = futures[future]
            record = future.result()
            append_jsonl(judgment_file, record)
            existing_judgments[judgment_key(record)] = record
            print(
                f"[judge] q={question['question_id']} baseline={baseline} order={order} "
                f"status={record['status']} auto_score={record['auto_score']}",
                flush=True,
            )

    answer_records = list({answer_key(item): item for item in read_jsonl(answer_file)}.values())
    judgment_records = list({judgment_key(item): item for item in read_jsonl(judgment_file)}.values())
    summary = summarize(questions, answer_records, judgment_records, args)
    write_json(summary_file, summary)
    report_file.write_text(render_report(summary), encoding="utf-8")
    archive_router_trace(output_dir)
    write_manifest(output_dir)
    print(f"[done] output_dir={output_dir}", flush=True)
    print(json.dumps(summary["pairwise"], ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
