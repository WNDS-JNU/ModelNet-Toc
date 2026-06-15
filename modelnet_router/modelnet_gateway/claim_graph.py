from __future__ import annotations

import hashlib
import json
import re
from typing import Any


CLAIM_EXTRACTOR_SYSTEM_PROMPT = (
    "You extract atomic, checkable claims from a draft answer. Return only JSON. "
    "Skip opinions, style judgments, and instructions. Do not include hidden reasoning."
)

CLAIM_VERIFIER_SYSTEM_PROMPT = (
    "You verify one claim question for a claim graph. Return only compact JSON. "
    "Use supported, refuted, or unknown. Do not include hidden reasoning."
)


def stable_frontier_id(text: str) -> str:
    digest = hashlib.sha256(str(text or "").strip().lower().encode("utf-8")).hexdigest()[:12]
    return f"frontier:{digest}"


def normalize_text(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def token_set(text: str) -> set[str]:
    return set(re.findall(r"[a-zA-Z0-9_./:-]+|[\u4e00-\u9fff]{2,}", normalize_text(text).lower()))


def overlap_score(left: str, right: str) -> float:
    left_tokens = token_set(left)
    right_tokens = token_set(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / max(1, min(len(left_tokens), len(right_tokens)))


def build_extractor_prompt(
    *,
    original_prompt: str,
    draft_text: str,
    injected_claims: list[dict[str, Any]],
    contested_claims: list[dict[str, Any]],
    max_claims: int,
) -> str:
    injected = "\n".join(f"- {claim.get('claim_id')}: {claim.get('text')}" for claim in injected_claims) or "none"
    contested = "\n".join(f"- {claim.get('claim_id')}: {claim.get('text')}" for claim in contested_claims) or "none"
    return "\n".join(
        [
            "Original user request:",
            normalize_text(original_prompt),
            "",
            "Verified claims injected into the draft context:",
            injected,
            "",
            "Contested claims available as warning signals:",
            contested,
            "",
            "Draft answer:",
            draft_text,
            "",
            "Extract at most "
            + str(max(1, int(max_claims)))
            + " factual, checkable claims from the draft answer.",
            "Return JSON with this shape:",
            '{"claims":[{"text":"atomic claim","question":"verification question","risk":"low|medium|high"}]}',
        ]
    )


def parse_claim_extraction(raw_text: str) -> tuple[list[dict[str, Any]], str]:
    payload, error = parse_json_object(raw_text)
    if error:
        return [], error
    raw_claims = payload.get("claims") if isinstance(payload, dict) else None
    if not isinstance(raw_claims, list):
        return [], "claims_not_list"
    claims: list[dict[str, Any]] = []
    for item in raw_claims:
        if not isinstance(item, dict):
            continue
        text = normalize_text(item.get("text") or item.get("claim") or "")
        if not text:
            continue
        question = normalize_text(item.get("question") or f"Is this claim correct: {text}")
        risk = str(item.get("risk") or "medium").strip().lower()
        if risk not in {"low", "medium", "high"}:
            risk = "medium"
        claims.append(
            {
                "frontier_id": stable_frontier_id(text),
                "text": text,
                "question": question,
                "risk": risk,
            }
        )
    return claims, ""


def parse_json_object(raw_text: str) -> tuple[dict[str, Any], str]:
    text = str(raw_text or "").strip()
    if not text:
        return {}, "empty_json"
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return {}, "invalid_json"
        try:
            payload = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return {}, "invalid_json"
    if not isinstance(payload, dict):
        return {}, "json_not_object"
    return payload, ""


def build_frontier(
    *,
    extracted_claims: list[dict[str, Any]],
    injected_claims: list[dict[str, Any]],
    contested_claims: list[dict[str, Any]],
    limit: int,
) -> list[dict[str, Any]]:
    frontier: list[dict[str, Any]] = []
    for claim in extracted_claims:
        text = str(claim.get("text") or "")
        matched_injected = best_match(text, injected_claims)
        matched_contested = best_match(text, contested_claims)
        status = "novel"
        blind_allowed = True
        matched_claim_id = None
        if matched_contested is not None:
            status = "contested"
            matched_claim_id = matched_contested.get("claim_id")
        elif matched_injected is not None:
            status = "supported_by_memory"
            matched_claim_id = matched_injected.get("claim_id")
            blind_allowed = False
        frontier.append(
            {
                **claim,
                "status": status,
                "matched_claim_id": matched_claim_id,
                "blind_allowed": blind_allowed,
            }
        )
    frontier.sort(
        key=lambda item: (
            0 if item.get("status") == "contested" else 1,
            0 if item.get("risk") == "high" else 1 if item.get("risk") == "medium" else 2,
            str(item.get("frontier_id") or ""),
        )
    )
    return frontier[: max(0, int(limit))]


def best_match(text: str, claims: list[dict[str, Any]]) -> dict[str, Any] | None:
    best: tuple[float, dict[str, Any] | None] = (0.0, None)
    for claim in claims:
        score = overlap_score(text, str(claim.get("text") or ""))
        if score > best[0]:
            best = (score, claim)
    return best[1] if best[0] >= 0.55 else None


def build_verifier_prompt(
    *,
    original_prompt: str,
    frontier_claim: dict[str, Any],
) -> str:
    return "\n".join(
        [
            "Original user request:",
            normalize_text(original_prompt),
            "",
            "Verification question:",
            normalize_text(frontier_claim.get("question") or ""),
            "",
            "Return JSON only:",
            '{"verdict":"supported|refuted|unknown","confidence":0.0,"reason":"short reason"}',
        ]
    )


def parse_verifier_vote(raw_text: str) -> dict[str, Any]:
    payload, error = parse_json_object(raw_text)
    verdict = "unknown"
    confidence = 0.0
    reason = ""
    if not error:
        verdict = str(payload.get("verdict") or payload.get("answer") or "unknown").strip().lower()
        if verdict in {"yes", "true", "correct", "support"}:
            verdict = "supported"
        elif verdict in {"no", "false", "incorrect", "refute"}:
            verdict = "refuted"
        if verdict not in {"supported", "refuted", "unknown"}:
            verdict = "unknown"
        try:
            confidence = max(0.0, min(1.0, float(payload.get("confidence") or 0.0)))
        except (TypeError, ValueError):
            confidence = 0.0
        reason = normalize_text(payload.get("reason") or "")[:300]
    return {
        "verdict": verdict,
        "confidence": round(confidence, 3),
        "reason": reason,
        "parse_error": error,
        "raw": str(raw_text or "")[:500],
    }


def assemble_claim_graph_answer(
    *,
    draft_text: str,
    frontier: list[dict[str, Any]],
    votes: list[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]]]:
    actions: list[dict[str, Any]] = []
    vote_by_frontier = {str(vote.get("frontier_id") or ""): vote for vote in votes}
    refuted = {
        str(vote.get("frontier_id"))
        for vote in votes
        if vote.get("verdict") == "refuted" and float(vote.get("confidence") or 0.0) >= 0.6
    }
    supported = {
        str(vote.get("frontier_id"))
        for vote in votes
        if vote.get("verdict") == "supported" and float(vote.get("confidence") or 0.0) >= 0.6
    }
    unknown = {
        str(vote.get("frontier_id"))
        for vote in votes
        if vote.get("verdict") == "unknown" or vote.get("parse_error")
    }
    for claim in frontier:
        frontier_id = str(claim.get("frontier_id") or "")
        if frontier_id in refuted:
            actions.append(
                {
                    "frontier_id": frontier_id,
                    "action": "hedge_refuted_claim",
                    "claim": claim.get("text"),
                }
            )
        elif frontier_id in supported:
            actions.append(
                {
                    "frontier_id": frontier_id,
                    "action": "keep_supported_claim",
                    "claim": claim.get("text"),
                }
            )
        elif frontier_id in unknown or frontier_id in vote_by_frontier:
            actions.append(
                {
                    "frontier_id": frontier_id,
                    "action": "withhold_unverified_claim",
                    "claim": claim.get("text"),
                }
            )
        else:
            actions.append(
                {
                    "frontier_id": frontier_id,
                    "action": "unverified_no_vote",
                    "claim": claim.get("text"),
                }
            )
    if votes and not supported and (unknown or refuted):
        return (
            "I do not have enough verified evidence to answer that factual detail reliably.",
            actions,
        )
    if not refuted and not unknown:
        return draft_text, actions
    warning = (
        "\n\nNote: One generated detail was not confirmed by the verifier; treat that part cautiously."
    )
    return draft_text.rstrip() + warning, actions
