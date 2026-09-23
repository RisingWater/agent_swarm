import os
from pathlib import Path

from sqlalchemy import event
from sqlmodel import SQLModel, create_engine

DB_PATH = os.environ.get(
    "AGENT_SWARM_DB",
    str(Path(__file__).resolve().parent.parent / "data" / "agent_swarm.db"),
)

# 池参数放宽（2026-09-23 冻死事故修复）：默认 QueuePool 只有 5+10=15 个连接，
# 多个 opencode 同时重启（MCP 风暴 + 插件 WS 重连 + monitor 事件）时 72s 内即耗尽；
# 连接耗尽后同步 SQLite 取连接会阻塞事件循环（连 /health 都超时）。
engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False, "timeout": 30},
    pool_size=10,
    max_overflow=20,
    pool_timeout=30,
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record) -> None:
    """每个新连接都挂 WAL + busy_timeout（2026-09-23 事故修复）。

    - WAL：读写不互锁，monitor 事件高频写不再堵住读请求
    - busy_timeout=30s：写锁冲突时等锁而不是立刻 "database is locked"
    - synchronous=NORMAL：WAL 下安全且比 FULL 快
    """
    cur = dbapi_conn.cursor()
    try:
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.execute("PRAGMA synchronous=NORMAL")
    finally:
        cur.close()


def init_db() -> None:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    import server.models  # noqa: F401  确保表模型已注册

    SQLModel.metadata.create_all(engine)
    _migrate()


def _migrate() -> None:
    """轻量迁移：SQLite 加列（存在即跳过）。"""
    import sqlite3

    con = sqlite3.connect(DB_PATH)
    try:
        # 旧机制表已废弃：help_requests（第一代求助）、workspace_calls/nexus_events（自定义协议，
        # 已被 A2A 协议取代），直接清掉
        for legacy in ("help_requests", "workspace_calls", "nexus_events"):
            con.execute(f"DROP TABLE IF EXISTS {legacy}")
        cols = {r[1] for r in con.execute("PRAGMA table_info(users)")}
        if "api_key" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN api_key TEXT DEFAULT ''")
        ws_cols = {r[1] for r in con.execute("PRAGMA table_info(workspaces)")}
        if "agent_type" not in ws_cols:
            con.execute("ALTER TABLE workspaces ADD COLUMN agent_type TEXT DEFAULT ''")
        if "session_title" not in ws_cols:
            con.execute("ALTER TABLE workspaces ADD COLUMN session_title TEXT DEFAULT ''")
        # 内容加密列（server/crypto.py；ENC_KEY 未配置时始终为 NULL）
        for c in ("purpose_enc", "notes_enc", "session_title_enc"):
            if c not in ws_cols:
                con.execute(f"ALTER TABLE workspaces ADD COLUMN {c} TEXT")
        if "a2a_events" in {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
            ev_cols = {r[1] for r in con.execute("PRAGMA table_info(a2a_events)")}
            if "round_key" not in ev_cols:
                con.execute("ALTER TABLE a2a_events ADD COLUMN round_key TEXT DEFAULT ''")
            if "user_id" not in ev_cols:
                con.execute("ALTER TABLE a2a_events ADD COLUMN user_id TEXT DEFAULT ''")
            if "payload_enc" not in ev_cols:
                con.execute("ALTER TABLE a2a_events ADD COLUMN payload_enc TEXT")
        if "feishu_chats" in {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
            chat_cols = {r[1] for r in con.execute("PRAGMA table_info(feishu_chats)")}
            if "brief_on" not in chat_cols:
                con.execute("ALTER TABLE feishu_chats ADD COLUMN brief_on INTEGER DEFAULT 1")
        if "a2a_tasks" in {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
            task_cols = {r[1] for r in con.execute("PRAGMA table_info(a2a_tasks)")}
            if "from_workspace_id" not in task_cols:
                con.execute("ALTER TABLE a2a_tasks ADD COLUMN from_workspace_id TEXT DEFAULT ''")
            if "user_id" not in task_cols:
                con.execute("ALTER TABLE a2a_tasks ADD COLUMN user_id TEXT DEFAULT ''")
            for c in ("message_enc", "artifact_enc", "error_enc"):
                if c not in task_cols:
                    con.execute(f"ALTER TABLE a2a_tasks ADD COLUMN {c} TEXT")
        # 旧用户没有明文（哈希不可逆）：补发新 key，旧 key 立即失效
        from server import models

        for uid, old_hash in con.execute(
            "SELECT id, api_key_hash FROM users WHERE api_key = '' OR api_key IS NULL"
        ).fetchall():
            new_key = models.new_api_key()
            con.execute(
                "UPDATE users SET api_key = ?, api_key_hash = ? WHERE id = ?",
                (new_key, models.hash_api_key(new_key), uid),
            )
        con.commit()
    finally:
        con.close()
    # 启用加密时把存量明文回填成密文并清空明文列（幂等；在 _migrate 之后、首次请求之前）
    from server import crypto

    if crypto.enabled():
        _backfill_encrypted()


def _backfill_encrypted() -> None:
    """存量明文 → 密文回填（决策 a：启用加密后历史明文就地加密并清空）。

    - workspaces 按 user_id 取 apikey；a2a_tasks/events 优先行上 user_id，
      否则回退 workspace→user；两样都没有（外部任务）保持明文不动
    - 幂等：*_enc 已非空的行跳过（解密失败也跳过，避免用错密钥覆盖）
    """
    import sqlite3

    from server import crypto

    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    try:
        apikeys = {uid: ak for uid, ak in con.execute("SELECT id, api_key FROM users")}
        ws_owner = {wid: uid for wid, uid in con.execute("SELECT id, user_id FROM workspaces")}

        def key_for(uid: str, wid: str) -> str:
            return apikeys.get(uid or ws_owner.get(wid, ""), "")

        # (table, plain_col, enc_col, id_col, owner_user_col, workspace_col)
        jobs = [
            ("workspaces", "purpose", "purpose_enc", "id", "user_id", None),
            ("workspaces", "notes", "notes_enc", "id", "user_id", None),
            ("workspaces", "session_title", "session_title_enc", "id", "user_id", None),
            ("a2a_tasks", "message", "message_enc", "id", "user_id", "workspace_id"),
            ("a2a_tasks", "artifact", "artifact_enc", "id", "user_id", "workspace_id"),
            ("a2a_tasks", "error", "error_enc", "id", "user_id", "workspace_id"),
            ("a2a_events", "payload", "payload_enc", "id", "user_id", "workspace_id"),
        ]
        for table, pcol, ecol, idcol, ucol, wcol in jobs:
            cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
            if pcol not in cols or ecol not in cols:
                continue
            rows = con.execute(
                f"SELECT {idcol}, {ucol}, {wcol or 'NULL'} AS wcol2, {pcol}, {ecol} "
                f"FROM {table} WHERE ({ecol} IS NULL OR {ecol} = '') AND {pcol} IS NOT NULL AND {pcol} != ''"
            ).fetchall()
            for row in rows:
                ak = key_for(row[1], row[2] or "")
                enc = crypto.encrypt(ak, row[3]) if ak else None
                if not enc:
                    continue  # 无属主（外部任务）/未启用：保留明文，读侧回退可读
                con.execute(
                    f"UPDATE {table} SET {ecol} = ?, {pcol} = '' WHERE {idcol} = ?",
                    (enc, row[0]),
                )
        con.commit()
    finally:
        con.close()


def get_session():
    from sqlmodel import Session

    with Session(engine) as session:
        yield session
