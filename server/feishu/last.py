"""任务受理回执与 /swarm last（最后一次问答细节卡片）。"""
import json
import logging

from sqlmodel import Session, select

from server import models
from server.db import engine

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
        events = [
            json.loads(e.payload)
            for e in session.exec(
                select(models.A2aEvent)
                .where(models.A2aEvent.task_id == task.id)
                .order_by(models.A2aEvent.id)  # type: ignore[attr-defined]
            ).all()
        ]
        return task, events


def _fmt_tool(ev: dict) -> str | None:
    """任务事件（metadata.nexus 平级字段）与监控事件（扁平 tool/title/toolState）统一解析。"""
    meta = (ev.get("metadata") or {}).get("nexus")
    if isinstance(meta, dict):
        if meta.get("type") != "tool":
            return None
        state_ = str(meta.get("tool_state") or meta.get("toolState") or "")
        title = str(meta.get("tool") or meta.get("title") or "工具调用")
        input_ = meta.get("input")
        if isinstance(input_, dict):
            cmd = input_.get("command") or input_.get("cmd") or input_.get("description")
            if cmd:
                title = f"{title}：{str(cmd)[:60]}"
    else:
        # 监控事件：{type:"tool", tool?, title?, toolState?}
        if ev.get("type") != "tool":
            return None
        state_ = str(ev.get("toolState") or ev.get("tool_state") or "")
        title = str(ev.get("title") or ev.get("tool") or "工具调用")
    icon = {"running": "⚙️", "completed": "✅", "error": "❌"}.get(state_, "⚙️")
    return f"{icon} {title}"


async def send_last(chat_id: str, user_id: str, send_card, send_text) -> None:
    from . import state, workspaces

    chat = state.get_chat(chat_id)
    ws = workspaces.get_own_workspace(user_id, chat.workspace_id) if chat and chat.workspace_id else None
    if ws is None:
        await send_text(chat_id, "先 `/swarm select` 选择工作区。")
        return

    task, events = _last_task_round(user_id, ws.id)
    if task is None:
        await send_text(chat_id, f"工作区 **{ws.name}** 还没有任务记录。")
        return

    lines: list[str] = [f"**任务** `{task.id[:8]}` · {task.status}"]
    # 用户提问优先用任务 message（监控轮才靠 user-text 事件回填）
    if task.message:
        lines.append(f"\n**👤 提问**\n{task.message[:500]}")
    thinking: list[str] = []
    tools: list[str] = []
    texts: list[str] = []
    for ev in events:
        kind = ev.get("kind")
        is_monitor_task = task.caller == "monitor"
        if is_monitor_task:
            # 监控轮事件 payload 是扁平结构 {type, text, tool, ...}（payload 里没有 kind 字段）
            mtype = ev.get("type", "")
            if mtype == "reasoning":
                t = ev.get("text", "")
                if t:
                    thinking.append(t)
            elif mtype == "tool":
                s = _fmt_tool(ev)
                if s:
                    tools.append(s)
            elif mtype == "text":
                t = ev.get("text", "")
                if t:
                    texts.append(t)
        elif kind == "status":
            all_meta = ev.get("metadata") or {}
            meta = all_meta.get("nexus") or {}
            meta_dict = all_meta if isinstance(meta, str) else {}
            ntype = str(meta) if isinstance(meta, str) else meta.get("type", "")
            if isinstance(meta, str):
                # A2A 任务事件：metadata.nexus 是字符串标签（text/reasoning/tool），
                # 细节字段（text/tool/tool_state/input）在 metadata 平级
                if meta == "reasoning" and meta_dict.get("text"):
                    thinking.append(meta_dict["text"])
                elif meta == "tool":
                    state_ = str(meta_dict.get("tool_state") or "running")
                    name = str(meta_dict.get("tool") or "工具调用")
                    input_ = meta_dict.get("input")
                    if isinstance(input_, dict):
                        cmd = input_.get("command") or input_.get("cmd") or input_.get("description")
                        if cmd:
                            name = f"{name}：{str(cmd)[:60]}"
                    icon = {"running": "⚙️", "completed": "✅", "error": "❌"}.get(state_, "⚙️")
                    tools.append(f"{icon} {name}")
                elif meta == "text" and meta_dict.get("text"):
                    texts.append(meta_dict["text"])
            elif ntype == "reasoning" and meta.get("text"):
                thinking.append(meta["text"])
            elif ntype == "tool":
                s = _fmt_tool(ev)
                if s:
                    tools.append(s)
            elif ntype == "text" and meta.get("text"):
                texts.append(meta["text"])
        elif kind == "artifact" and ev.get("artifact"):
            parts = (ev.get("artifact") or {}).get("parts") or []
            for p in parts:
                if p.get("kind") == "text" and p.get("text"):
                    texts.append(p["text"])
    if thinking:
        joined = "\n".join(thinking)
        lines.append(f"\n**💭 思考**\n{joined[:800]}")
    if tools:
        lines.append("\n**🛠 工具调用**\n" + "\n".join(tools[:15]))
    answer = texts[-1] if texts else (task.artifact or "")
    if answer:
        lines.append(f"\n**🤖 回答**\n{answer[:1200]}")
    if not answer and not thinking and not tools:
        lines.append("\n（无过程事件——任务可能刚派发或由后台会话执行中）")

    await send_card(chat_id, {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "green",
            "title": {"tag": "plain_text", "content": f"最后一次问答 · {ws.name}"},
        },
        "elements": [{"tag": "div", "text": {"tag": "lark_md", "content": "\n".join(lines)}}],
    })
