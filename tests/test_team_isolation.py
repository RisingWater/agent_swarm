"""团队隔离红线回归：共享只给调用权，绝不给可见权。

- 团队成员不能订阅/收到被共享工作区的事件（Nexus 监控、通配推送都不行）
- visible_workspace_ids 仍是属主独占（调用记录/产物/Nexus 的口径）
"""
import asyncio
from datetime import datetime, timezone

import pytest
from sqlmodel import Session, select

from server import models, nexus_a2a, teams_service
from server.api import teams as teams_api
from server.api import workspaces as ws_api
from server.api.workspaces import visible_workspace_ids
from server.db import engine


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _user(uid: str) -> models.User:
    with Session(engine) as s:
        return s.get(models.User, uid)


def _mk_ws(wid: str, uid: str, name: str) -> None:
    with Session(engine) as s:
        w = s.get(models.Workspace, wid)
        if w is None:
            w = models.Workspace(
                id=wid, user_id=uid, name=name, path=f"/tmp/{wid}",
                status="online", last_heartbeat=_now(),
            )
        else:
            w.status, w.last_heartbeat = "online", _now()
        s.add(w)
        s.commit()


@pytest.fixture()
def iso_env():
    with Session(engine) as s:
        for m in s.exec(select(models.TeamMember)).all():
            s.delete(m)
        for sh in s.exec(select(models.TeamWorkspace)).all():
            s.delete(sh)
        for t in s.exec(select(models.Team)).all():
            s.delete(t)
        for uid, uname, ak in (
            ("u-alice", "alice", "ak-alice"),
            ("u-bob", "bob", "ak-bob"),
            ("u-carol", "carol", "ak-carol"),
        ):
            if s.get(models.User, uid) is None:
                s.add(
                    models.User(
                        id=uid, username=uname, password_hash=models.hash_password("pw"),
                        api_key_hash=models.hash_api_key(ak), api_key=ak,
                    )
                )
        s.commit()
    _mk_ws("w-alice", "u-alice", "alice-ws")
    _mk_ws("w-bob", "u-bob", "bob-ws")
    # bob 建团队 + alice 加入 + bob 把 w-bob 共享给团队
    with Session(engine) as s:
        t = teams_api.create_team(
            {"name": "Iso", "join_policy": "open"}, user=_user("u-bob"), session=s
        )
        teams_api.join_team(t["id"], user=_user("u-alice"), session=s)
        ws_api.set_workspace_shares("w-bob", {"team_ids": [t["id"]]}, user=_user("u-bob"), session=s)
    yield


def test_owns_is_owner_only_even_when_shared(iso_env):
    assert nexus_a2a._owns("u-bob", "w-bob") is True          # 属主
    assert nexus_a2a._owns("u-alice", "w-bob") is False       # 团队成员 ≠ 属主
    assert nexus_a2a._owns("u-carol", "w-bob") is False


def test_shared_not_in_visible_workspace_ids(iso_env):
    with Session(engine) as s:
        assert "w-bob" not in visible_workspace_ids(_user("u-alice"), s)
        assert "w-bob" in visible_workspace_ids(_user("u-bob"), s)
        # 对比：调用权为真，可见权为假 —— 红线的核心
        assert teams_service.can_invoke(s, "u-alice", "w-bob") is True


class _FakeWS:
    def __init__(self) -> None:
        self.sent: list[str] = []

    async def send_text(self, msg: str) -> None:
        self.sent.append(msg)


def test_wildcard_push_does_not_leak_shared_workspace(iso_env):
    """通配订阅（桌宠简报模式）也走 _owns：成员收不到被共享工作区的事件。"""
    fake = _FakeWS()
    conn = nexus_a2a.WebConn(ws=fake, user_id="u-alice")  # type: ignore[arg-type]
    conn.all_workspaces = True
    nexus_a2a.all_subscribers.add(conn)
    try:
        asyncio.run(nexus_a2a._push_web("w-bob", {"kind": "status-update", "taskId": "x"}))
        assert fake.sent == []  # alice 不是 w-bob 属主 → 通配也不泄漏
        asyncio.run(nexus_a2a._push_web("w-alice", {"kind": "status-update", "taskId": "y"}))
        assert len(fake.sent) == 1  # 自己的工作区照常收到
    finally:
        nexus_a2a.all_subscribers.discard(conn)
