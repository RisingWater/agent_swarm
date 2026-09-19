"""飞书侧共用：A2aEvent payload 明文读取（解密 *_enc）。"""
from sqlmodel import Session

from server import crypto, models
from server.db import engine


def of(e: models.A2aEvent) -> str:
    """事件 payload 明文（优先解密 *_enc；密钥按 user_id/workspace→user 现查）。"""
    if not e.payload_enc:
        return e.payload
    uid = e.user_id
    if not uid and e.workspace_id:
        with Session(engine) as s:
            ws = s.get(models.Workspace, e.workspace_id)
            uid = ws.user_id if ws else ""
    key = ""
    if uid:
        with Session(engine) as s:
            u = s.get(models.User, uid)
            key = (u.api_key or "") if u else ""
    return crypto.decrypt(key, e.payload_enc, e.payload)
