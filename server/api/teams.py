"""团队 REST API：创建/管理团队、成员邀请与审批、工作区共享（调用权）。

设计见 docs/team_requirement.md。数量限制与访问控制判定集中在 server/teams_service.py。
本模块只做 HTTP 编排与权限边界；**不放宽**工作区的可见性（监控/Nexus/产物仍走属主校验）。
"""
from __future__ import annotations

import shortuuid
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from server import models, teams_service
from server.auth import get_user_either
from server.db import get_session

router = APIRouter(prefix="/api/teams", tags=["teams"])

JOIN_POLICIES = ("approval", "open", "closed")


# ---------------------------------------------------------------- 序列化 / 取行


def _username(session: Session, user_id: str) -> str:
    u = session.get(models.User, user_id) if user_id else None
    return u.username if u else ""


def _team_out(session: Session, team: models.Team, user: models.User) -> dict:
    return {
        "id": team.id,
        "name": team.name,
        "join_policy": team.join_policy,
        "description": team.description or "",
        "leader": {"id": team.owner_id, "username": _username(session, team.owner_id)},
        "is_leader": team.owner_id == user.id,
        "member_count": teams_service.team_member_count(session, team.id, "active"),
        "pending_count": teams_service.team_member_count(session, team.id, "pending"),
        "workspace_count": len(
            session.exec(
                select(models.TeamWorkspace.id).where(models.TeamWorkspace.team_id == team.id)
            ).all()
        ),
        "created_at": team.created_at.isoformat() + "Z",
    }


def _member_out(session: Session, m: models.TeamMember) -> dict:
    return {
        "user_id": m.user_id,
        "username": _username(session, m.user_id),
        "status": m.status,
        "kind": m.kind,
        "initiated_by": m.initiated_by,
        "created_at": m.created_at.isoformat() + "Z" if m.created_at else None,
    }


def _share_out(session: Session, sh: models.TeamWorkspace) -> dict:
    t = session.get(models.Team, sh.team_id)
    return {
        "team_id": sh.team_id,
        "name": t.name if t else "",
        "shared_by": sh.shared_by,
        "created_at": sh.created_at.isoformat() + "Z" if sh.created_at else None,
    }


def _get_team(session: Session, team_id: str) -> models.Team:
    team = session.get(models.Team, team_id)
    if team is None:
        raise HTTPException(404, "team not found")
    return team


def _require_leader(team: models.Team, user: models.User) -> None:
    if team.owner_id != user.id:
        raise HTTPException(403, "只有队长可以执行此操作")


def _require_member(session: Session, team: models.Team, user: models.User) -> None:
    if not teams_service.is_active_member(session, team.id, user.id):
        raise HTTPException(403, "你不是该团队的成员")


def _cleanup_user_shares(session: Session, team_id: str, user_id: str) -> None:
    """成员离开/被移除时，清理其共享给该团队的工作区。"""
    for sh in session.exec(
        select(models.TeamWorkspace)
        .where(models.TeamWorkspace.team_id == team_id)
        .where(models.TeamWorkspace.shared_by == user_id)
    ).all():
        session.delete(sh)


# ---------------------------------------------------------------- 团队


@router.get("")
def list_teams(user: models.User = Depends(get_user_either), session: Session = Depends(get_session)):
    """我活跃加入的全部团队。"""
    out = []
    for tid in teams_service.active_team_ids(session, user.id):
        team = session.get(models.Team, tid)
        if team is not None:
            out.append(_team_out(session, team, user))
    out.sort(key=lambda x: x["name"])
    return {"teams": out}


