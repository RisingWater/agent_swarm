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
    purpose_enc: Optional[str] = Field(default=None, sa_column=Column(Text))  # 密文（ENC_KEY 开启时用）
    capabilities: Optional[str] = Field(default=None, sa_column=Column(Text))
    notes: Optional[str] = Field(default=None, sa_column=Column(Text))
    notes_enc: Optional[str] = Field(default=None, sa_column=Column(Text))  # 密文
    status: str = Field(default="online", index=True)  # online / offline / disabled
    agent_type: str = Field(default="")  # agent 工具类型（opencode / claude code / ...）
    last_heartbeat: Optional[datetime] = None
    session_id: Optional[str] = None
    session_title: Optional[str] = None  # 当前会话标题（心跳上报，web 展示用）
    session_title_enc: Optional[str] = Field(default=None, sa_column=Column(Text))  # 密文
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class A2aTask(SQLModel, table=True):
    """A2A Task 持久化（内部工作区互调 + web 中枢下发 + 外部 A2A agent 共用一张表）。

    status 对齐 A2A TaskState：queued / working / input-required / completed / failed / canceled
    外部任务（external_url 非空）：workspace_id 为空，id 用远端返回的 task id。
    """
    __tablename__ = "a2a_tasks"

    id: str = Field(primary_key=True)
    context_id: str = Field(index=True)  # A2A contextId（同一会话链多轮任务共享）
    workspace_id: str = Field(default="", index=True)  # 执行方工作区（内部任务）
    user_id: str = Field(default="", index=True)  # 属主用户（加密子密钥派生用；外部任务=调用者）
    from_workspace_id: str = Field(default="")  # 发起方工作区（agent 互调时由 a2a_call 传入）
    external_url: str = Field(default="")  # 外部 A2A agent 端点（外部任务）
    caller: str = Field(default="")  # 调用方标注（agent / nexus-web / nexus-feishu / ...）
    message: str = Field(default="", sa_column=Column(Text))  # 初始指令文本
    message_enc: Optional[str] = Field(default=None, sa_column=Column(Text))  # 密文（ENC_KEY 开启时用）
    status: str = Field(default="queued", index=True)
    session_id: Optional[str] = None  # 目标端执行该任务的 opencode 会话
    artifact: Optional[str] = Field(default=None, sa_column=Column(Text))  # 最终结果（markdown）
    artifact_enc: Optional[str] = Field(default=None, sa_column=Column(Text))  # 密文
    error: Optional[str] = Field(default=None, sa_column=Column(Text))
    error_enc: Optional[str] = Field(default=None, sa_column=Column(Text))  # 密文
    created_at: datetime = Field(default_factory=utcnow)
    accepted_at: Optional[datetime] = None
    done_at: Optional[datetime] = None


class A2aEvent(SQLModel, table=True):
    """A2A 任务事件持久化（StatusUpdate / ArtifactUpdate，web 刷新后回放）。

    round_key：轮次分组键。任务事件 = task_id；前台监控事件 = mon-<sid>-<msg>。
    中枢回放/滚动分页按此列分组（最新一轮优先，向上滚动加载更早的轮）。
    """
    __tablename__ = "a2a_events"

    id: Optional[int] = Field(default=None, primary_key=True)
    task_id: str = Field(index=True)
    workspace_id: str = Field(default="", index=True)  # 内部任务才有（外部任务为空串）
    user_id: str = Field(default="", index=True)  # 属主用户（加密子密钥派生用）
    kind: str  # status / artifact / monitor（A2A 事件判别符）
    round_key: str = Field(default="", index=True)  # 轮次分组键（监控/任务轮）
    payload: str = Field(default="{}", sa_column=Column(Text))  # 事件 JSON（camelCase，原样存储）
    payload_enc: Optional[str] = Field(default=None, sa_column=Column(Text))  # 密文（ENC_KEY 开启时用）
    created_at: datetime = Field(default_factory=utcnow)


class FeishuBinding(SQLModel, table=True):
    """飞书用户 ↔ 平台账号绑定（open_id 唯一；一个飞书人只能绑一个账号）。"""
    __tablename__ = "feishu_bindings"

    open_id: str = Field(primary_key=True)  # 飞书 open_id（app 维度稳定）
    user_id: str = Field(foreign_key="users.id", index=True)
    bound_at: datetime = Field(default_factory=utcnow)


class FeishuChat(SQLModel, table=True):
    """飞书聊天窗口状态：每个窗口（p2p / 群）当前选中的工作区与监控开关。

    p2p 窗口 chat_id 即会话 id；群聊按群维度选中（同群共用一个选中工作区）。
    """
    __tablename__ = "feishu_chats"

    chat_id: str = Field(primary_key=True)
    chat_type: str = Field(default="p2p")  # p2p / group
    user_id: str = Field(default="", index=True)  # 最后操作者（绑定校验用；群聊=管理员）
    workspace_id: str = Field(default="", index=True)  # 当前选中（空=未选）
    monitor_on: bool = Field(default=False)  # 前台会话监控同步开关（默认关）
    brief_on: bool = Field(default=True)  # 任务完成简报开关（默认开；飞书自己下发的任务不推）
    updated_at: datetime = Field(default_factory=utcnow)
