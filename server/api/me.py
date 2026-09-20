import shortuuid
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from server import crypto, models
from server.auth import get_current_user
from server.db import engine, get_session

router = APIRouter(prefix="/api/me", tags=["me"])


@router.get("")
def me(user: models.User = Depends(get_current_user)):
    return {
        "id": user.id,
        "username": user.username,
        "created_at": user.created_at.isoformat() + "Z",
        "api_key": user.api_key,
    }


class ResetOut(BaseModel):
    api_key: str


def _reencrypt_user_rows(user_id: str, old_key: str, new_key: str) -> None:
    """用户 apikey 变更后，把其全部密文行用旧 key 解密、新 key 重加密（事务内逐行）。

    加密未启用 / 旧 key 解不开（丢过服务器密钥）的行保持原样——读侧会回退明文列。
    """
    if not crypto.enabled():
        return
    from server.db import DB_PATH
    import sqlite3

    con = sqlite3.connect(DB_PATH)
    try:
        # (table, enc_col, plain_col, id_col) — user_id 已知，直接按它筛
        jobs = [
            ("workspaces", "purpose_enc", "purpose", "id"),
            ("workspaces", "notes_enc", "notes", "id"),
            ("workspaces", "session_title_enc", "session_title", "id"),
            ("a2a_tasks", "message_enc", "message", "id"),
            ("a2a_tasks", "artifact_enc", "artifact", "id"),
            ("a2a_tasks", "error_enc", "error", "id"),
            ("a2a_events", "payload_enc", "payload", "id"),
        ]
        for table, ecol, pcol, idcol in jobs:
            cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
            if ecol not in cols:
                continue
            rows = con.execute(
                f"SELECT {idcol}, {ecol} FROM {table} WHERE user_id = ? AND {ecol} IS NOT NULL AND {ecol} != ''",
                (user_id,),
            ).fetchall()
            for rid, enc in rows:
                plain = crypto.decrypt(old_key, enc, None)
                if plain is None:
                    continue  # 旧 key 解不开（如服务器密钥曾丢失）：不动，读侧回退
                re_enc = crypto.encrypt(new_key, plain)
                if re_enc:
                    con.execute(f"UPDATE {table} SET {ecol} = ? WHERE {idcol} = ?", (re_enc, rid))
        con.commit()
    finally:
        con.close()


@router.post("/apikey/reset", response_model=ResetOut)
def reset_apikey(
    user: models.User = Depends(get_current_user), session: Session = Depends(get_session)
):
    old_key = user.api_key or ""
    new_key = models.new_api_key()
    user.api_key_hash = models.hash_api_key(new_key)
    user.api_key = new_key
    session.add(user)
    session.commit()
    # 历史密文全部重加密（否则旧 key 派生的子密钥解不开，历史内容会丢）
    _reencrypt_user_rows(user.id, old_key, new_key)
    engine.dispose()  # 刷新连接池，避免后续读连接持有旧页缓存（SQLite 场景保险起见）
    return ResetOut(api_key=new_key)


class ChangePasswordBody(BaseModel):
    old_password: str
    new_password: str


@router.post("/password")
def change_password(
    body: ChangePasswordBody,
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not models.verify_password(body.old_password, user.password_hash):
        raise HTTPException(401, "原密码不正确")
    new_password = body.new_password.strip()
    if len(new_password) < 6:
        raise HTTPException(422, "新密码至少 6 位")
    user.password_hash = models.hash_password(new_password)
    session.add(user)
    session.commit()
    return {"ok": True}
