"""产物归属工作区 + 团队共享可见性（2026-10-01）。

产物按归属工作区决定可共享性：归属工作区被共享给某团队后，
团队成员在「产物」页可见并下载（只读），非成员看不到；无归属工作区的产物不可共享。
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session, select

from server import models
from server.api import teams as teams_api
from server.api import workspaces as ws_api
from server.api_artifacts import visible_artifacts
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


def _mk_artifact(aid: str, uid: str, workspace_id: str, name: str = "f.txt") -> None:
    with Session(engine) as s:
        s.add(
            models.Artifact(
                id=aid, user_id=uid, name=name, size=1, mime="text/plain", note="",
                task_id="", workspace_id=workspace_id, pinned=False,
                created_at=_now(), expires_at=_now() + timedelta(days=7),
            )
        )
        s.commit()


@pytest.fixture()
def art_env():
    with Session(engine) as s:
        for m in s.exec(select(models.TeamMember)).all():
            s.delete(m)
        for sh in s.exec(select(models.TeamWorkspace)).all():
            s.delete(sh)
        for t in s.exec(select(models.Team)).all():
            s.delete(t)
        for a in s.exec(select(models.Artifact)).all():
            s.delete(a)
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
    # alice 建团队（open），bob 加入并把 w-bob 共享给团队
    with Session(engine) as s:
        t = teams_api.create_team({"name": "ArtTeam", "join_policy": "open"}, user=_user("u-alice"), session=s)
        teams_api.join_team(t["id"], user=_user("u-bob"), session=s)
        ws_api.set_workspace_shares("w-bob", {"team_ids": [t["id"]]}, user=_user("u-bob"), session=s)
    yield


def test_shared_workspace_artifact_visible_to_member(art_env):
    _mk_artifact("a-bob", "u-bob", "w-bob")
    with Session(engine) as s:
        alice = {r.id: sh for r, sh in visible_artifacts(s, _user("u-alice"))}
        carol = {r.id for r, _ in visible_artifacts(s, _user("u-carol"))}
        bob = {r.id: sh for r, sh in visible_artifacts(s, _user("u-bob"))}
    assert alice.get("a-bob") is True            # 团队成员可见，且标记为 shared
    assert "a-bob" not in carol                  # 非成员不可见
    assert bob.get("a-bob") is False             # 属主看到的是自有（非 shared）


def test_unattributed_artifact_not_shared(art_env):
    _mk_artifact("a-noflow", "u-bob", "")        # 无归属工作区
    with Session(engine) as s:
        alice = {r.id for r, _ in visible_artifacts(s, _user("u-alice"))}
    assert "a-noflow" not in alice


def test_unshare_hides_artifact(art_env):
    _mk_artifact("a-bob2", "u-bob", "w-bob")
    with Session(engine) as s:
        ws_api.set_workspace_shares("w-bob", {"team_ids": []}, user=_user("u-bob"), session=s)
    with Session(engine) as s:
        assert "a-bob2" not in {r.id for r, _ in visible_artifacts(s, _user("u-alice"))}
