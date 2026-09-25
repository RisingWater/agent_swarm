"""测试公共夹具。

AGENT_SWARM_DB 必须在任何 server 模块导入之前设置——db.py 在 import 时就
创建 engine（路径固化），放 conftest 顶部才能保证生效。测试一律用临时库，
绝不触碰 data/agent_swarm.db。
"""
import os
import tempfile
from datetime import datetime, timezone

import pytest

_TMP = tempfile.mkdtemp(prefix="agent-swarm-test-")
os.environ["AGENT_SWARM_DB"] = os.path.join(_TMP, "test.db")

from sqlmodel import Session  # noqa: E402  （必须在 env 设置之后导入 server 侧模块）

from server import models, mcp_endpoint  # noqa: E402
from server.db import engine, init_db  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def _db():
    init_db()
    with Session(engine) as s:
        s.add(
            models.User(
                id="u-test",
                username="tester",
                password_hash=models.hash_password("password123"),
                api_key_hash=models.hash_api_key("ak-test"),
                api_key="ak-test",
            )
        )
        s.commit()
    yield


@pytest.fixture()
def user() -> models.User:
    with Session(engine) as s:
        return s.get(models.User, "u-test")


@pytest.fixture()
def as_user(user):
    """把 contextvar 指到测试用户；测试结束还原。"""
    token = mcp_endpoint.current_user.set(user)
    yield user
    mcp_endpoint.current_user.reset(token)


@pytest.fixture()
def ws(as_user) -> models.Workspace:
    """一个属于测试用户的工作区（fresh heartbeat = online）。get-or-create：DB 跨模块持久。"""
    with Session(engine) as s:
        w = s.get(models.Workspace, "w-test")
        if w is None:
            w = models.Workspace(
                id="w-test",
                user_id=as_user.id,
                name="testws",
                path="/tmp/testws",
                status="online",
                last_heartbeat=datetime.now(timezone.utc).replace(tzinfo=None),
            )
            s.add(w)
        else:
            w.status = "online"
            w.last_heartbeat = datetime.now(timezone.utc).replace(tzinfo=None)
        s.add(w)
        s.commit()
        s.refresh(w)
        return w
