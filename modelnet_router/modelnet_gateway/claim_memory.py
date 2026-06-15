from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


STRONG_EVIDENCE_LEVELS = {"user_confirmed", "executable_checked", "source_grounded"}
INJECTABLE_STATUSES = {"verified"}
SIGNAL_STATUSES = {"contested"}
TOKEN_RE = re.compile(r"[a-zA-Z0-9_./:-]+|[\u4e00-\u9fff]{2,}")


@dataclass(frozen=True)
class ClaimRecord:
    claim_id: str
    scope: str
    text: str
    kind: str = "fact"
    status: str = "quarantine"
    evidence_level: str = "quarantine"
    entities: list[str] = field(default_factory=list)
    valid_from: float | None = None
    valid_to: float | None = None
    last_verified: float | None = None
    usage_count: int = 0
    score: float = 0.0

    def to_metadata(self) -> dict[str, Any]:
        return {
            "claim_id": self.claim_id,
            "scope": self.scope,
            "text": self.text,
            "kind": self.kind,
            "status": self.status,
            "evidence_level": self.evidence_level,
            "entities": self.entities,
            "valid_from": self.valid_from,
            "valid_to": self.valid_to,
            "last_verified": self.last_verified,
            "usage_count": self.usage_count,
            "score": round(self.score, 4),
        }


@dataclass(frozen=True)
class ClaimSearchResult:
    verified: list[ClaimRecord] = field(default_factory=list)
    contested: list[ClaimRecord] = field(default_factory=list)
    elapsed_ms: int = 0


