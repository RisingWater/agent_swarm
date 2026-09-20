"""聊天工具绑定（web 账号页）：查看/修改飞书窗口的选中工作区与监控、简报开关。

窗口属主校验：feishu_chats.user_id == 当前用户（飞书 bind/update_chat 写入）。
web 端修改后通过 state.notify_chat 主动通知对应飞书窗口。
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from server import models
from server.auth import get_current_user
from server.db import get_session
from server.feishu import contacts, state

router = APIRouter(prefix="/api/chat-binds", tags=["chat-binds"])


def _chat_out(chat: models.FeishuChat, session: Session) -> dict:
    ws = session.get(models.Workspace, chat.workspace_id) if chat.workspace_id else None
    return {
        "chat_id": chat.chat_id,
        "chat_type": chat.chat_type,
        "workspace_id": chat.workspace_id or "",
        "workspace_name": ws.name if ws else "",
        "monitor_on": bool(chat.monitor_on),
        "brief_on": bool(chat.brief_on),
    }


def _owned_chat(chat_id: str, user: models.User, session: Session) -> models.FeishuChat:
    chat = session.get(models.FeishuChat, chat_id)
    if chat is None or chat.user_id != user.id:
        raise HTTPException(status_code=404, detail="聊天窗口不存在或不属于当前账号")
    return chat


@router.get("")
def list_chat_binds(
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """当前账号的飞书绑定 + 每个绑定名下窗口的设置。"""
    bindings = session.exec(
        select(models.FeishuBinding).where(models.FeishuBinding.user_id == user.id)
    ).all()
    chats = session.exec(
        select(models.FeishuChat).where(models.FeishuChat.user_id == user.id)
    ).all()
    # open_id → 飞书真实用户名（contact:user.basic_profile:readonly；未授权/失败回退 id 前缀）
    from server.feishu.brief import _gw_ref

    names = contacts.resolve_names(_gw_ref(), [b.open_id for b in bindings])
    # 窗口按 user_id 维度归属（无 open_id 列）：有绑定时全部归绑定组，否则归 unbound
    groups = [{
        "open_id": b.open_id,
        "feishu_name": names.get(b.open_id, ""),
        "bound_at": b.bound_at.isoformat() if b.bound_at else None,
        "chats": [_chat_out(c, session) for c in chats],
    } for b in bindings]
    return {"bindings": groups, "unbound_chats": [_chat_out(c, session) for c in chats] if not bindings else []}


class ChatBindUpdate(BaseModel):
    workspace_id: str | None = None
    monitor_on: bool | None = None
    brief_on: bool | None = None


@router.put("/{chat_id}")
async def update_chat_bind(
    chat_id: str,
    body: ChatBindUpdate,
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """修改窗口设置（选中工作区 / 监控 / 简报），并通知对应飞书窗口。"""
    chat = _owned_chat(chat_id, user, session)
    changes: list[str] = []
    fields: dict = {}
    if body.workspace_id is not None and body.workspace_id != (chat.workspace_id or ""):
        if body.workspace_id:
            ws = session.get(models.Workspace, body.workspace_id)
            if ws is None or ws.user_id != user.id:
                raise HTTPException(status_code=404, detail="工作区不存在或不属于当前账号")
            changes.append(f"已切换工作区为 **{ws.name}**")
        else:
            changes.append("已取消工作区选择")
        fields["workspace_id"] = body.workspace_id
    if body.monitor_on is not None and body.monitor_on != bool(chat.monitor_on):
        changes.append(f"已{'开启' if body.monitor_on else '关闭'}监控模式")
        fields["monitor_on"] = body.monitor_on
    if body.brief_on is not None and body.brief_on != bool(chat.brief_on):
        changes.append(f"已{'开启' if body.brief_on else '关闭'}简报模式")
        fields["brief_on"] = body.brief_on
    if fields:
        row = state.update_chat(chat_id, chat.chat_type, user.id, **fields)
    else:
        row = chat
    if changes:
        import asyncio

        await state.notify_chat(chat_id, "🖥 你在网页上修改了设置：" + "；".join(changes) + "。")
    # notify 在事件循环内 await（FastAPI async 端点）；这里同步收尾返回最新状态
    return _chat_out(row, session)


@router.delete("/{open_id}")
async def unbind_chat_account(
    open_id: str,
    request: Request,
    user: models.User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """解绑飞书账号（web 账号页操作）：删除绑定行并清该用户窗口的工作区选择。

    通知该用户所有飞书窗口（bot 主动发消息；网关未启动时静默跳过）。
    """
    row = session.get(models.FeishuBinding, open_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "绑定不存在或不属于当前账号")
    # 找属主窗口（通知用，解绑后 chat 行还在只是清了选择）
    chat_ids = [c.chat_id for c in session.exec(
        select(models.FeishuChat).where(models.FeishuChat.user_id == user.id)
    ).all()]
    session.delete(row)
    for c in session.exec(
        select(models.FeishuChat).where(models.FeishuChat.user_id == user.id)
    ).all():
        c.workspace_id = ""
        session.add(c)
    session.commit()
    import asyncio

    for cid in chat_ids:
        await state.notify_chat(cid, "🖥 你在网页上解绑了飞书账号。下次使用请重新 `/swarm bind as_xxx`。")
    return {"ok": True}
