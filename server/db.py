import os
from pathlib import Path

from sqlmodel import SQLModel, create_engine

DB_PATH = os.environ.get(
    "AGENT_SWARM_DB",
    str(Path(__file__).resolve().parent.parent / "data" / "agent_swarm.db"),
)

engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})


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
        cols = {r[1] for r in con.execute("PRAGMA table_info(users)")}
        if "api_key" not in cols:
            con.execute("ALTER TABLE users ADD COLUMN api_key TEXT DEFAULT ''")
            con.commit()
    finally:
        con.close()


def get_session():
    from sqlmodel import Session

    with Session(engine) as session:
        yield session
