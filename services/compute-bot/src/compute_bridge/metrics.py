from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class UsageSummary:
    requests_today: int
    successful_today: int
    prompt_tokens: int | None
    completion_tokens: int | None
    total_tokens: int | None


class MetricsStore:
    """Small persistent operational ledger. Prompt and completion text are excluded."""

    def __init__(self, path: str | Path) -> None:
        destination = Path(path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(destination, check_same_thread=False)
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS herders (
                account TEXT PRIMARY KEY COLLATE NOCASE,
                owner_account TEXT NOT NULL,
                process_started_utc TEXT NOT NULL,
                connected_utc TEXT,
                last_seen_utc TEXT
            );
            CREATE TABLE IF NOT EXISTS requests (
                request_id TEXT PRIMARY KEY,
                herder_account TEXT NOT NULL,
                caller_account TEXT NOT NULL,
                provider TEXT NOT NULL,
                started_utc TEXT NOT NULL,
                duration_ms INTEGER,
                status TEXT,
                output_lines INTEGER,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                total_tokens INTEGER
            );
            CREATE TABLE IF NOT EXISTS agents (
                account TEXT PRIMARY KEY COLLATE NOCASE,
                herder_account TEXT NOT NULL,
                first_seen_utc TEXT NOT NULL,
                last_seen_utc TEXT NOT NULL
            );
            """
        )
        self._connection.commit()
        self._lock = threading.Lock()

    def register_herder(self, account: str, owner_account: str) -> None:
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO herders (
                    account, owner_account, process_started_utc, last_seen_utc
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(account) DO UPDATE SET
                    owner_account = excluded.owner_account,
                    process_started_utc = excluded.process_started_utc,
                    last_seen_utc = excluded.last_seen_utc
                """,
                (account, owner_account, utc_now(), utc_now()),
            )
            self._connection.commit()

    def connected(self, account: str) -> None:
        now = utc_now()
        with self._lock:
            self._connection.execute(
                "UPDATE herders SET connected_utc = ?, last_seen_utc = ? "
                "WHERE account = ?",
                (now, now, account),
            )
            self._connection.commit()

    def start_request(
        self,
        request_id: str,
        herder_account: str,
        caller_account: str,
        provider: str,
    ) -> None:
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO requests (
                    request_id, herder_account, caller_account, provider, started_utc
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (request_id, herder_account, caller_account, provider, utc_now()),
            )
            self._connection.commit()

    def finish_request(
        self,
        request_id: str,
        *,
        duration_ms: int,
        status: str,
        output_lines: int = 0,
        prompt_tokens: int | None = None,
        completion_tokens: int | None = None,
        total_tokens: int | None = None,
    ) -> None:
        with self._lock:
            self._connection.execute(
                """
                UPDATE requests SET duration_ms = ?, status = ?, output_lines = ?,
                    prompt_tokens = ?, completion_tokens = ?, total_tokens = ?
                WHERE request_id = ?
                """,
                (
                    duration_ms,
                    status,
                    output_lines,
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                    request_id,
                ),
            )
            self._connection.commit()

    def agent_seen(self, account: str, herder_account: str) -> None:
        now = utc_now()
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO agents (
                    account, herder_account, first_seen_utc, last_seen_utc
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT(account) DO UPDATE SET
                    herder_account = excluded.herder_account,
                    last_seen_utc = excluded.last_seen_utc
                """,
                (account, herder_account, now, now),
            )
            self._connection.commit()

    def agent_last_seen(self, account: str) -> str | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT last_seen_utc FROM agents WHERE account = ?", (account,)
            ).fetchone()
        return row[0] if row else None

    def summary(self, herder_account: str) -> UsageSummary:
        today = datetime.now(timezone.utc).date().isoformat()
        with self._lock:
            row = self._connection.execute(
                """
                SELECT COUNT(*),
                    SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END),
                    SUM(prompt_tokens), SUM(completion_tokens), SUM(total_tokens)
                FROM requests
                WHERE herder_account = ? AND substr(started_utc, 1, 10) = ?
                """,
                (herder_account, today),
            ).fetchone()
        return UsageSummary(
            requests_today=int(row[0] or 0),
            successful_today=int(row[1] or 0),
            prompt_tokens=int(row[2]) if row[2] is not None else None,
            completion_tokens=int(row[3]) if row[3] is not None else None,
            total_tokens=int(row[4]) if row[4] is not None else None,
        )

    def close(self) -> None:
        with self._lock:
            self._connection.close()
