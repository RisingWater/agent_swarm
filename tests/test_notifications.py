"""站内信：团队事件通知 + 未读数/已读 API。"""
import pytest
from fastapi import HTTPException
from sqlmodel import Session, select

from server import models
from server.api import notifications as notif_api
from server.api import teams as teams_api
from server.db import engine


def _user(uid: str) -> models.User:
    with Session(engine) as s:
        return s.get(models.User, uid)


def _kinds(uid: str) -> list[str]:
    with Session(engine) as s:
        return [
            n.kind
            for n in s.exec(
                select(models.Notification)
                .where(models.Notification.user_id == uid)
                .order_by(models.Notification.created_at)  # type: ignore[attr-defined]
            ).all()
        ]


@pytest.fixture()
def nt_env():
    with Session(engine) as s:
        for n in s.exec(select(models.Notification)).all():
            s.delete(n)
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
    yield


def test_team_notification_lifecycle(nt_env):
    with Session(engine) as s:
        t = teams_api.create_team({"name": "NT", "join_policy": "approval"}, user=_user("u-alice"), session=s)
        teams_api.invite_member(t["id"], {"username": "bob"}, user=_user("u-alice"), session=s)
    assert "team_invite" in _kinds("u-bob")

    with Session(engine) as s:
        teams_api.decide_membership(t["id"], "u-bob", {"action": "accept"}, user=_user("u-bob"), session=s)
    assert "team_joined" in _kinds("u-bob")
    assert "team_member_joined" in _kinds("u-alice")  # 队长收到「有人加入」

    with Session(engine) as s:
        teams_api.join_team(t["id"], user=_user("u-carol"), session=s)  # 申请
    assert "team_join_request" in _kinds("u-alice")

    with Session(engine) as s:
        teams_api.decide_membership(t["id"], "u-carol", {"action": "accept"}, user=_user("u-alice"), session=s)
    assert "team_joined" in _kinds("u-carol")
    assert _kinds("u-bob").count("team_member_joined") >= 1  # 既有成员也收到

    with Session(engine) as s:
        teams_api.remove_member(t["id"], "u-carol", user=_user("u-alice"), session=s)
    assert "team_removed" in _kinds("u-carol")

    with Session(engine) as s:
        teams_api.delete_team(t["id"], user=_user("u-alice"), session=s)
    assert "team_disbanded" in _kinds("u-alice")   # 解散 → 剩余活跃成员都收到
    assert "team_disbanded" in _kinds("u-bob")


def test_invite_declined_notifies_leader(nt_env):
    with Session(engine) as s:
        t = teams_api.create_team({"name": "NT2", "join_policy": "approval"}, user=_user("u-alice"), session=s)
        teams_api.invite_member(t["id"], {"username": "bob"}, user=_user("u-alice"), session=s)
        teams_api.decide_membership(t["id"], "u-bob", {"action": "reject"}, user=_user("u-bob"), session=s)
    assert "team_invite_declined" in _kinds("u-alice")


def test_join_rejected_notifies_applicant(nt_env):
    with Session(engine) as s:
        t = teams_api.create_team({"name": "NT3", "join_policy": "approval"}, user=_user("u-alice"), session=s)
        teams_api.join_team(t["id"], user=_user("u-bob"), session=s)
        teams_api.decide_membership(t["id"], "u-bob", {"action": "reject"}, user=_user("u-alice"), session=s)
    assert "team_join_rejected" in _kinds("u-bob")


def test_notification_delete_api(nt_env):
    with Session(engine) as s:
        t = teams_api.create_team({"name": "ND", "join_policy": "approval"}, user=_user("u-alice"), session=s)
        teams_api.invite_member(t["id"], {"username": "bob"}, user=_user("u-alice"), session=s)  # bob 收到邀请
        teams_api.join_team(t["id"], user=_user("u-carol"), session=s)  # alice 收到 carol 的申请
    with Session(engine) as s:
        bob_list = notif_api.list_notifications(user=_user("u-bob"), session=s)["notifications"]
        assert bob_list
        nid = bob_list[0]["id"]
        with pytest.raises(HTTPException):
            notif_api.delete_notification(nid, user=_user("u-carol"), session=s)  # 他人 404
        notif_api.delete_notification(nid, user=_user("u-bob"), session=s)
        assert notif_api.list_notifications(user=_user("u-bob"), session=s)["notifications"] == []
        # 全部删除（alice 名下有「申请加入」通知）
        assert notif_api.list_notifications(user=_user("u-alice"), session=s)["notifications"]
        res = notif_api.delete_all_notifications(user=_user("u-alice"), session=s)
        assert res["count"] >= 1
        assert notif_api.list_notifications(user=_user("u-alice"), session=s)["notifications"] == []


def test_notification_read_api(nt_env):
    with Session(engine) as s:
        t = teams_api.create_team({"name": "NR", "join_policy": "approval"}, user=_user("u-alice"), session=s)
        teams_api.invite_member(t["id"], {"username": "bob"}, user=_user("u-alice"), session=s)
    with Session(engine) as s:
        cnt = notif_api.unread_count(user=_user("u-bob"), session=s)["count"]
        assert cnt >= 1
        listing = notif_api.list_notifications(user=_user("u-bob"), session=s)["notifications"]
        assert listing and listing[0]["title"]
        assert notif_api.list_notifications(unread_only=True, user=_user("u-bob"), session=s)["notifications"]
        nid = listing[0]["id"]
        # 别人的通知不能标记已读
        with pytest.raises(HTTPException):
            notif_api.mark_read(nid, user=_user("u-carol"), session=s)
        notif_api.mark_read(nid, user=_user("u-bob"), session=s)
    with Session(engine) as s:
        assert notif_api.unread_count(user=_user("u-bob"), session=s)["count"] == cnt - 1
        notif_api.mark_all_read(user=_user("u-bob"), session=s)
    with Session(engine) as s:
        assert notif_api.unread_count(user=_user("u-bob"), session=s)["count"] == 0