@router.post("")
def create_team(
    body: dict,
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    """创建团队：创建者即队长（owner_id），并自动成为活跃成员。"""
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(422, "name is required")
    if len(name) > 40:
        raise HTTPException(422, "团队名最长 40 字")
    join_policy = str(body.get("join_policy") or "approval").strip()
    if join_policy not in JOIN_POLICIES:
        raise HTTPException(422, f"join_policy 必须是 {JOIN_POLICIES} 之一")
    if session.exec(select(models.Team.id).where(models.Team.name == name)).first():
        raise HTTPException(409, "团队名已被占用")
    teams_service.assert_can_create_team(session, user.id)
    team = models.Team(
        id=shortuuid.uuid(),
        name=name,
        owner_id=user.id,
        join_policy=join_policy,
        description=(str(body.get("description") or "").strip() or None),
    )
    session.add(team)
    session.add(
        models.TeamMember(
            team_id=team.id, user_id=user.id, status="active", kind="invite", initiated_by=user.id
        )
    )
    session.commit()
    return _team_out(session, team, user)


@router.get("/invitations")
def my_invitations(
    user: models.User = Depends(get_user_either), session: Session = Depends(get_session)
):
    """我的待处理：别人邀我（invite）＋ 我队里待我审批的申请（request）。"""
    invites = []
    for m in session.exec(
        select(models.TeamMember)
        .where(models.TeamMember.user_id == user.id)
        .where(models.TeamMember.status == "pending")
        .where(models.TeamMember.kind == "invite")
    ).all():
        t = session.get(models.Team, m.team_id)
        invites.append(
            {
                "team": {"id": m.team_id, "name": t.name if t else ""},
                "invited_by": {"id": m.initiated_by, "username": _username(session, m.initiated_by)},
                "created_at": m.created_at.isoformat() + "Z" if m.created_at else None,
            }
        )
    requests = []
    led_ids = [
        t.id for t in session.exec(select(models.Team).where(models.Team.owner_id == user.id)).all()
    ]
    if led_ids:
        for m in session.exec(
            select(models.TeamMember)
            .where(models.TeamMember.team_id.in_(led_ids))  # type: ignore[attr-defined]
            .where(models.TeamMember.status == "pending")
            .where(models.TeamMember.kind == "request")
        ).all():
            t = session.get(models.Team, m.team_id)
            requests.append(
                {
                    "team": {"id": m.team_id, "name": t.name if t else ""},
                    "user": {"id": m.user_id, "username": _username(session, m.user_id)},
                    "created_at": m.created_at.isoformat() + "Z" if m.created_at else None,
                }
            )
    return {"invites": invites, "requests": requests}


@router.get("/{team_id}")
def team_detail(
    team_id: str,
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    """团队详情（成员可见）：基本信息 + 成员（含待处理）+ 已共享工作区。"""
    team = _get_team(session, team_id)
    _require_member(session, team, user)
    members = [
        _member_out(session, m)
        for m in session.exec(
            select(models.TeamMember).where(models.TeamMember.team_id == team.id)
        ).all()
    ]
    members.sort(key=lambda x: (x["status"] != "active", x["kind"] != "invite", x["username"]))
    workspaces = [
        {
            "workspace_id": sh.workspace_id,
            "name": (ws.name if (ws := session.get(models.Workspace, sh.workspace_id)) else ""),
            "shared_by": sh.shared_by,
        }
        for sh in session.exec(
            select(models.TeamWorkspace).where(models.TeamWorkspace.team_id == team.id)
        ).all()
    ]
    return {**_team_out(session, team, user), "members": members, "workspaces": workspaces}


@router.patch("/{team_id}")
def update_team(
    team_id: str,
    body: dict,
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    """队长：改名 / 改加入策略 / 改描述。"""
    team = _get_team(session, team_id)
    _require_leader(team, user)
    if "name" in body:
        name = str(body.get("name") or "").strip()
        if not name:
            raise HTTPException(422, "name 不能为空")
        if len(name) > 40:
            raise HTTPException(422, "团队名最长 40 字")
        dup = session.exec(select(models.Team.id).where(models.Team.name == name)).first()
        if dup and dup != team.id:
            raise HTTPException(409, "团队名已被占用")
        team.name = name
    if "join_policy" in body:
        jp = str(body.get("join_policy") or "").strip()
        if jp not in JOIN_POLICIES:
            raise HTTPException(422, f"join_policy 必须是 {JOIN_POLICIES} 之一")
        team.join_policy = jp
    if "description" in body:
        team.description = str(body.get("description") or "").strip() or None
    session.add(team)
    session.commit()
    return _team_out(session, team, user)


@router.delete("/{team_id}")
def delete_team(
    team_id: str,
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    """队长解散团队：级联删除成员关系与共享关系。"""
    team = _get_team(session, team_id)
    _require_leader(team, user)
    for m in session.exec(
        select(models.TeamMember).where(models.TeamMember.team_id == team.id)
    ).all():
        session.delete(m)
    for sh in session.exec(
        select(models.TeamWorkspace).where(models.TeamWorkspace.team_id == team.id)
    ).all():
        session.delete(sh)
    session.delete(team)
    session.commit()
    return {"ok": True}


# ---------------------------------------------------------------- 邀请 / 申请 / 审批


@router.post("/{team_id}/members/invite")
def invite_member(
    team_id: str,
    body: dict,
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    """队长按用户名邀请用户（生成待接受邀请）。"""
    team = _get_team(session, team_id)
    _require_leader(team, user)
    username = str(body.get("username") or "").strip()
    if not username:
        raise HTTPException(422, "username is required")
    target = session.exec(select(models.User).where(models.User.username == username)).first()
    if target is None:
        raise HTTPException(404, "用户不存在")
    if target.id == team.owner_id:
        raise HTTPException(409, "对方已是队长")
    existing = teams_service.get_membership(session, team.id, target.id)
    if existing is not None:
        if existing.status == "active":
            raise HTTPException(409, "对方已是团队成员")
        raise HTTPException(409, "已有待处理的邀请/申请")
    teams_service.assert_team_has_room(session, team.id)
    teams_service.assert_can_join(session, target.id)  # 失败快，避免接受时才报错
    teams_service.assert_can_pend(session, target.id)
    session.add(
        models.TeamMember(
            team_id=team.id, user_id=target.id, status="pending", kind="invite", initiated_by=user.id
        )
    )
    session.commit()
    return {"ok": True}


@router.post("/{team_id}/join")
def join_team(
    team_id: str,
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    """用户申请加入（approval → 待审批；open → 直接加入；closed → 拒绝）。"""
    team = _get_team(session, team_id)
    if team.owner_id == user.id:
        raise HTTPException(409, "你已是该团队的队长")
    existing = teams_service.get_membership(session, team.id, user.id)
    if existing is not None:
        if existing.status == "active":
            raise HTTPException(409, "你已是该团队成员")
        raise HTTPException(409, "你已有待处理的邀请/申请")
    if team.join_policy == "closed":
        raise HTTPException(403, "该团队不允许申请加入")
    teams_service.assert_team_has_room(session, team.id)
    teams_service.assert_can_join(session, user.id)
    if team.join_policy == "open":
        session.add(
            models.TeamMember(
                team_id=team.id, user_id=user.id, status="active", kind="request", initiated_by=user.id
            )
        )
        session.commit()
        return {"ok": True, "status": "active"}
    # approval
    teams_service.assert_can_pend(session, user.id)
    session.add(
        models.TeamMember(
            team_id=team.id, user_id=user.id, status="pending", kind="request", initiated_by=user.id
        )
    )
    session.commit()
    return {"ok": True, "status": "pending"}


@router.post("/{team_id}/members/{target_id}/decision")
def decide_membership(
    team_id: str,
    target_id: str,
    body: dict,
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    """处理待办成员关系。

    - kind=request（用户申请）：仅队长可 approve/reject。
    - kind=invite（队长邀请）：仅被邀请人（target_id）本人可 accept/decline。
    action: accept / reject（decline 同 reject）。
    """
    team = _get_team(session, team_id)
    action = str(body.get("action") or "").strip().lower()
    if action in ("decline", "deny"):
        action = "reject"
    if action not in ("accept", "reject"):
        raise HTTPException(422, "action 必须是 accept / reject")
    m = teams_service.get_membership(session, team.id, target_id)
    if m is None or m.status != "pending":
        raise HTTPException(409, "没有待处理的邀请/申请")
    if m.kind == "request":
        _require_leader(team, user)
    else:  # invite：只有被邀请人能处理
        if user.id != m.user_id:
            raise HTTPException(403, "只有被邀请人可以处理该邀请")
    if action == "accept":
        teams_service.assert_team_has_room(session, team.id)
        teams_service.assert_can_join(session, m.user_id)
        m.status = "active"
        session.add(m)
    else:
        session.delete(m)
    session.commit()
    return {"ok": True, "status": "active" if action == "accept" else "removed"}


# ---------------------------------------------------------------- 踢人 / 退出 / 移交


@router.delete("/{team_id}/members/{target_id}")
def remove_member(
    team_id: str,
    target_id: str,
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    """队长踢人：移除活跃成员并清理其共享给本团队的工作区。"""
    team = _get_team(session, team_id)
    _require_leader(team, user)
    if target_id == team.owner_id:
        raise HTTPException(409, "不能移除队长，请先移交队长")
    m = teams_service.get_membership(session, team.id, target_id)
    if m is None or m.status != "active":
        raise HTTPException(404, "该用户不是团队成员")
    session.delete(m)
    _cleanup_user_shares(session, team.id, target_id)
    session.commit()
    return {"ok": True}


@router.post("/{team_id}/leave")
def leave_team(
    team_id: str,
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    """成员自行退出；队长须先移交或解散。"""
    team = _get_team(session, team_id)
    if team.owner_id == user.id:
        raise HTTPException(409, "队长不能直接退出，请先移交队长或解散团队")
    m = teams_service.get_membership(session, team.id, user.id)
    if m is None or m.status != "active":
        raise HTTPException(404, "你不是该团队成员")
    session.delete(m)
    _cleanup_user_shares(session, team.id, user.id)
    session.commit()
    return {"ok": True}


@router.post("/{team_id}/members/{target_id}/transfer")
def transfer_leadership(
    team_id: str,
    target_id: str,
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    """队长把队长身份移交给某个活跃成员。"""
    team = _get_team(session, team_id)
    _require_leader(team, user)
    if target_id == team.owner_id:
        raise HTTPException(409, "对方已是队长")
    m = teams_service.get_membership(session, team.id, target_id)
    if m is None or m.status != "active":
        raise HTTPException(404, "只能移交给活跃成员")
    team.owner_id = target_id
    session.add(team)
    session.commit()
    return {"ok": True}
