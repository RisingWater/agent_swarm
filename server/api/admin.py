"""后台管理端点（独立登录，凭 .env ADMIN_USERNAME/ADMIN_PASSWORD）。

- 面板统计：用户数 / 在线工作区数 / 指令总数 / 近 30 天每日指令折线
- 用户列表（含绑定飞书 id）+ 重置密码（不重置 api_key——不断 agent 连接）
- 工作区全量列表（含归属用户/会话/在线/近 24h 调用数）
"""
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session, func, select

from server import models
from server.api.workspaces import ws_is_online
from server.auth import admin_credentials, create_admin_token, require_admin
from server.db import get_session

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _masked(enc: str | None, plain: str | None) -> str:
    """管理员不持有用户 apikey，不解密内容列：加密行显示占位符，未加密行显示明文。"""
    if enc:
        return "[加密内容]"
    return (plain or "").replace("\n", " ")


class AdminLoginBody(BaseModel):
    username: str
    password: str


@router.post("/login")
def admin_login(body: AdminLoginBody):
    """后台登录：比对 .env 配置（默认 admin / Admin123!@#），签发独立 admin token。"""
    want_user, want_pass = admin_credentials()
    if body.username != want_user or body.password != want_pass:
        raise HTTPException(401, "用户名或密码错误")
    return {"token": create_admin_token()}


def _check(request: Request) -> None:
    require_admin(request)


@router.get("/stats")
def admin_stats(request: Request, session: Session = Depends(get_session)):
    _check(request)
    users = session.exec(select(func.count(models.User.id))).one()
    workspaces = session.exec(select(models.Workspace)).all()
    online = sum(1 for w in workspaces if ws_is_online(w))
    task_total = session.exec(select(func.count(models.A2aTask.id))).one()

    # 近 30 天每日指令数（含监控轮；UTC 天界，对齐全站时间戳约定）
    since = datetime.now(timezone.utc) - timedelta(days=30)
    rows = session.exec(
        select(models.A2aTask.created_at).where(models.A2aTask.created_at >= since)
    ).all()
    daily: dict[str, int] = {}
    for i in range(30):
        d = (since + timedelta(days=i)).strftime("%Y-%m-%d")
        daily[d] = 0
    for created in rows:
        key = created.strftime("%Y-%m-%d") if created else ""
        if key in daily:
            daily[key] += 1
    return {
        "users": users,
        "workspaces_total": len(workspaces),
        "workspaces_online": online,
        "tasks_total": task_total,
        "daily_tasks": [{"date": d, "count": n} for d, n in daily.items()],
    }


def _feishu_ids_by_user(session: Session) -> dict[str, list[str]]:
    rows = session.exec(select(models.FeishuBinding)).all()
    out: dict[str, list[str]] = {}
    for b in rows:
        out.setdefault(b.user_id, []).append(b.open_id)
    return out


@router.get("/users")
def admin_users(request: Request, session: Session = Depends(get_session)):
    _check(request)
    feishu = _feishu_ids_by_user(session)
    users = session.exec(select(models.User).order_by(models.User.created_at)).all()
    return {
        "users": [
            {
                "id": u.id,
                "username": u.username,
                "created_at": u.created_at.isoformat() + "Z",
                "feishu_ids": feishu.get(u.id, []),
            }
            for u in users
        ]
    }


class ResetPasswordBody(BaseModel):
    new_password: str | None = None  # 不传则生成随机密码


@router.post("/users/{user_id}/reset-password")
def admin_reset_password(
    user_id: str,
    body: ResetPasswordBody,
    request: Request,
    session: Session = Depends(get_session),
):
    """重置用户密码；不重置 api_key（避免断开该用户所有 agent 连接）。"""
    _check(request)
    user = session.get(models.User, user_id)
    if user is None:
        raise HTTPException(404, "user not found")
    new_password = (body.new_password or "").strip() or (secrets.token_urlsafe(9) + "Aa1")
    if len(new_password) < 6:
        raise HTTPException(422, "密码至少 6 位")
    user.password_hash = models.hash_password(new_password)
    session.add(user)
    session.commit()
    return {"ok": True, "new_password": new_password}


@router.get("/workspaces")
def admin_workspaces(request: Request, session: Session = Depends(get_session)):
    _check(request)
    since24h = datetime.now(timezone.utc) - timedelta(hours=24)
    # 近 24h 调用数按 workspace 分组（含监控轮）
    counts: dict[str, int] = {}
    rows = session.exec(
        select(models.A2aTask.workspace_id, func.count(models.A2aTask.id))
        .where(models.A2aTask.created_at >= since24h)
        .group_by(models.A2aTask.workspace_id)
    ).all()
    for wid, n in rows:
        if wid:
            counts[wid] = n
    users = {u.id: u.username for u in session.exec(select(models.User)).all()}
    workspaces = session.exec(select(models.Workspace).order_by(models.Workspace.created_at)).all()

    return {
        "workspaces": [
            {
                "id": w.id,
                "name": w.name,
                "path": w.path,
                "owner": users.get(w.user_id, w.user_id),
                "purpose": _masked(w.purpose_enc, w.purpose),
                "agent_type": w.agent_type or "",
                "online": ws_is_online(w),
                "status": w.status,
                "session_id": w.session_id or "",
                "session_title": _masked(w.session_title_enc, w.session_title),
                "calls_24h": counts.get(w.id, 0),
            }
            for w in workspaces
        ]
    }


@router.get("/calls")
def admin_calls(
    request: Request,
    workspace_id: str = "",
    session: Session = Depends(get_session),
):
    """调用记录全量列表（管理员视角，内容列不解密：加密行显示占位符）。"""
    _check(request)
    stmt = select(models.A2aTask).order_by(models.A2aTask.created_at.desc()).limit(500)
    if workspace_id:
        stmt = stmt.where(models.A2aTask.workspace_id == workspace_id)
    rows = session.exec(stmt).all()
    ws_names = {w.id: w.name for w in session.exec(select(models.Workspace)).all()}
    usernames = {u.id: u.username for u in session.exec(select(models.User)).all()}
    out = []
    for t in rows:
        owner = ""
        if t.workspace_id:
            ws = session.get(models.Workspace, t.workspace_id)
            owner = usernames.get(ws.user_id, "") if ws else ""
        out.append(
            {
                "id": t.id,
                "monitor": t.caller == "monitor",
                "caller": t.caller or "a2a-client",
                "from_workspace": ws_names.get(t.from_workspace_id, "") if t.from_workspace_id else "",
                "target": ws_names.get(t.workspace_id, "") if t.workspace_id else "",
                "owner": owner,
                "external_url": t.external_url or "",
                "instruction": _masked(t.message_enc, t.message),
                "result": _masked(t.artifact_enc, t.artifact),
                "error": _masked(t.error_enc, t.error),
                "status": t.status,
                "created_at": t.created_at.isoformat() + "Z",
                "done_at": t.done_at.isoformat() + "Z" if t.done_at else None,
            }
        )
    return {"calls": out}
