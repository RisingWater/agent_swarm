"""站内信 REST：我的通知列表 / 未读数 / 标记已读。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from server import models
from server.auth import get_user_either
from server.db import get_session

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


def _out(n: models.Notification) -> dict:
    return {
        "id": n.id,
        "kind": n.kind,
        "title": n.title,
        "body": n.body,
        "team_id": n.team_id,
        "team_name": n.team_name,
        "actor": {"id": n.actor_id, "username": n.actor_username} if n.actor_id else None,
        "read": n.read,
        "created_at": n.created_at.isoformat() + "Z" if n.created_at else "",
    }


@router.get("")
def list_notifications(
    limit: int = 50,
    unread_only: bool = False,
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    limit = max(1, min(int(limit or 50), 200))
    stmt = select(models.Notification).where(models.Notification.user_id == user.id)
    if unread_only:
        stmt = stmt.where(models.Notification.read == False)  # noqa: E712
    rows = session.exec(
        stmt.order_by(models.Notification.created_at.desc()).limit(limit)  # type: ignore[attr-defined]
    ).all()
    return {"notifications": [_out(n) for n in rows]}


@router.get("/unread_count")
def unread_count(
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    ids = session.exec(
        select(models.Notification.id)
        .where(models.Notification.user_id == user.id)
        .where(models.Notification.read == False)  # noqa: E712
    ).all()
    return {"count": len(ids)}


@router.post("/read_all")
def mark_all_read(
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    rows = session.exec(
        select(models.Notification)
        .where(models.Notification.user_id == user.id)
        .where(models.Notification.read == False)  # noqa: E712
    ).all()
    for n in rows:
        n.read = True
        session.add(n)
    session.commit()
    return {"ok": True, "count": len(rows)}


@router.post("/{notification_id}/read")
def mark_read(
    notification_id: str,
    user: models.User = Depends(get_user_either),
    session: Session = Depends(get_session),
):
    n = session.get(models.Notification, notification_id)
    if n is None or n.user_id != user.id:
        raise HTTPException(404, "notification not found")
    if not n.read:
        n.read = True
        session.add(n)
        session.commit()
    return {"ok": True}
