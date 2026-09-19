"""任务受理回执与 /swarm last（最后一次问答细节卡片）。"""
import json
import logging

from sqlmodel import Session, select

from server import crypto, models
from server.db import engine

from . import event_text

log = logging.getLogger("nexus-feishu")


async def send_task_accepted(chat_id: str, snap: dict, send_text) -> None:
    """任务受理确认（轻文本；详细过程 Phase 2 用流式卡片）。"""
    status = (snap.get("status") or {}).get("state", "queued") if isinstance(snap.get("status"), dict) else "queued"
    await send_text(
        chat_id,
        f"📨 已派发任务 `{snap.get('id', '')[:8]}`（{status}）。\n过程与结果完成后这里会更新；也可在中枢网页实时查看。",
    )


def _last_task_round(user_id: str, workspace_id: str) -> tuple[models.A2aTask | None, list[dict]]:
    """取该工作区最近一个**轮次**（含前台监控轮 caller=monitor，按 created_at/更新时间最新优先）。

    返回 (task, events)。事件按 id 升序。
    """
    with Session(engine) as session:
        task = session.exec(
            select(models.A2aTask)
            .where(models.A2aTask.workspace_id == workspace_id)
            .order_by(models.A2aTask.created_at.desc())  # type: ignore[attr-defined]
        ).first()
        if task is None:
            return None, []
        events = []
        for e in session.exec(
            select(models.A2aEvent)
            .where(models.A2aEvent.task_id == task.id)
            .order_by(models.A2aEvent.id)  # type: ignore[attr-defined]
        ).all():
            try:
                events.append(json.loads(event_text.of(e)))
            except ValueError:
                continue
        return task, events


async def send_last(chat_id: str, user_id: str, send_card, send_text) -> None:
    from . import state, workspaces

    chat = state.get_chat(chat_id)
    ws = workspaces.get_own_workspace(user_id, chat.workspace_id) if chat and chat.workspace_id else None
    if ws is None:
        await send_text(chat_id, "先 `/swarm select` 选择工作区。")
        return

    task, _events = _last_task_round(user_id, ws.id)
    if task is None:
        await send_text(chat_id, f"工作区 **{ws.name}** 还没有任务记录。")
        return

    key = ""
    if ws.user_id:
        with Session(engine) as s:
            u = s.get(models.User, ws.user_id)
            key = (u.api_key or "") if u else ""
    question = crypto.decrypt(key, task.message_enc, task.message).strip()
    answer = crypto.decrypt(key, task.artifact_enc, task.artifact).strip()
    if not answer and not question:
        await send_text(chat_id, "最近一轮没有内容（任务可能刚派发或由后台会话执行中）。")
        return

    parts = []
    if question:
        parts.append(f"**❓ 提问**\n{question[:1500]}")
    if answer:
        parts.append(f"**💬 回答**\n{answer[:2500]}")
    else:
        parts.append("_（本轮还没有最终回答——可能仍在执行中）_")

    await send_card(chat_id, {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "green",
            "title": {"tag": "plain_text", "content": f"最后一次问答 · {ws.name}"},
        },
        "elements": [{"tag": "div", "text": {"tag": "lark_md", "content": "\n\n".join(parts)}}],
    })
