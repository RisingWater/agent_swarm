"""事件桥：nexus_a2a.internal_listeners → 飞书流式卡片。

任务事件（kind=status-update/artifact-update，taskId 命中飞书下发任务）→ 更新该窗口的流式卡；
监控事件（roundKey 形状，无 kind）→ monitor_on 的窗口各建/更新一张监控卡；
input-required（权限/提问）→ 卡片出按钮组。
"""
import asyncio
import json
import logging

from server.nexus_a2a import internal_listeners, ws_online

from . import cards, commands, state
from .stream_card import CardManager, StreamingCard

log = logging.getLogger("nexus-feishu")

_manager: CardManager | None = None


def manager() -> CardManager:
    global _manager
    if _manager is None:
        _manager = CardManager(None)
    return _manager


def bind_gateway(gw) -> None:
    """gateway 启动时注入发送能力并注册内部监听。"""
    manager().gw = gw
    if _listener not in internal_listeners:
        internal_listeners.append(_listener)


def unbind_gateway() -> None:
    try:
        internal_listeners.remove(_listener)
    except ValueError:
        pass


# ────────────── 任务/监控 事件入口 ──────────────

async def _listener(workspace_id: str, event: dict) -> None:
    if event.get("kind") in ("status-update", "artifact-update"):
        await _on_task_event(workspace_id, event)
    elif not event.get("kind"):
        # 监控事件 payload：{roundKey, type, ...}（无 kind 字段）
        await _on_monitor_event(workspace_id, event)


def _chats_for_task(workspace_id: str, task_id: str) -> list[str]:
    """下发窗口（feishu_chats 中选中该工作区的窗口）——任务流推送目标。"""
    return [
        c.chat_id
        for c in state.selected_chats(workspace_id)
        if True
    ]


async def _on_task_event(workspace_id: str, event: dict) -> None:
    task_id = str(event.get("taskId", ""))
    if not task_id:
        return
    from server.db import engine
    from sqlmodel import Session
    from server import models

    # 只推飞书自己下发的任务
    question = ""
    with Session(engine) as session:
        task = session.get(models.A2aTask, task_id)
        if task is None or task.caller != commands.CALLER:
            return
        workspace_id = task.workspace_id
        question = str(task.message or "")

    chats = _chats_for_task(workspace_id, task_id)
    if not chats:
        return
    title = _question_title(question) or f"任务 {task_id[:8]}"
    for chat_id in chats:
        card = manager().get(task_id)
        if card is None:
            if event.get("kind") == "artifact-update":
                continue  # 卡还没建（罕见）；artifact-only 不建卡
            card = StreamingCard(None, chat_id, task_id, title=title)
            card.gw = _manager.gw
            card.status_text = "⏳ 正在生成回复"
            card.header_template = "blue"
            # 常驻中断按钮（working）
            card.actions = [{
                "tag": "button",
                "text": {"tag": "plain_text", "content": "🛑 中断"},
                "type": "danger",
                "value": {"action": "abort", "taskId": task_id},
            }]
            if not await card.open():
                card.degraded = True
            card.start()
            manager().register(task_id, card)
        _apply_task_event(card, event)


def _question_title(question: str) -> str:
    """卡片标题 = 提问首行（opencode-feishu normalizeReplyTitle 同款截取）。"""
    import re

    normalized = (question or "").replace("\r", "\n")
    first = next((ln.strip() for ln in normalized.split("\n") if ln.strip()), "")
    first = re.sub(r"\s+", " ", first).strip()
    if not first:
        return ""
    return first[:72]


