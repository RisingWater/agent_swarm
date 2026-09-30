"""团队 P2：跨用户 a2a_call / a2a_task 授权 / list_workspaces 共享项 / 调用记录双视角。

红线段：共享只授予调用权——调用方只拿最终答复，看不到监控/产物/调用细节。
"""
import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from server import crypto, models, mcp_endpoint
from server import nexus_a2a
from server.api import calls as calls_api
from server.api import teams as teams_api
from server.api import workspaces as ws_api
from server.db import engine


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _user(uid: str) -> models.User:
    with Session(engine) as s:
        return s.get(models.User, uid)


def _mk_ws(wid: str, uid: str, name: str, purpose: str = "") -> None:
    with Session(engine) as s:
        w = s.get(models.Workspace, wid)
        if w is None:
            w = models.Workspace(
                id=wid, user_id=uid, name=name, path=f"/tmp/{wid}", purpose=purpose,
                status="online", last_heartbeat=_now(),
            )
        else:
            w.status, w.last_heartbeat, w.purpose = "online", _now(), purpose
        s.add(w)
        s.commit()


@contextmanager
def acting_as(uid: str):
    """把 MCP current_user 指到指定用户（工具内 get_user() 读它）。"""
    with Session(engine) as s:
        u = s.get(models.User, uid)
    tok = mcp_endpoint.current_user.set(u)
    try:
        yield u
    finally:
        mcp_endpoint.current_user.reset(tok)


@pytest.fixture()
def tc_env():
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
    _mk_ws("w-bob", "u-bob", "bob-ws", purpose="bob 的用途")
    _mk_ws("w-carol", "u-carol", "carol-ws")
    yield


def _setup_shared() -> str:
    """alice 建 TeamX（open），bob 加入并把 w-bob 共享给 TeamX。返回 team_id。"""
    with Session(engine) as s:
        t = teams_api.create_team(
            {"name": "TeamX", "join_policy": "open"}, user=_user("u-alice"), session=s
        )
        teams_api.join_team(t["id"], user=_user("u-bob"), session=s)
        ws_api.set_workspace_shares("w-bob", {"team_ids": [t["id"]]}, user=_user("u-bob"), session=s)
        return t["id"]


def _cross_call() -> str:
    with acting_as("u-alice"):
        r = asyncio.run(
            mcp_endpoint.a2a_call(target="w-bob", message="hi", from_workspace="w-alice")
        )
    return r["task_id"]


# ---------------------------------------------------------------- 跨用户调用


def test_cross_user_call_owner_and_encryption(tc_env):
    _setup_shared()
    tk = _cross_call()
    with Session(engine) as s:
        t = s.get(models.A2aTask, tk)
        assert t.workspace_id == "w-bob"
        assert t.user_id == "u-bob"            # 执行方属主 = 加密/通知归属（简报、权限卡只到属主）
        assert t.from_user_id == "u-alice"     # 调用方（取件授权）
        assert t.from_workspace_id == "w-alice"
        assert crypto.decrypt("ak-bob", t.message_enc, t.message) == "hi"


def test_non_member_cannot_call(tc_env):
    _setup_shared()
    with acting_as("u-carol"):
        with pytest.raises(ValueError, match="not found or not visible"):
            asyncio.run(
                mcp_endpoint.a2a_call(target="w-bob", message="x", from_workspace="w-carol")
            )


def test_a2a_task_authorizes_caller_and_owner(tc_env):
    _setup_shared()
    tk = _cross_call()
    with Session(engine) as s:
        t = s.get(models.A2aTask, tk)
        t.status = "completed"
        t.artifact_enc = crypto.encrypt("ak-bob", "ANSWER")
        t.artifact = None
        s.add(t)
        s.commit()
    with acting_as("u-alice"):
        out = mcp_endpoint.a2a_task(task_id=tk)
    assert out["status"] == "completed" and out["result"] == "ANSWER"
    with acting_as("u-bob"):
        assert mcp_endpoint.a2a_task(task_id=tk)["result"] == "ANSWER"
    with acting_as("u-carol"):
        with pytest.raises(ValueError, match="not your task"):
            mcp_endpoint.a2a_task(task_id=tk)


def test_completion_reminder_cross_user(tc_env):
    _setup_shared()
    tk = _cross_call()
    with Session(engine) as s:
        t = s.get(models.A2aTask, tk)
        t.status, t.done_at = "completed", _now()
        s.add(t)
        s.commit()
    nexus_a2a._results_delivered.discard(tk)
    nexus_a2a._notified_tasks.discard(tk)
    asyncio.run(nexus_a2a._notify_caller_if_abandoned(tk))
    with Session(engine) as s:
        notes = s.exec(
            select(models.A2aTask)
            .where(models.A2aTask.caller == "nexus-notify")
            .where(models.A2aTask.workspace_id == "w-alice")
        ).all()
    assert len(notes) == 1
    text = crypto.decrypt("ak-alice", notes[0].message_enc, notes[0].message)
    assert tk in text


# ---------------------------------------------------------------- list_workspaces 共享项


def test_list_workspaces_exposes_shared_minimal(tc_env):
    _setup_shared()
    with acting_as("u-alice"):
        res = mcp_endpoint.list_workspaces()
    by_id = {w["workspace_id"]: w for w in res["workspaces"]}
    assert by_id["w-bob"]["shared"] is True
    assert by_id["w-bob"]["owner"] == "bob"
    assert by_id["w-bob"]["purpose"] == "bob 的用途"
    # 不暴露 path / notes（可见权不外泄）
    assert "path" not in by_id["w-bob"] and "notes" not in by_id["w-bob"]
    assert by_id["w-alice"]["shared"] is False
    # 非成员看不到
    with acting_as("u-carol"):
        res2 = mcp_endpoint.list_workspaces()
    assert "w-bob" not in {w["workspace_id"] for w in res2["workspaces"]}


# ---------------------------------------------------------------- 调用记录双视角


def test_calls_visible_both_sides(tc_env):
    _setup_shared()
    tk = _cross_call()
    with Session(engine) as s:
        a_calls = calls_api.list_calls("w-alice", user=_user("u-alice"), session=s)
        b_calls = calls_api.list_calls("w-bob", user=_user("u-bob"), session=s)
        c_calls = calls_api.list_calls("w-carol", user=_user("u-carol"), session=s)
    rec = next(c for c in a_calls if c["id"] == tk)
    assert rec["instruction"] == "hi"       # 指令可见
    assert rec["target"]["id"] == "w-bob"
    assert rec["caller"]["name"] == "alice-ws"
    assert any(c["id"] == tk for c in b_calls)   # 执行方也能看到
    assert all(c["id"] != tk for c in c_calls)   # 无关用户看不到


def test_delete_call_permission_and_flow(tc_env):
    _setup_shared()
    tk = _cross_call()
    with Session(engine) as s:
        with pytest.raises(HTTPException) as ei:
            calls_api.delete_call(tk, user=_user("u-carol"), session=s)
        assert ei.value.status_code == 403
        # 未终态不可删
        with pytest.raises(HTTPException) as ei2:
            calls_api.delete_call(tk, user=_user("u-alice"), session=s)
        assert ei2.value.status_code == 409
    with Session(engine) as s:
        t = s.get(models.A2aTask, tk)
        t.status, t.done_at = "completed", _now()
        s.add(t)
        s.commit()
    with Session(engine) as s:
        calls_api.delete_call(tk, user=_user("u-alice"), session=s)  # 发起方可删
        assert s.get(models.A2aTask, tk) is None
