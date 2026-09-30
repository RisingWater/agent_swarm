"""团队功能 P1：模型 / 数量限制 / 团队 REST / 工作区共享 / 访问控制。

红线段：共享只授予"调用权（can_invoke）"，**不**并入 visible_workspace_ids——
团队成员仍看不到对方的监控/Nexus/产物/调用记录。
"""
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from server import models, teams_service
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
        if s.get(models.Workspace, wid) is None:
            s.add(
                models.Workspace(
                    id=wid, user_id=uid, name=name, path=f"/tmp/{wid}",
                    status="online", last_heartbeat=_now(),
                )
            )
        s.commit()


@pytest.fixture()
def env():
    """清空团队相关表 + 保证 alice/bob/carol 三个用户存在；各工作区按需建。"""
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
    return {"alice": _user("u-alice"), "bob": _user("u-bob"), "carol": _user("u-carol")}


def _create(session: Session, user: models.User, name: str, policy: str = "approval") -> dict:
    return teams_api.create_team({"name": name, "join_policy": policy}, user=user, session=session)


# ---------------------------------------------------------------- 创建 / 数量限制


def test_create_team_leader_is_active_member(env):
    with Session(engine) as s:
        out = _create(s, env["alice"], "T1")
    assert out["is_leader"] is True
    assert out["member_count"] == 1
    with Session(engine) as s:
        assert teams_service.is_active_member(s, out["id"], "u-alice")


def test_owned_limit(env, monkeypatch):
    monkeypatch.setenv("AGENT_SWARM_TEAM_MAX_OWNED", "2")
    with Session(engine) as s:
        _create(s, env["alice"], "T1")
        _create(s, env["alice"], "T2")
        with pytest.raises(teams_service.TeamError):
            _create(s, env["alice"], "T3")


def test_team_name_unique(env):
    with Session(engine) as s:
        _create(s, env["alice"], "Dup")
        with pytest.raises(HTTPException) as ei:
            _create(s, env["bob"], "Dup")
    assert ei.value.status_code == 409


# ---------------------------------------------------------------- 邀请 / 申请 / 审批


def test_invite_then_accept(env):
    with Session(engine) as s:
        t = _create(s, env["alice"], "T")
        teams_api.invite_member(t["id"], {"username": "bob"}, user=env["alice"], session=s)
        # 待接受：bob 还不是成员
        assert teams_service.is_active_member(s, t["id"], "u-bob") is False
        inv = teams_api.my_invitations(user=env["bob"], session=s)
        assert len(inv["invites"]) == 1 and inv["invites"][0]["team"]["id"] == t["id"]
        teams_api.decide_membership(t["id"], "u-bob", {"action": "accept"}, user=env["bob"], session=s)
        assert teams_service.is_active_member(s, t["id"], "u-bob") is True


def test_invite_requires_leader(env):
    with Session(engine) as s:
        t = _create(s, env["alice"], "T")
        with pytest.raises(HTTPException) as ei:
            teams_api.invite_member(t["id"], {"username": "carol"}, user=env["bob"], session=s)
    assert ei.value.status_code == 403


def test_join_request_approve(env):
    with Session(engine) as s:
        t = _create(s, env["alice"], "T")
        teams_api.join_team(t["id"], user=env["bob"], session=s)  # approval → pending
        assert teams_service.is_active_member(s, t["id"], "u-bob") is False
        reqs = teams_api.my_invitations(user=env["alice"], session=s)["requests"]
        assert len(reqs) == 1 and reqs[0]["user"]["id"] == "u-bob"
        teams_api.decide_membership(t["id"], "u-bob", {"action": "accept"}, user=env["alice"], session=s)
        assert teams_service.is_active_member(s, t["id"], "u-bob") is True


def test_open_join_is_immediate(env):
    with Session(engine) as s:
        t = _create(s, env["bob"], "OpenTeam", policy="open")
        teams_api.join_team(t["id"], user=env["alice"], session=s)
        assert teams_service.is_active_member(s, t["id"], "u-alice") is True


def test_closed_join_rejected(env):
    with Session(engine) as s:
        t = _create(s, env["alice"], "Closed", policy="closed")
        with pytest.raises(HTTPException) as ei:
            teams_api.join_team(t["id"], user=env["bob"], session=s)
    assert ei.value.status_code == 403


def test_joined_limit(env, monkeypatch):
    monkeypatch.setenv("AGENT_SWARM_TEAM_MAX_JOINED", "2")
    with Session(engine) as s:
        t1 = _create(s, env["alice"], "T1", policy="open")
        t2 = _create(s, env["alice"], "T2", policy="open")
        t3 = _create(s, env["alice"], "T3", policy="open")
        teams_api.join_team(t1["id"], user=env["bob"], session=s)
        teams_api.join_team(t2["id"], user=env["bob"], session=s)
        with pytest.raises(teams_service.TeamError):
            teams_api.join_team(t3["id"], user=env["bob"], session=s)


def test_team_member_limit(env, monkeypatch):
    monkeypatch.setenv("AGENT_SWARM_TEAM_MAX_MEMBERS", "1")
    with Session(engine) as s:
        t = _create(s, env["alice"], "T", policy="open")
        with pytest.raises(teams_service.TeamError):
            teams_api.join_team(t["id"], user=env["bob"], session=s)


def test_pending_limit(env, monkeypatch):
    monkeypatch.setenv("AGENT_SWARM_TEAM_MAX_PENDING", "1")
    with Session(engine) as s:
        t1 = _create(s, env["alice"], "T1")
        t2 = _create(s, env["alice"], "T2")
        teams_api.invite_member(t1["id"], {"username": "bob"}, user=env["alice"], session=s)
        with pytest.raises(teams_service.TeamError):
            teams_api.invite_member(t2["id"], {"username": "bob"}, user=env["alice"], session=s)