def _apply_task_event(card: StreamingCard, event: dict) -> None:
    """解析 A2A 事件并更新卡片。事件结构（对齐 web applyA2aEvent）：
    metadata.nexus = "text"|"reasoning"|"tool"（字符串标签），细节在 metadata 平级字段：
    text/reasoning → part_id + text + mode(replace/append)；tool → call_id + tool + tool_state + input。
    input-required 的类型/选项在 status.message.parts[].data。
    """
    kind = event.get("kind")
    status_obj = event.get("status") or {}
    state_ = str(status_obj.get("state", ""))
    meta = event.get("metadata") or {}
    ntype = str(meta.get("nexus", ""))

    if kind == "artifact-update":
        parts = (event.get("artifact") or {}).get("parts") or []
        text = "\n".join(p.get("text", "") for p in parts if p.get("kind") == "text")
        if text:
            card.set_reply(text)
        return

    if state_ == "input-required":
        card.update_status("⏸️ 等待应答…（TUI 或这里）", "orange")
        card.set_actions(_input_required_actions(event, str(event.get("taskId", ""))))
        card.flush_now()
        return
    if state_ in ("completed", "failed", "canceled"):
        detail = ""
        if state_ == "failed":
            parts = (status_obj.get("message") or {}).get("parts") or []
            detail = next((p.get("text", "") for p in parts if p.get("kind") == "text"), "")
        card.finish(state_, detail[:60])
        card.flush_now()
        # 收尾后 10 分钟清理
        asyncio.get_running_loop().call_later(
            600, lambda: manager().drop(str(event.get("taskId", ""))))
        return
    # working 下的流式过程
    if ntype == "reasoning":
        card.set_reasoning(str(meta.get("text", "")))
    elif ntype == "tool":
        name = str(meta.get("tool", "") or "工具调用")
        st = str(meta.get("tool_state", "running"))
        input_ = meta.get("input")
        detail = ""
        if isinstance(input_, dict):
            detail = str(input_.get("command") or input_.get("cmd") or input_.get("description") or "")
        card.set_tool(str(meta.get("call_id", "")), name, st, detail[:60])
    elif ntype == "text":
        mode = str(meta.get("mode", "replace"))
        incoming = str(meta.get("text", ""))
        if not incoming:
            return
        if mode == "append":
            card.set_reply((card.reply_text or "") + incoming)
        else:
            card.set_reply(incoming)
        card.update_status("⏳ 正在生成回复", "blue")
    elif state_ == "working":
        card.update_status("⏳ 正在生成回复", "blue")


def _input_required_actions(event: dict, task_id: str) -> list[dict]:
    """input-required → 按钮组（permission 三选 / question 选项+自由回答提示）。"""
    msg = (event.get("status") or {}).get("message") or {}
    data = {}
    for p in msg.get("parts") or []:
        if p.get("kind") == "data":
            data = p.get("data") or {}
            break
    itype = str(data.get("type", "permission"))
    request_id = str(data.get("requestId") or task_id)
    actions: list[dict] = []
    if itype == "question":
        options = data.get("options") or []
        for opt in options[:6]:
            label = str(opt if isinstance(opt, str) else (opt.get("label") or opt.get("value") or ""))
            if not label:
                continue
            actions.append({
                "tag": "button",
                "text": {"tag": "plain_text", "content": label[:20]},
                "type": "default",
                "value": {"action": "feishu_reply", "taskId": task_id, "reply": label, "requestId": request_id},
            })
        actions.append({
            "tag": "button",
            "text": {"tag": "plain_text", "content": "✍️ 自由回答（直接发消息）"},
            "type": "default",
            "value": {"action": "reply_hint", "taskId": task_id},
        })
    else:
        actions.append({
            "tag": "button",
            "text": {"tag": "plain_text", "content": "✅ 允许"},
            "type": "primary",
            "value": {"action": "feishu_reply", "taskId": task_id, "reply": "allow", "requestId": request_id},
        })
        actions.append({
            "tag": "button",
            "text": {"tag": "plain_text", "content": "✅ 本会话允许"},
            "type": "default",
            "value": {"action": "feishu_reply", "taskId": task_id, "reply": "always", "requestId": request_id},
        })
        actions.append({
            "tag": "button",
            "text": {"tag": "plain_text", "content": "❌ 拒绝"},
            "type": "danger",
            "value": {"action": "feishu_reply", "taskId": task_id, "reply": "reject", "requestId": request_id},
        })
    return actions


# ────────────── 监控事件（TUI 实时同步，monitor_on 窗口） ──────────────

