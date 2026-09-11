from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select

from server import models
from server.auth import get_current_user
from server.db import get_session, engine

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])

HEARTBEAT_TIMEOUT_SECONDS = 90  # 心跳 30s × 3


def ws_is_online(ws: models.Workspace) -> bool:
    if ws.status != "online":
        return False
    if not ws.last_heartbeat:
        return False
    hb = ws.last_heartbeat.replace(tzinfo=timezone.utc) if ws.last_heartbeat.tzinfo is None else ws.last_heartbeat
    return (datetime.now(timezone.utc) - hb).total_seconds() < HEARTBEAT_TIMEOUT_SECONDS


def ws_out(ws: models.Workspace, session: Session) -> dict:
    owner = session.get(models.User, ws.user_id)
    team = session.get(models.Team, ws.team_id) if ws.team_id else None
    online = ws_is_online(ws)
    effective = "online" if online else ("disabled" if ws.status == "disabled" else "offline")
    return {
        "id": ws.id,
        "name": ws.name,
        "path": ws.path,
        "purpose": ws.purpose,
        "capabilities": ws.capabilities,
        "notes": ws.notes,
        "status": effective,
        "raw_status": ws.status,
        "owner": {"id": owner.id, "username": owner.username} if owner else None,
        "team": {"id": team.id, "name": team.name} if team else None,
        "last_heartbeat": ws.last_heartbeat.isoformat() + "Z" if ws.last_heartbeat else None,
        "session_id": ws.session_id,
        "created_at": ws.created_at.isoformat() + "Z",
    }


def my_team_ids(user_id: str, session: Session) -> list[str]:
    rows = session.exec(
        select(models.TeamMember.team_id).where(models.TeamMember.user_id == user_id)
    ).all()
    return [r[0] if isinstance(r, tuple) else r for r in rows]


def visible_workspace_ids(user: models.User, session: Session) -> set[str]:
    ids = {w.id for w in session.exec(
        select(models.Workspace).where(models.Workspace.user_id == user.id)
    ).all()}
    for tid in my_team_ids(user.id, session):
        for w in session.exec(
            select(models.Workspace).where(models.Workspace.team_id == tid)
        ).all():
            ids.add(w.id)
    return ids


@router.get("")
def list_workspaces(
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    ids = visible_workspace_ids(user, session)
    out = []
    for wid in ids:
        ws = session.get(models.Workspace, wid)
        if ws:
            out.append(ws_out(ws, session))
    out.sort(key=lambda x: (x["team"]["name"] if x["team"] else "", x["name"]))
    return out


@router.post("/{workspace_id}/disable")
def disable_workspace(
    workspace_id: str,
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    ws = _get_ws_with_perm(workspace_id, user, session)
    ws.status = "disabled"
    ws.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    session.add(ws)
    session.commit()
    return {"ok": True, "status": "disabled"}


@router.post("/{workspace_id}/enable")
def enable_workspace(
    workspace_id: str,
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    ws = _get_ws_with_perm(workspace_id, user, session)
    ws.status = "offline"  # 等下一次心跳恢复 online
    ws.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    session.add(ws)
    session.commit()
    return {"ok": True, "status": "offline"}


@router.delete("/{workspace_id}")
def delete_workspace(
    workspace_id: str,
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    ws = _get_ws_with_perm(workspace_id, user, session)
    if ws_is_online(ws):
        raise HTTPException(409, "workspace is online, disable or wait for it to go offline first")
    # 级联清理求助记录
    for hr in session.exec(
        select(models.HelpRequest).where(
            (models.HelpRequest.requester_ws_id == ws.id)
            | (models.HelpRequest.target_ws_id == ws.id)
        )
    ).all():
        session.delete(hr)
    session.delete(ws)
    session.commit()
    return {"ok": True}


def _get_ws_with_perm(workspace_id: str, user: models.User, session: Session) -> models.Workspace:
    ws = session.get(models.Workspace, workspace_id)
    if not ws:
        raise HTTPException(404, "workspace not found")
    if ws.user_id != user.id and ws.user_id not in _team_mate_ids(user, session):
        # team 管理权限：同 team 成员可管理
        raise HTTPException(403, "no permission on this workspace")
    return ws


def _team_mate_ids(user: models.User, session: Session) -> set[str]:
    ids: set[str] = set()
    for tid in my_team_ids(user.id, session):
        for r in session.exec(
            select(models.TeamMember.user_id).where(models.TeamMember.team_id == tid)
        ).all():
            uid = r[0] if isinstance(r, tuple) else r
            if uid != user.id:
                ids.add(uid)
    return ids
