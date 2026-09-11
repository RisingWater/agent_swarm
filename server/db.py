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


def get_session():
    from sqlmodel import Session

    with Session(engine) as session:
        yield session