async def _on_monitor_event(workspace_id: str, payload: dict) -> None:
    round_key = str(payload.get("roundKey", ""))
    mtype = str(payload.get("type", ""))
    if not round_key or not mtype:
        return
    chats = [
        c.chat_id for c in state.chats_watching_workspace(workspace_id)
    ]
    if not chats:
        return
    # 只推 monitor_on 的窗口（chats_watching_workspace 已按选中+开关过滤）
    ws_label = await _monitor_title(workspace_id, payload)
    for chat_id in chats:
        card = manager().get(round_key)
        if card is None:
            # 监控卡懒建：user/user-text 开轮时建（其他事件先到：等 user-text 补齐再建，
            # 避免开一张没有提问内容的空卡——注意必须 continue 不能 return，多窗口会互相吞）
            if mtype not in ("user", "user-text"):
                continue
            question = str(payload.get("text", ""))
            title = _question_title(question) or ws_label
            card = StreamingCard(None, chat_id, round_key, title=title)
            card.gw = _manager.gw
            card.status_text = "⏳ 正在生成回复"
            card.header_template = "blue"
            if not await card.open():
                card.degraded = True
            card.start()
            manager().register(round_key, card)
        if mtype == "user-text":
            q = str(payload.get("text", ""))
            if q and card.title == ws_label:
                # 开轮时还没拉到提问文本，标题占位是会话标签——首行提问补为标题
                card.title = _question_title(q) or card.title
                card._dirty.set()
        elif mtype == "reasoning":
            card.set_reasoning(str(payload.get("text", "")))
        elif mtype == "tool":
            name = str(payload.get("tool") or payload.get("title") or "工具调用")
            st = str(payload.get("toolState") or "")
            call_id = str(payload.get("callId") or "")
            detail = _tool_detail(payload.get("input"))
            card.set_tool(call_id, name, st, detail)
        elif mtype == "text":
            card.set_reply(str(payload.get("text", "")))
            card.update_status("⏳ 正在生成回复", "blue")
        elif mtype in ("permission", "question"):
            card.update_status("⏸️ 等待应答…（TUI 或这里）", "orange")
            card.set_actions(_monitor_actions(round_key, mtype, payload))
            card.flush_now()
        elif mtype == "replied":
            card.update_status("✅ 已应答，继续执行…", "blue")
            card.set_actions([])
            card.flush_now()
        elif mtype == "idle":
            card.finish("completed")
            card.flush_now()
            asyncio.get_running_loop().call_later(600, lambda: manager().drop(round_key))


def _tool_detail(input_: object) -> str:
    """工具入参摘要（bash→command，其他→description/首字段），对齐任务卡样式。"""
    if not isinstance(input_, dict):
        return ""
    cmd = input_.get("command") or input_.get("cmd") or input_.get("description")
    if cmd:
        return str(cmd)[:60]
    for v in input_.values():
        if isinstance(v, str) and v.strip():
            return v[:60]
    return ""


async def _monitor_title(workspace_id: str, payload: dict) -> str:
    """监控卡标题占位：会话标题（心跳上报）> 会话 id 截断。user-text 到达后会被提问首行替换。"""
    from server.db import engine
    from sqlmodel import Session
    from server import models

    title = ""
    try:
        with Session(engine) as session:
            ws = session.get(models.Workspace, workspace_id)
            if ws is not None:
                title = str(ws.session_title or "")
    except Exception:  # noqa: BLE001
        pass
    if not title:
        title = f"会话 {str(payload.get('sessionId', ''))[:8]}"
    return f"{title[:40]}（实时）"


def _monitor_actions(round_key: str, itype: str, payload: dict) -> list[dict]:
    request_id = str(payload.get("requestId", "") or round_key)
    actions: list[dict] = []
    if itype == "question":
        for opt in (payload.get("options") or [])[:6]:
            label = str(opt if isinstance(opt, str) else (opt.get("label") or opt.get("value") or ""))
            if label:
                actions.append({
                    "tag": "button",
                    "text": {"tag": "plain_text", "content": label[:20]},
                    "type": "default",
                    "value": {"action": "feishu_reply", "taskId": round_key, "reply": label, "requestId": request_id},
                })
    else:
        actions.append({
            "tag": "button",
            "text": {"tag": "plain_text", "content": "✅ 允许"},
            "type": "primary",
            "value": {"action": "feishu_reply", "taskId": round_key, "reply": "allow", "requestId": request_id},
        })
        actions.append({
            "tag": "button",
            "text": {"tag": "plain_text", "content": "❌ 拒绝"},
            "type": "danger",
            "value": {"action": "feishu_reply", "taskId": round_key, "reply": "reject", "requestId": request_id},
        })
    return actions
