import hmac
import shortuuid
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from server import models
from server.auth import get_current_user
from server.db import get_session

router = APIRouter(prefix="/api/me", tags=["me"])


def _mask(key_hint: str) -> str:
    return key_hint[:6] + "*" * 8


@router.get("")
def me(user: models.User = Depends(get_current_user)):
    return {
        "id": user.id,
        "username": user.username,
        "created_at": user.created_at.isoformat() + "Z",
        "api_key_masked": _mask(user.id),
    }


@router.get("/apikey")
def get_apikey(user: models.User = Depends(get_current_user), session: Session = Depends(get_session)):
    # apikey 只存哈希，无法回显；返回掩码与指纹
    return {
        "masked": _mask(user.username),
        "fingerprint": user.api_key_hash[:12],
        "hint": "api key 明文仅在注册/重置时展示一次",
    }


class ResetOut(BaseModel):
    api_key: str


@router.post("/apikey/reset", response_model=ResetOut)
def reset_apikey(
    user: models.User = Depends(get_current_user), session: Session = Depends(get_session)
):
    new_key = models.new_api_key()
    user.api_key_hash = models.hash_api_key(new_key)
    session.add(user)
    session.commit()
    return ResetOut(api_key=new_key)
