"""微信登录态/窗口设置读写 + 待应答任务注册表。

DB 行 = weixin_logins（一人一行，登录态与窗口设置合一）。
待应答：input-required 的任务入 _pending，用户文本回复按序号/原文路由到 reply 端点。
"""
from __future__ import annotations

import time

from sqlmodel import Session

from server import crypto, models
from server.db import engine


def get_login(user_id: str) -> models.WeixinLogin | None:
    with Session(engine) as s:
        row = s.get(models.WeixinLogin, user_id)
        if row is None:
            return None
        s.refresh(row)
        return row.model_copy()


def get_login_row(user_id: str) -> models.WeixinLogin | None:
    """带 session 关闭后的字段拷贝（同 get_login，语义别名）。"""
    return get_login(user_id)


def decrypt_token(user_id: str) -> str:
    """取该用户的 bot_token 明文（crypto 解密；无则空串）。"""
    with Session(engine) as s:
        row = s.get(models.WeixinLogin, user_id)
        if row is None:
            return ""
        u = s.get(models.User, user_id)
        key = (u.api_key or "") if u else ""
        return crypto.decrypt(key, row.token_enc, row.bot_token)


def update(user_id: str, **fields) -> None:
    with Session(engine) as s:
        row = s.get(models.WeixinLogin, user_id)
        if row is None:
            return
        for k, v in fields.items():
            setattr(row, k, v)
        row.updated_at = models.utcnow()
        s.add(row)
        s.commit()


def update_ws_settings(user_id: str, workspace_id: str | None = None,
                       monitor_on: bool | None = None, brief_on: bool | None = None) -> None:
    fields: dict = {}
    if workspace_id is not None:
        fields["workspace_id"] = workspace_id
    if monitor_on is not None:
        fields["monitor_on"] = monitor_on
    if brief_on is not None:
        fields["brief_on"] = brief_on
    if fields:
        update(user_id, **fields)


def set_context_token(user_id: str, context_token: str) -> None:
    update(user_id, context_token=context_token, context_at=models.utcnow())


# ---------------------------------------------------------------- 待应答任务（权限/提问）

# user_id → {"task_id": str, "kind": str, "options": [...], "question": str, "ts": float}
_pending: dict[str, dict] = {}
_PENDING_TTL = 3600.0


def set_pending(user_id: str, task_id: str, kind: str, question: str, options: list[str],
                request_id: str = "") -> None:
    _pending[user_id] = {
        "task_id": task_id,
        "kind": kind,
        "question": question,
        "options": options,
        "request_id": request_id,
        "ts": time.time(),
    }
    _gc_pending()


def get_pending(user_id: str) -> dict | None:
    p = _pending.get(user_id)
    if p and time.time() - p["ts"] > _PENDING_TTL:
        _pending.pop(user_id, None)
        return None
    return p


def clear_pending(user_id: str) -> None:
    _pending.pop(user_id, None)


def pop_pending_task(task_id: str) -> dict | None:
    """按 task_id 清 pending（跨渠道先答先算：任务被别处应答/离开等待态时调用）。

    命中返回被清的 pending，未命中返回 None（同一 user 只挂一个 pending）。
    """
    for uid, p in list(_pending.items()):
        if p.get("task_id") == task_id:
            _pending.pop(uid, None)
            return p
    return None


def _gc_pending() -> None:
    now = time.time()
    for uid in [u for u, p in _pending.items() if now - p["ts"] > _PENDING_TTL]:
        _pending.pop(uid, None)
