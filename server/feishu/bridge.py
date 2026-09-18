"""事件桥：nexus_a2a.internal_listeners → 飞书时间线多卡。

任务事件（kind=status-update/artifact-update，taskId 命中飞书下发任务）与
监控事件（roundKey 形状）统一驱动 RoundCards 时间线：
用户卡 → 💭 思考卡 → 工具卡（每个 callId 一张）→ 📝 处理中卡 → 🤖 最终答复卡。
input-required（权限/提问）按钮挂到最新活动卡。
"""
import asyncio
import json
import logging
import re

from server.nexus_a2a import internal_listeners, ws_online

from . import cards, commands, state
from .stream_card import CardManager, RoundCards, normalize_title

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
    return [c.chat_id for c in state.selected_chats(workspace_id)]


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
    for chat_id in chats:
        rc = manager().get(task_id)
        if rc is None:
            if event.get("kind") == "artifact-update":
                continue  # 卡还没建（罕见）；artifact-only 不建卡
            rc = RoundCards(manager().gw, chat_id, task_id)
            rc.ensure_user_card(question)
            manager().register(task_id, rc)
        _apply_task_event(rc, event)


def _apply_task_event(rc: RoundCards, event: dict) -> None:
    """解析 A2A 事件驱动时间线。事件结构（对齐 web applyA2aEvent）：
    metadata.nexus = "text"|"reasoning"|"tool"（字符串标签），细节在 metadata 平级：
    text/reasoning → part_id + text + mode(replace/append)；
    tool → call_id + tool + tool_state + input；artifact → parts[].text。
    input-required 的类型/选项在 status.message.parts[].data。
    """
    kind = event.get("kind")
    status_obj = event.get("status") or {}
    state_ = str(status_obj.get("state", ""))
    meta = event.get("metadata") or {}
    ntype = str(meta.get("nexus", ""))
    task_id = str(event.get("taskId", ""))

    if kind == "artifact-update":
        return  # 最终答复卡由 completed 终态一次性写入（artifact 与终态 text 重复）

    if state_ == "input-required":
        rc.set_round_buttons(_input_required_actions(event, task_id))
        return
    if state_ in ("completed", "failed", "canceled"):
        detail = ""
        if state_ == "failed":
            parts = (status_obj.get("message") or {}).get("parts") or []
            detail = next((p.get("text", "") for p in parts if p.get("kind") == "text"), "")
        # 结论优先 artifact，其次最后 text 事件
        conclusion = _conclusion_of(rc, event)
        rc.finalize(state_, conclusion or detail[:200])
        asyncio.get_running_loop().call_later(
            600, lambda: manager().drop(task_id))
        return
    # working 下的流式过程
    if ntype == "reasoning":
        rc.ensure_thinking(str(meta.get("part_id", "r")), str(meta.get("text", "")))
    elif ntype == "tool":
        name = str(meta.get("tool", "") or "工具调用")
        st = str(meta.get("tool_state", "running"))
        input_ = meta.get("input")
        output = meta.get("output")
        rc.ensure_tool(str(meta.get("call_id", "")), name, st,
                       input_ if isinstance(input_, dict) else None,
                       str(output) if output else None)
    elif ntype == "text":
        # 任务流 text = 最终回答流式快照：暂存，finalize 时一次性出卡
        mode = str(meta.get("mode", "replace"))
        incoming = str(meta.get("text", ""))
        if not incoming:
            return
        if mode == "append":
            rc.pending_final_text = (rc.pending_final_text or "") + incoming
        else:
            rc.pending_final_text = incoming


def _conclusion_of(rc: RoundCards, event: dict) -> str:
    artifact = (event.get("artifact") or {}).get("parts") or []
    text = "\n".join(p.get("text", "") for p in artifact if p.get("kind") == "text")
    return text or (rc.pending_final_text or "")


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
    chats = [c.chat_id for c in state.chats_watching_workspace(workspace_id)]
    if not chats:
        return
    # 只推 monitor_on 的窗口（chats_watching_workspace 已按选中+开关过滤）
    for chat_id in chats:
        rc = manager().get(round_key)
        if rc is None:
            # 用户卡懒建：user-text（提问补拉，~300ms 后到）建卡带提问标题；
            # user 事件本身不建卡（此时文本还没拉到，标题只能是占位）。
            # 其他事件先到（user-text 拉取失败场景）也建卡，标题用会话占位。
            # 注意 continue 不能 return，多窗口会互相吞。
            if mtype == "user":
                continue
            if mtype == "user-text":
                q = str(payload.get("text", ""))
                rc = RoundCards(manager().gw, chat_id, round_key)
                rc.ensure_user_card(q)
            else:
                rc = RoundCards(manager().gw, chat_id, round_key)
                rc.ensure_user_card("")  # 占位标题"新对话"
            manager().register(round_key, rc)
        _apply_monitor_event(rc, round_key, mtype, payload)


def _apply_monitor_event(rc: RoundCards, round_key: str, mtype: str, payload: dict) -> None:
    if mtype == "reasoning":
        rc.ensure_thinking(str(payload.get("partId") or "r"), str(payload.get("text", "")))
    elif mtype == "tool":
        name = str(payload.get("tool") or "工具调用")
        st = str(payload.get("toolState") or "")
        input_ = payload.get("input")
        output = payload.get("output")
        rc.ensure_tool(str(payload.get("callId") or ""), name, st,
                       input_ if isinstance(input_, dict) else None,
                       str(output) if output else None)
    elif mtype == "text":
        # TUI 上的 assistant 文本 = 本轮回答流式快照，暂存到 finalize
        t = str(payload.get("text", ""))
        if t:
            rc.pending_final_text = t
    elif mtype in ("permission", "question"):
        rc.set_round_buttons(_monitor_actions(round_key, mtype, payload))
    elif mtype == "replied":
        rc.set_round_buttons([])
    elif mtype == "idle":
        rc.finalize("completed", rc.pending_final_text or "")
        asyncio.get_running_loop().call_later(600, lambda: manager().drop(round_key))


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
