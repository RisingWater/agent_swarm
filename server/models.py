import hashlib
import hmac
import secrets
from datetime import datetime, timezone
from typing import Optional

from sqlmodel import Field, SQLModel, Column, Text


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode()).hexdigest()


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000).hex()
    return f"pbkdf2_sha256$200000${salt}${digest}"


def verify_password(password: str, password_hash: str) -> bool:
    try:
        _, iters, salt, digest = password_hash.split("$")
        calc = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), salt.encode(), int(iters)
        ).hex()
        return hmac.compare_digest(calc, digest)
    except Exception:
        return False


def new_api_key() -> str:
    return "as_" + secrets.token_urlsafe(32)


def api_key_matches(provided_hash: str, stored_hash: str) -> bool:
    return hmac.compare_digest(provided_hash, stored_hash)


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: str = Field(primary_key=True)
    username: str = Field(index=True, unique=True)
    password_hash: str
    api_key_hash: str = Field(index=True, unique=True)
    api_key: str = ""  # 明文，登录后可随时查看
    created_at: datetime = Field(default_factory=utcnow)


class Team(SQLModel, table=True):
    __tablename__ = "teams"

    id: str = Field(primary_key=True)
    name: str = Field(index=True, unique=True)
    owner_id: str = Field(foreign_key="users.id", index=True)
    created_at: datetime = Field(default_factory=utcnow)


class TeamMember(SQLModel, table=True):
    __tablename__ = "team_members"

    id: Optional[int] = Field(default=None, primary_key=True)
    team_id: str = Field(foreign_key="teams.id", index=True)
    user_id: str = Field(foreign_key="users.id", index=True)


class Workspace(SQLModel, table=True):
    __tablename__ = "workspaces"

    id: str = Field(primary_key=True)
    user_id: str = Field(foreign_key="users.id", index=True)
    team_id: Optional[str] = Field(default=None, foreign_key="teams.id", index=True)
    name: str
    path: str = Field(index=True)
    purpose: str = Field(default="", sa_column=Column(Text))
    capabilities: Optional[str] = Field(default=None, sa_column=Column(Text))
    notes: Optional[str] = Field(default=None, sa_column=Column(Text))
    status: str = Field(default="online", index=True)  # online / offline / disabled
    last_heartbeat: Optional[datetime] = None
    session_id: Optional[str] = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class HelpRequest(SQLModel, table=True):
    __tablename__ = "help_requests"

    id: str = Field(primary_key=True)
    requester_ws_id: str = Field(foreign_key="workspaces.id", index=True)
    target_ws_id: str = Field(foreign_key="workspaces.id", index=True)
    question: str = Field(sa_column=Column(Text))
    mode: str = Field(default="background")  # foreground / background
    session_id: Optional[str] = None  # background 模式下指定目标会话
    status: str = Field(default="pending", index=True)  # pending/accepted/done/failed
    result: Optional[str] = Field(default=None, sa_column=Column(Text))
    error: Optional[str] = Field(default=None, sa_column=Column(Text))
    created_at: datetime = Field(default_factory=utcnow)
    accepted_at: Optional[datetime] = None
    done_at: Optional[datetime] = None
