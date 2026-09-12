import shortuuid
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from server import models
from server.auth import create_token, get_current_user
from server.db import get_session

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterBody(BaseModel):
    username: str
    password: str


class LoginBody(BaseModel):
    username: str
    password: str


def user_out(u: models.User) -> dict:
    return {"id": u.id, "username": u.username, "created_at": u.created_at.isoformat() + "Z"}


@router.post("/register", status_code=201)
def register(body: RegisterBody, session: Session = Depends(get_session)):
    body.username = body.username.strip()
    if not (2 <= len(body.username) <= 32):
        raise HTTPException(422, "用户名长度需为 2-32 个字符")
    if len(body.password) < 6:
        raise HTTPException(422, "密码至少 6 位")
    exists = session.exec(
        select(models.User).where(models.User.username == body.username)
    ).first()
    if exists:
        raise HTTPException(409, "用户名已被占用")

    api_key = models.new_api_key()
    user = models.User(
        id=shortuuid.uuid(),
        username=body.username,
        password_hash=models.hash_password(body.password),
        api_key_hash=models.hash_api_key(api_key),
        api_key=api_key,
    )
    session.add(user)
    session.commit()
    return {"user": user_out(user), "api_key": api_key, "token": create_token(user.id, user.username)}


@router.post("/login")
def login(body: LoginBody, session: Session = Depends(get_session)):
    user = session.exec(
        select(models.User).where(models.User.username == body.username)
    ).first()
    if not user or not models.verify_password(body.password, user.password_hash):
        raise HTTPException(401, "用户名或密码错误")
    return {"token": create_token(user.id, user.username), "user": user_out(user)}