# ---------------------------------------------------------------- 生命周期


def test_transfer_and_leader_cannot_leave(env):
    with Session(engine) as s:
        t = _create(s, env["alice"], "T", policy="open")
        teams_api.join_team(t["id"], user=env["bob"], session=s)
        teams_api.transfer_leadership(t["id"], "u-bob", user=env["alice"], session=s)
        team = s.get(models.Team, t["id"])
        assert team.owner_id == "u-bob"
        with pytest.raises(HTTPException) as ei:
            teams_api.leave_team(t["id"], user=env["bob"], session=s)
    assert ei.value.status_code == 409


def test_kick_and_leave_cleanup_shares(env):
    with Session(engine) as s:
        t = _create(s, env["alice"], "T", policy="open")
        teams_api.join_team(t["id"], user=env["bob"], session=s)
        ws_api.set_workspace_shares("w-bob", {"team_ids": [t["id"]]}, user=env["bob"], session=s)
        # bob 退出 → 成员关系与其共享都被清理
        teams_api.leave_team(t["id"], user=env["bob"], session=s)
        assert teams_service.is_active_member(s, t["id"], "u-bob") is False
        assert teams_service.shared_workspace_ids(s, "u-bob") == set()

    # 队长踢人
    with Session(engine) as s:
        t = _create(s, env["alice"], "T2", policy="open")
        teams_api.join_team(t["id"], user=env["bob"], session=s)
        ws_api.set_workspace_shares("w-bob", {"team_ids": [t["id"]]}, user=env["bob"], session=s)
        teams_api.remove_member(t["id"], "u-bob", user=env["alice"], session=s)
        assert teams_service.is_active_member(s, t["id"], "u-bob") is False
        assert teams_service.shared_workspace_ids(s, "u-bob") == set()


def test_delete_team_cascades(env):
    with Session(engine) as s:
        t = _create(s, env["alice"], "T", policy="open")
        teams_api.join_team(t["id"], user=env["bob"], session=s)
        ws_api.set_workspace_shares("w-alice", {"team_ids": [t["id"]]}, user=env["alice"], session=s)
        teams_api.delete_team(t["id"], user=env["alice"], session=s)
        assert s.get(models.Team, t["id"]) is None
        assert teams_service.get_membership(s, t["id"], "u-bob") is None
        assert len(s.exec(select(models.TeamWorkspace).where(models.TeamWorkspace.team_id == t["id"])).all()) == 0


# ---------------------------------------------------------------- 工作区共享 + 隔离红线


def test_share_requires_membership(env):
    with Session(engine) as s:
        t = _create(s, env["alice"], "T")
        # carol 不在团队里 → 不能把 her 工作区共享到该团队（这里用 alice 的工作区、bob 操作也会被属主拦）
        with pytest.raises(HTTPException) as ei:
            ws_api.set_workspace_shares("w-alice", {"team_ids": [t["id"]]}, user=env["carol"], session=s)
        assert ei.value.status_code == 403  # 非属主


def test_share_target_team_must_be_joined(env):
    with Session(engine) as s:
        t = _create(s, env["bob"], "BobsTeam")  # alice 不在其中
        with pytest.raises(HTTPException) as ei:
            ws_api.set_workspace_shares("w-alice", {"team_ids": [t["id"]]}, user=env["alice"], session=s)
    assert ei.value.status_code == 403


def test_can_invoke_but_not_visible(env):
    """核心红线：成员可调用被共享工作区，但工作区不出现在其可见集合里。"""
    with Session(engine) as s:
        t = _create(s, env["alice"], "T", policy="open")
        teams_api.join_team(t["id"], user=env["bob"], session=s)
        ws_api.set_workspace_shares("w-alice", {"team_ids": [t["id"]]}, user=env["alice"], session=s)
        # 调用权
        assert teams_service.can_invoke(s, "u-bob", "w-alice") is True
        assert "w-alice" in teams_service.shared_workspace_ids(s, "u-bob")
        # 但可见集合仍是属主独占（监控/Nexus/产物/调用记录不因共享而放宽）
        assert "w-alice" not in visible_workspace_ids(env["bob"], s)
        # 非成员无调用权
        assert teams_service.can_invoke(s, "u-carol", "w-alice") is False
        # 属主对自有工作区始终可调用
        assert teams_service.can_invoke(s, "u-alice", "w-alice") is True


def test_team_detail_requires_membership(env):
    with Session(engine) as s:
        t = _create(s, env["alice"], "T")
        with pytest.raises(HTTPException) as ei:
            teams_api.team_detail(t["id"], user=env["carol"], session=s)
    assert ei.value.status_code == 403


def test_discover_excludes_joined_and_closed(env):
    with Session(engine) as s:
        open_t = _create(s, env["alice"], "Discoverable", policy="open")
        _create(s, env["alice"], "ClosedTeam", policy="closed")
        _create(s, env["alice"], "ApplyTeam", policy="approval")
        teams_api.join_team(open_t["id"], user=env["bob"], session=s)  # bob 已加入
        names = {t["name"] for t in teams_api.discover_teams(user=env["bob"], session=s)["teams"]}
    assert "Discoverable" not in names  # 已加入
    assert "ClosedTeam" not in names    # closed
    assert "ApplyTeam" in names         # approval 可申请
    # 关键词搜索
    with Session(engine) as s:
        only = teams_api.discover_teams(q="apply", user=env["bob"], session=s)["teams"]
    assert [t["name"] for t in only] == ["ApplyTeam"]
