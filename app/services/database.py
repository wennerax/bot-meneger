import sqlite3
from datetime import datetime, timezone
from pathlib import Path


class Database:
    def __init__(self, path: str = "data/bot.sqlite3") -> None:
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        self._create_schema()

    def _create_schema(self) -> None:
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS groups (
                chat_id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                owner_id INTEGER,
                link_trigger INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS group_admins (
                chat_id INTEGER NOT NULL REFERENCES groups(chat_id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL,
                PRIMARY KEY (chat_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS punishments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                action TEXT NOT NULL,
                reason TEXT NOT NULL,
                until_at TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS blacklist (
                chat_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (chat_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS message_counts (
                chat_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                display_name TEXT NOT NULL,
                message_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (chat_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS group_users (
                chat_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                username TEXT,
                display_name TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                PRIMARY KEY (chat_id, user_id)
            );
            """
        )
        self.connection.commit()

    def ensure_group(self, chat_id: int, title: str, owner_id: int | None = None) -> None:
        self.connection.execute(
            """
            INSERT INTO groups(chat_id, title, owner_id, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,
                owner_id=COALESCE(excluded.owner_id, groups.owner_id)
            """,
            (chat_id, title, owner_id, self._now()),
        )
        if owner_id is not None:
            self.add_admin(chat_id, owner_id)
        self.connection.commit()

    def add_admin(self, chat_id: int, user_id: int) -> None:
        self.connection.execute(
            "INSERT OR IGNORE INTO group_admins(chat_id, user_id) VALUES (?, ?)",
            (chat_id, user_id),
        )
        self.connection.commit()

    def is_admin(self, chat_id: int, user_id: int, configured_admins: set[int]) -> bool:
        if user_id in configured_admins:
            return True
        row = self.connection.execute(
            "SELECT 1 FROM group_admins WHERE chat_id=? AND user_id=?", (chat_id, user_id)
        ).fetchone()
        return row is not None

    def record_message(
        self,
        chat_id: int,
        user_id: int,
        display_name: str,
        username: str | None = None,
    ) -> None:
        self.connection.execute(
            """
            INSERT INTO group_users(chat_id,user_id,username,display_name,last_seen_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(chat_id,user_id) DO UPDATE SET username=excluded.username,
                display_name=excluded.display_name, last_seen_at=excluded.last_seen_at
            """,
            (chat_id, user_id, username.casefold() if username else None, display_name, self._now()),
        )
        self.connection.execute(
            """
            INSERT INTO message_counts(chat_id, user_id, display_name, message_count)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(chat_id, user_id) DO UPDATE SET
                display_name=excluded.display_name, message_count=message_count + 1
            """,
            (chat_id, user_id, display_name),
        )
        self.connection.commit()

    def resolve_username(self, chat_id: int, username: str) -> tuple[int, str] | None:
        normalized = username.removeprefix("@").casefold()
        row = self.connection.execute(
            "SELECT user_id, display_name FROM group_users "
            "WHERE chat_id=? AND username=?",
            (chat_id, normalized),
        ).fetchone()
        return (row["user_id"], row["display_name"]) if row else None

    def top_messages(self, chat_id: int, limit: int = 10) -> list[sqlite3.Row]:
        return list(self.connection.execute(
            "SELECT display_name, message_count FROM message_counts "
            "WHERE chat_id=? ORDER BY message_count DESC LIMIT ?",
            (chat_id, limit),
        ))

    def set_link_trigger(self, chat_id: int, enabled: bool) -> None:
        self.connection.execute(
            "UPDATE groups SET link_trigger=? WHERE chat_id=?", (int(enabled), chat_id)
        )
        self.connection.commit()

    def link_trigger_enabled(self, chat_id: int) -> bool:
        row = self.connection.execute(
            "SELECT link_trigger FROM groups WHERE chat_id=?", (chat_id,)
        ).fetchone()
        return bool(row and row[0])

    def add_punishment(
        self,
        chat_id: int,
        user_id: int,
        action: str,
        reason: str,
        until_at: datetime | None,
    ) -> None:
        self.connection.execute(
            "INSERT INTO punishments(chat_id,user_id,action,reason,until_at,created_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (chat_id, user_id, action, reason, until_at.isoformat() if until_at else None, self._now()),
        )
        self.connection.commit()

    def add_blacklist(self, chat_id: int, user_id: int, reason: str) -> None:
        self.connection.execute(
            "INSERT OR REPLACE INTO blacklist(chat_id,user_id,reason,created_at) VALUES (?, ?, ?, ?)",
            (chat_id, user_id, reason, self._now()),
        )
        self.connection.commit()

    def is_blacklisted(self, chat_id: int, user_id: int) -> bool:
        return self.connection.execute(
            "SELECT 1 FROM blacklist WHERE chat_id=? AND user_id=?", (chat_id, user_id)
        ).fetchone() is not None

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    def close(self) -> None:
        self.connection.close()