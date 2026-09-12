import shortuuid
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from server import models
from server.auth import get_current_user
from server.db import get_session

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


@router.post("/apikey/reset", response_model=ResetOut)
def reset_apikey(
    user: models.User = Depends(get_current_user), session: Session = Depends(get_session)
):
    new_key = models.new_api_key()
    user.api_key_hash = models.hash_api_key(new_key)
    user.api_key = new_key
    session.add(user)
    session.commit()
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
