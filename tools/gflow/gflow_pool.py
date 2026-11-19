"""GFlow Account Pool: Multi-account manager with rotation, failover & cross-process SQLite lease lock."""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, time as dt_time, timedelta, timezone
from pathlib import Path
from typing import Optional

try:
    import dotenv

    dotenv.load_dotenv()
except Exception:
    pass

logger = logging.getLogger(__name__)

TZ_UTC7 = timezone(timedelta(hours=7))
DEFAULT_LEASE_SECONDS = 600  # 10 minutes max lease per process


class AllAccountsExhaustedError(RuntimeError):
    """Raised when all accounts in the pool are quota-blocked, in cooldown, or locked."""


def _today_utc7() -> str:
    return datetime.now(TZ_UTC7).date().isoformat()


def _resolve_default_db_path() -> Path:
    env_path = os.getenv("GFLOW_POOL_DB_PATH")
    if env_path:
        return Path(env_path).resolve()
    data_root = os.getenv("KITLABS_DATA_ROOT")
    if data_root:
        return Path(data_root).resolve() / "gflow" / "gflow_pool.db"
    be_data = Path(__file__).resolve().parent.parent.parent / "data"
    if be_data.exists():
        return be_data / "gflow_pool.db"
    return Path(__file__).resolve().parent / "data" / "gflow_pool.db"


DEFAULT_DB_PATH = _resolve_default_db_path()


def get_account_priority(name: str) -> int:
    """Returns 1 (Primary), 2 (Backup), or 3 (Agent-only/Deprioritized)."""
    raw_backups = os.getenv("GFLOW_BACKUP_ACCOUNTS", "acc1,acc2")
    backup_set = {a.strip().lower() for a in raw_backups.split(",") if a.strip()}
    raw_tier3 = os.getenv("GFLOW_TIER3_ACCOUNTS", "acc3,acc5")
    tier3_set = {a.strip().lower() for a in raw_tier3.split(",") if a.strip()}

    clean_name = name.lower().removeprefix("profile_")
    if clean_name in tier3_set or name.lower() in tier3_set:
        return 3
    if clean_name in backup_set or name.lower() in backup_set:
        return 2
    return 1


