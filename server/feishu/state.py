"""飞书侧状态存取：绑定表（feishu_bindings）与聊天窗口表（feishu_chats）。

所有函数自带 Session（短事务），供 gateway 线程桥接后的协程与命令处理直接调用。
"""
from sqlmodel import Session, select

from server import models
from server.db import engine


def user_id_by_open_id(open_id: str) -> str:
    """open_id → 平台 user_id；未绑定返回空串。"""
    with Session(engine) as session:
        row = session.exec(
            select(models.FeishuBinding).where(models.FeishuBinding.open_id == open_id)
        ).first()
        return row.user_id if row else ""


def bind(open_id: str, api_key: str) -> tuple[str, str]:
    """绑定 apikey。返回 (user_id, username)；key 无效抛 ValueError。"""
    key_hash = models.hash_api_key(api_key.strip())
    with Session(engine) as session:
        user = session.exec(
            select(models.User).where(models.User.api_key_hash == key_hash)
        ).first()
        if user is None or not models.api_key_matches(key_hash, user.api_key_hash):
            raise ValueError("apikey 无效，请到 web 端「API Key」页复制完整的 as_ 开头密钥")
        row = session.get(models.FeishuBinding, open_id)
        if row is None:
            session.add(models.FeishuBinding(open_id=open_id, user_id=user.id))
        else:
            row.user_id = user.id
            row.bound_at = models.utcnow()
            session.add(row)
        session.commit()
        return user.id, user.username


def unbind(open_id: str) -> bool:
    """解绑；同时清掉该用户聊天窗口的选中状态。返回是否确实绑过。"""
    with Session(engine) as session:
        row = session.get(models.FeishuBinding, open_id)
        if row is None:
            return False
        uid = row.user_id
        session.delete(row)
        for chat in session.exec(
            select(models.FeishuChat).where(models.FeishuChat.user_id == uid)
        ).all():
            chat.workspace_id = ""
            session.add(chat)
        session.commit()
        return True


def get_chat(chat_id: str) -> models.FeishuChat | None:
    with Session(engine) as session:
        return session.get(models.FeishuChat, chat_id)


def update_chat(chat_id: str, chat_type: str, user_id: str, **fields) -> models.FeishuChat:
    """创建/更新窗口行（workspace_id / monitor_on）。"""
    with Session(engine) as session:
        row = session.get(models.FeishuChat, chat_id)
        if row is None:
            row = models.FeishuChat(chat_id=chat_id, chat_type=chat_type, user_id=user_id)
        row.chat_type = chat_type or row.chat_type
        if user_id:
            row.user_id = user_id
        for k, v in fields.items():
            setattr(row, k, v)
        row.updated_at = models.utcnow()
        session.add(row)
        session.commit()
        session.refresh(row)
        return row


def selected_chats(workspace_id: str) -> list[models.FeishuChat]:
    """任务流推送目标：选中该工作区的窗口（无论 monitor 开关）。"""
    with Session(engine) as session:
        return list(session.exec(
            select(models.FeishuChat).where(models.FeishuChat.workspace_id == workspace_id)
        ).all())


def chats_watching_workspace(workspace_id: str) -> list[models.FeishuChat]:
    """监控流推送目标：选中该工作区且 monitor_on 的窗口。"""
    with Session(engine) as session:
        return list(session.exec(
            select(models.FeishuChat).where(
                models.FeishuChat.workspace_id == workspace_id,
                models.FeishuChat.monitor_on == True,  # noqa: E712
            )
        ).all())


def chat_bindings_for_user(user_id: str) -> list[models.FeishuChat]:
    with Session(engine) as session:
        return list(session.exec(
            select(models.FeishuChat).where(models.FeishuChat.user_id == user_id)
        ).all())
