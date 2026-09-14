import hmac
import os
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, Request
from sqlmodel import Session, select

from server import models
from server.db import get_session

JWT_SECRET = os.environ.get("AGENT_SWARM_JWT_SECRET", "agent-swarm-dev-secret-change-me")
JWT_EXPIRE_HOURS = 24


def create_token(user_id: str, username: str) -> str:
    payload = {
        "sub": user_id,
        "username": username,
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRE_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def get_current_user(request: Request, session: Session = Depends(get_session)) -> models.User:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    token = auth.removeprefix("Bearer ").strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, "invalid or expired token")
    user = session.get(models.User, payload.get("sub"))
    if not user:
        raise HTTPException(401, "user not found")
    return user


def authenticate_api_key(request: Request, session: Session = Depends(get_session)) -> models.User:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "missing api key")
    key = auth.removeprefix("Bearer ").strip()
    key_hash = models.hash_api_key(key)
    user = session.exec(
        select(models.User).where(models.User.api_key_hash == key_hash)
    ).first()
    if not user or not hmac.compare_digest(user.api_key_hash, key_hash):
        raise HTTPException(401, "invalid api key")
    return user


def get_user_either(request: Request, session: Session = Depends(get_session)) -> models.User:
    """JWT 或 apikey 任一通过即可（web 用 JWT，插件/TUI 用 apikey）。"""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "missing bearer token")
    token = auth.removeprefix("Bearer ").strip()
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        user = session.get(models.User, payload.get("sub"))
        if user:
            return user
    except jwt.PyJWTError:
        pass
    key_hash = models.hash_api_key(token)
    user = session.exec(
        select(models.User).where(models.User.api_key_hash == key_hash)
    ).first()
    if not user or not hmac.compare_digest(user.api_key_hash, key_hash):
        raise HTTPException(401, "invalid or expired token")
    return user