class GFlowAccountPool:
    """Manages Google Flow accounts with priority tiers, LRU rotation, and cross-process SQLite locks."""

    def __init__(self, db_path: Optional[Path] = None):
        self.db_path = db_path or DEFAULT_DB_PATH
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, asyncio.Lock] = {}
        self._process_id = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self._init_db()

    @contextmanager
    def _get_conn(self, isolation_level: Optional[str] = ""):
        conn = sqlite3.connect(
            str(self.db_path),
            timeout=30.0,
            isolation_level=isolation_level,
            check_same_thread=False,
        )
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            if conn.in_transaction:
                conn.commit()
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.close()

    def _init_db(self) -> None:
        with self._get_conn() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS gflow_accounts (
                    name TEXT PRIMARY KEY,
                    email TEXT DEFAULT '',
                    priority INTEGER DEFAULT 1,
                    last_used_at REAL DEFAULT 0,
                    cooldown_until REAL DEFAULT 0,
                    limit_reason TEXT DEFAULT '',
                    quota_blocked_until REAL DEFAULT 0,
                    quota_reason TEXT DEFAULT '',
                    locked_until REAL DEFAULT 0,
                    locked_by TEXT DEFAULT ''
                )
                """
            )
            cols = [row[1] for row in conn.execute("PRAGMA table_info(gflow_accounts)").fetchall()]
            if "priority" not in cols:
                conn.execute("ALTER TABLE gflow_accounts ADD COLUMN priority INTEGER DEFAULT 1")
            if "locked_until" not in cols:
                conn.execute("ALTER TABLE gflow_accounts ADD COLUMN locked_until REAL DEFAULT 0")
            if "locked_by" not in cols:
                conn.execute("ALTER TABLE gflow_accounts ADD COLUMN locked_by TEXT DEFAULT ''")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS gflow_usage (
                    account TEXT,
                    day TEXT,
                    used_count INTEGER DEFAULT 0,
                    PRIMARY KEY(account, day)
                )
                """
            )

    def _get_lock(self, profile_name: str) -> asyncio.Lock:
        if profile_name not in self._locks:
            self._locks[profile_name] = asyncio.Lock()
        return self._locks[profile_name]

    def _next_day_reset_timestamp(self) -> float:
        now = datetime.now(TZ_UTC7)
        tomorrow = now.date() + timedelta(days=1)
        return datetime.combine(tomorrow, dt_time.min, tzinfo=TZ_UTC7).timestamp()

    def sync_profiles(self) -> list[str]:
        """Discovers existing profiles from gflow_cli.profile_store and syncs to DB."""
        try:
            from gflow_cli.profile_store import list_profiles

            discovered = list_profiles()
            profile_names = [p.name for p in discovered]
        except Exception as exc:
            logger.debug("Failed to list profiles from gflow_cli: %s", exc)
            return []

        if not profile_names:
            return []

        with self._get_conn() as conn:
            placeholders = ",".join("?" * len(profile_names))
            conn.execute(f"DELETE FROM gflow_accounts WHERE name NOT IN ({placeholders})", profile_names)
            for p in discovered:
                priority = get_account_priority(p.name)
                conn.execute(
                    """
                    INSERT INTO gflow_accounts (name, email, priority, last_used_at)
                    VALUES (?, ?, ?, 0)
                    ON CONFLICT(name) DO UPDATE SET email=excluded.email, priority=excluded.priority
                    """,
                    (p.name, p.google_account or "", priority),
                )
        return profile_names

    def get_available_profiles_count(self) -> int:
        return len(self.sync_profiles())

    def _clear_expired_restrictions(self, conn: sqlite3.Connection) -> None:
        now = time.time()
        conn.execute(
            "UPDATE gflow_accounts SET cooldown_until=0, limit_reason='' WHERE cooldown_until > 0 AND cooldown_until <= ?",
            (now,),
        )
        conn.execute(
            "UPDATE gflow_accounts SET quota_blocked_until=0, quota_reason='' WHERE quota_blocked_until > 0 AND quota_blocked_until <= ?",
            (now,),
        )
        conn.execute(
            "UPDATE gflow_accounts SET locked_until=0, locked_by='' WHERE locked_until > 0 AND locked_until <= ?",
            (now,),
        )

    async def acquire_profile(
        self,
        exclude: Optional[set[str]] = None,
        lease_seconds: int = DEFAULT_LEASE_SECONDS,
    ) -> Optional[str]:
        """Selects and locks the best available profile (Tier ASC, LRU ASC) across processes."""
        exclude_set = exclude or set()
        profiles = self.sync_profiles()
        if not profiles:
            return None

        now = time.time()
        selected: Optional[str] = None

        with self._get_conn(isolation_level=None) as conn:
            conn.execute("BEGIN IMMEDIATE")
            self._clear_expired_restrictions(conn)
            rows = conn.execute(
                """
                SELECT name, priority, last_used_at
                FROM gflow_accounts
                WHERE cooldown_until <= ? AND quota_blocked_until <= ? AND locked_until <= ?
                ORDER BY priority ASC, last_used_at ASC
                """,
                (now, now, now),
            ).fetchall()

            candidates = [r["name"] for r in rows if r["name"] not in exclude_set and r["name"] in profiles]
            for cand in candidates:
                lock = self._get_lock(cand)
                if not lock.locked():
                    await lock.acquire()
                    selected = cand
                    break

            if selected:
                conn.execute(
                    "UPDATE gflow_accounts SET last_used_at=?, locked_until=?, locked_by=? WHERE name=?",
                    (now, now + lease_seconds, self._process_id, selected),
                )
            conn.execute("COMMIT")

        if selected:
            logger.info("[GFlowAccountPool] Leased profile '%s' (candidates=%d)", selected, len(candidates))
        return selected

    def release_profile(self, profile_name: Optional[str]) -> None:
        if not profile_name:
            return
        with self._get_conn() as conn:
            conn.execute(
                "UPDATE gflow_accounts SET locked_until=0, locked_by='' WHERE name=? AND locked_by=?",
                (profile_name, self._process_id),
            )
        lock = self._locks.get(profile_name)
        if lock and lock.locked():
            lock.release()

    def record_usage(self, profile_name: Optional[str]) -> None:
        if not profile_name:
            return
        today_str = _today_utc7()
        with self._get_conn() as conn:
            conn.execute(
                """
                INSERT INTO gflow_usage (account, day, used_count)
                VALUES (?, ?, 1)
                ON CONFLICT(account, day) DO UPDATE SET used_count=used_count+1
                """,
                (profile_name, today_str),
            )

    def mark_quota_blocked(self, profile_name: str, reason: str = "") -> None:
        if not profile_name:
            return
        reset_ts = self._next_day_reset_timestamp()
        with self._get_conn() as conn:
            conn.execute(
                """
                UPDATE gflow_accounts
                SET quota_blocked_until=?, quota_reason=?, last_used_at=?
                WHERE name=?
                """,
                (reset_ts, reason[:250], time.time(), profile_name),
            )

    def mark_rate_limited(self, profile_name: str, cooldown_seconds: int = 600, reason: str = "") -> None:
        if not profile_name:
            return
        cooldown_until = time.time() + cooldown_seconds
        with self._get_conn() as conn:
            conn.execute(
                """
                UPDATE gflow_accounts
                SET cooldown_until=?, limit_reason=?, last_used_at=?
                WHERE name=?
                """,
                (cooldown_until, reason[:250], time.time(), profile_name),
            )

    def reset_restrictions(self, profile_name: Optional[str] = None) -> list[str]:
        with self._get_conn() as conn:
            if profile_name and profile_name.lower() != "all":
                clean_name = profile_name.lower().removeprefix("profile_")
                rows = conn.execute(
                    "SELECT name FROM gflow_accounts WHERE name=? OR name=?",
                    (profile_name, clean_name),
                ).fetchall()
                target_names = [r["name"] for r in rows]
                if target_names:
                    placeholders = ",".join("?" * len(target_names))
                    conn.execute(
                        f"""
                        UPDATE gflow_accounts
                        SET quota_blocked_until=0, quota_reason='', cooldown_until=0, limit_reason='', locked_until=0, locked_by=''
                        WHERE name IN ({placeholders})
                        """,
                        target_names,
                    )
            else:
                rows = conn.execute("SELECT name FROM gflow_accounts").fetchall()
                target_names = [r["name"] for r in rows]
                conn.execute(
                    """
                    UPDATE gflow_accounts
                    SET quota_blocked_until=0, quota_reason='', cooldown_until=0, limit_reason='', locked_until=0, locked_by=''
                    """
                )
        return target_names

    def reset_daily_usage(self, day: Optional[str] = None, profile_name: Optional[str] = None) -> int:
        target_day = day or _today_utc7()
        with self._get_conn() as conn:
            if profile_name and profile_name.lower() != "all":
                clean_name = profile_name.lower().removeprefix("profile_")
                cursor = conn.execute(
                    "DELETE FROM gflow_usage WHERE (account=? OR account=?) AND day=?",
                    (profile_name, clean_name, target_day),
                )
            else:
                cursor = conn.execute("DELETE FROM gflow_usage WHERE day=?", (target_day,))
            return cursor.rowcount

    def get_pool_status_summary(self) -> dict:
        profiles = self.sync_profiles()
        now = time.time()
        today_str = _today_utc7()
        with self._get_conn() as conn:
            self._clear_expired_restrictions(conn)
            rows = conn.execute(
                """
                SELECT a.name, a.email, a.priority, a.last_used_at,
                       a.cooldown_until, a.limit_reason,
                       a.quota_blocked_until, a.quota_reason,
                       a.locked_until,
                       COALESCE(u.used_count, 0) AS used_today
                FROM gflow_accounts a
                LEFT JOIN gflow_usage u ON u.account = a.name AND u.day = ?
                ORDER BY a.priority ASC, a.name ASC
                """,
                (today_str,),
            ).fetchall()

        available: list[str] = []
        blocked: list[str] = []
        accounts: list[dict] = []

        for r in rows:
            if r["name"] not in profiles:
                continue
            is_quota = r["quota_blocked_until"] > now
            is_cooldown = r["cooldown_until"] > now
            is_locked = r["locked_until"] > now
            if is_quota:
                status = "quota_blocked"
                blocked.append(r["name"])
            elif is_cooldown:
                status = "cooldown"
                blocked.append(r["name"])
            elif is_locked:
                status = "busy"
                available.append(r["name"])
            else:
                status = "available"
                available.append(r["name"])

            accounts.append(
                {
                    "name": r["name"],
                    "email": r["email"] or "",
                    "priority": r["priority"],
                    "status": status,
                    "usedToday": r["used_today"],
                    "lastUsedAt": r["last_used_at"],
                    "cooldownUntil": r["cooldown_until"] if is_cooldown else 0,
                    "limitReason": r["limit_reason"] if is_cooldown else "",
                    "quotaBlockedUntil": r["quota_blocked_until"] if is_quota else 0,
                    "quotaReason": r["quota_reason"] if is_quota else "",
                }
            )

        return {
            "total": len(accounts),
            "available_count": len(available),
            "available_profiles": available,
            "blocked_count": len(blocked),
            "blocked_profiles": blocked,
            "accounts": accounts,
        }


gflow_account_pool = GFlowAccountPool()