class ClaimMemoryStore:
    def __init__(self, db_path: str | Path, *, timeout_ms: int = 50) -> None:
        self.db_path = Path(db_path)
        self.timeout_ms = max(1, int(timeout_ms))

    def _connect(self) -> sqlite3.Connection:
        if str(self.db_path) != ":memory:":
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self.db_path), timeout=self.timeout_ms / 1000)
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout = {self.timeout_ms}")
        return conn

    def ensure_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS claims (
                    claim_id TEXT PRIMARY KEY,
                    scope TEXT NOT NULL,
                    text TEXT NOT NULL,
                    kind TEXT NOT NULL DEFAULT 'fact',
                    status TEXT NOT NULL DEFAULT 'quarantine',
                    evidence_level TEXT NOT NULL DEFAULT 'quarantine',
                    entities TEXT NOT NULL DEFAULT '[]',
                    valid_from REAL,
                    valid_to REAL,
                    last_verified REAL,
                    usage_count INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_claims_scope_status
                    ON claims(scope, status, evidence_level);

                CREATE TABLE IF NOT EXISTS claim_votes (
                    vote_id TEXT PRIMARY KEY,
                    claim_id TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    vote TEXT NOT NULL,
                    blind INTEGER NOT NULL DEFAULT 0,
                    family TEXT,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS claim_events (
                    event_id TEXT PRIMARY KEY,
                    claim_id TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    evidence_level TEXT,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS claim_spans (
                    span_id TEXT PRIMARY KEY,
                    claim_id TEXT NOT NULL,
                    request_id TEXT,
                    source_id TEXT,
                    start_char INTEGER,
                    end_char INTEGER,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    created_at REAL NOT NULL
                );
                """
            )

    def upsert_claim(
        self,
        *,
        scope: str,
        text: str,
        claim_id: str | None = None,
        kind: str = "fact",
        status: str = "quarantine",
        evidence_level: str = "quarantine",
        entities: list[str] | None = None,
        valid_from: float | None = None,
        valid_to: float | None = None,
        last_verified: float | None = None,
    ) -> str:
        self.ensure_schema()
        now = time.time()
        clean_scope = str(scope or "").strip()
        clean_text = str(text or "").strip()
        if not clean_scope:
            raise ValueError("claim scope must not be blank")
        if not clean_text:
            raise ValueError("claim text must not be blank")
        stable_id = claim_id or stable_claim_id(clean_scope, clean_text)
        serialized_entities = json.dumps(entities or [], ensure_ascii=False)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO claims (
                    claim_id, scope, text, kind, status, evidence_level, entities,
                    valid_from, valid_to, last_verified, usage_count, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
                ON CONFLICT(claim_id) DO UPDATE SET
                    scope=excluded.scope,
                    text=excluded.text,
                    kind=excluded.kind,
                    status=excluded.status,
                    evidence_level=excluded.evidence_level,
                    entities=excluded.entities,
                    valid_from=excluded.valid_from,
                    valid_to=excluded.valid_to,
                    last_verified=excluded.last_verified,
                    updated_at=excluded.updated_at
                """,
                (
                    stable_id,
                    clean_scope,
                    clean_text,
                    kind,
                    status,
                    evidence_level,
                    serialized_entities,
                    valid_from,
                    valid_to,
                    last_verified or now if status == "verified" else last_verified,
                    now,
                    now,
                ),
            )
        return stable_id

    def record_vote(
        self,
        *,
        claim_id: str,
        source_id: str,
        vote: str,
        blind: bool,
        family: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        self.ensure_schema()
        vote_id = f"vote:{uuid.uuid4()}"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO claim_votes (
                    vote_id, claim_id, source_id, vote, blind, family, metadata, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    vote_id,
                    claim_id,
                    source_id,
                    vote,
                    1 if blind else 0,
                    family,
                    json.dumps(metadata or {}, ensure_ascii=False),
                    time.time(),
                ),
            )
        return vote_id

    def record_event(
        self,
        *,
        claim_id: str,
        event_type: str,
        evidence_level: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> str:
        self.ensure_schema()
        event_id = f"event:{uuid.uuid4()}"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO claim_events (
                    event_id, claim_id, event_type, evidence_level, metadata, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    claim_id,
                    event_type,
                    evidence_level,
                    json.dumps(metadata or {}, ensure_ascii=False),
                    time.time(),
                ),
            )
        return event_id

    def search_context(
        self,
        *,
        query_text: str,
        scopes: list[str],
        limit: int = 5,
    ) -> ClaimSearchResult:
        started = time.perf_counter()
        self.ensure_schema()
        unique_scopes = list(dict.fromkeys(str(scope).strip() for scope in scopes if str(scope).strip()))
        if not unique_scopes:
            return ClaimSearchResult(elapsed_ms=0)
        placeholders = ",".join("?" for _ in unique_scopes)
        max_rows = max(10, int(limit) * 8)
        sql = f"""
            SELECT *
            FROM claims
            WHERE scope IN ({placeholders})
              AND status IN ('verified', 'contested')
            ORDER BY COALESCE(last_verified, updated_at) DESC
            LIMIT ?
        """
        now = time.time()
        query_tokens = tokenize(query_text)
        with self._connect() as conn:
            rows = list(conn.execute(sql, [*unique_scopes, max_rows]))

        verified: list[ClaimRecord] = []
        contested: list[ClaimRecord] = []
        for row in rows:
            record = record_from_row(row)
            if record.valid_from is not None and record.valid_from > now:
                continue
            if record.valid_to is not None and record.valid_to < now:
                continue
            score = score_claim(record, query_tokens, query_text)
            if score <= 0:
                continue
            record = ClaimRecord(**{**record.__dict__, "score": score})
            if record.status in INJECTABLE_STATUSES and record.evidence_level in STRONG_EVIDENCE_LEVELS:
                verified.append(record)
            elif record.status in SIGNAL_STATUSES:
                contested.append(record)

        verified.sort(key=lambda item: (-item.score, -(item.last_verified or 0), item.claim_id))
        contested.sort(key=lambda item: (-item.score, -(item.last_verified or 0), item.claim_id))
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return ClaimSearchResult(
            verified=verified[:limit],
            contested=contested[:limit],
            elapsed_ms=elapsed_ms,
        )


def stable_claim_id(scope: str, text: str) -> str:
    digest = hashlib.sha256(f"{scope}\n{text}".encode("utf-8")).hexdigest()[:16]
    return f"claim:{digest}"


def tokenize(text: str) -> set[str]:
    return {match.group(0).lower() for match in TOKEN_RE.finditer(str(text or ""))}


def record_from_row(row: sqlite3.Row) -> ClaimRecord:
    try:
        entities = json.loads(row["entities"] or "[]")
    except json.JSONDecodeError:
        entities = []
    if not isinstance(entities, list):
        entities = []
    return ClaimRecord(
        claim_id=str(row["claim_id"]),
        scope=str(row["scope"]),
        text=str(row["text"]),
        kind=str(row["kind"]),
        status=str(row["status"]),
        evidence_level=str(row["evidence_level"]),
        entities=[str(item) for item in entities if item],
        valid_from=row["valid_from"],
        valid_to=row["valid_to"],
        last_verified=row["last_verified"],
        usage_count=int(row["usage_count"] or 0),
    )


def score_claim(record: ClaimRecord, query_tokens: set[str], query_text: str) -> float:
    claim_tokens = tokenize(record.text)
    entity_tokens = {token for entity in record.entities for token in tokenize(entity)}
    if not query_tokens:
        return 0.0
    overlap = query_tokens & (claim_tokens | entity_tokens)
    if not overlap:
        return 0.0
    denominator = max(1, min(len(query_tokens), len(claim_tokens | entity_tokens)))
    score = len(overlap) / denominator
    lowered_query = str(query_text or "").lower()
    for entity in record.entities:
        if str(entity).lower() in lowered_query:
            score += 0.25
    if record.kind in {"fact", "decision", "procedure"}:
        score += 0.05
    return score
