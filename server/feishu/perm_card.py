"""权限/提问单卡：所有工作区（agent 互调 / web 中枢 / A2A 外部）任务进入
input-required 时，向 brief_on 的所有飞书窗口推一张操作卡——人在外面也能远程应答，
流程不再卡死到第二天。

- monitor 轮跳过（时间线卡已有按钮）
- 飞书自发任务跳过（走时间线，bridge 负责）
- 应答/收尾：回调返回替换卡（CallBackCard raw），终态时补发收尾卡（简报照发，两张卡）
- 注册表 task_id → [chat_id]：同一任务只维护一张卡（重复 input-required 更新同一批窗口）
"""
import logging

from sqlmodel import Session

from server import models
from server.db import engine
from server.nexus_a2a import internal_listeners

from . import state

log = logging.getLogger("nexus-feishu")

_LISTENER = "nexus-feishu-perm-card"

# task_id → {"chat_ids": set[str], "request_id": str, "itype": str}
_active: dict[str, dict] = {}

_gw = None


def set_gateway(gw) -> None:
    global _gw
    _gw = gw


def bind_listener() -> None:
    if _LISTENER not in internal_listeners:
        internal_listeners.append(_on_event)


def unbind_listener() -> None:
    try:
        internal_listeners.remove(_on_event)
    except ValueError:
        pass


def is_active(task_id: str) -> bool:
    """gateway 应答回调判断：该任务是否由本模块发过权限卡。"""
    return task_id in _active


def _sender_desc(task: models.A2aTask) -> str:
    if task.external_url:
        return "🔗 A2A 外部 agent"
    if task.caller == "agent":
        return "🤝 agent 互调"
    if task.caller == "nexus-web":
        return "🌐 网页中枢"
    return task.caller or "a2a-client"


def _task_line(task: models.A2aTask, owner_key: str = "") -> str:
    from server import crypto

    question = crypto.decrypt(owner_key, task.message_enc, task.message).strip().replace("\r", "\n")
    return next((ln.strip() for ln in question.split("\n") if ln.strip()), "")[:120]


def _input_data(event: dict) -> dict:
    # A2A 事件：status.message.parts[].data；监控轮事件：扁平 payload（type/requestId/... 直接在顶层）
    msg = (event.get("status") or {}).get("message") or {}
    for p in msg.get("parts") or []:
        if p.get("kind") == "data":
            return p.get("data") or {}
    if not event.get("kind") and event.get("type"):
        return event
    return {}


def perm_card(task: models.A2aTask, workspace_name: str, event: dict, owner_key: str = "") -> dict:
    """权限/提问操作卡：工作区名 + 任务摘要 + 请求内容 + 按钮组。"""
    data = _input_data(event)
    itype = str(data.get("type", "permission"))
    request_id = str(data.get("requestId") or task.id)
    body: list[str] = [f"📤 {_sender_desc(task)}"]
    task_line = _task_line(task, owner_key)
    if task_line:
        body.append(f"📋 任务：{task_line}")

    if itype == "question":
        q = str(data.get("question") or "AI 有问题需要确认")
        body.append(f"❓ 提问：{q[:300]}")
        elements = [
            {"tag": "div", "text": {"tag": "lark_md", "content": "\n\n".join(body)}},
            {"tag": "hr"},
        ]
        btns = []
        for opt in (data.get("options") or [])[:6]:
            label = str(opt if isinstance(opt, str) else (opt.get("label") or opt.get("value") or ""))
            if label:
                btns.append({
                    "tag": "button",
                    "text": {"tag": "plain_text", "content": label[:20]},
                    "type": "default",
                    "value": {"action": "feishu_reply", "taskId": task.id,
                              "reply": label, "requestId": request_id},
                })
        if btns:
            elements.append({
                "tag": "column_set", "flex_mode": "none", "background_style": "default",
                "columns": [{"tag": "column", "width": "weighted", "weight": 1,
                             "elements": [b]} for b in btns],
            })
        elements.append({
            "tag": "note",
            "elements": [{"tag": "plain_text",
                          "content": "其他回答：直接在输入框发送即可"}],
        })
    else:
        perm = str(data.get("permission") or "操作")
        title = str(data.get("title") or data.get("pattern") or "")
        body.append(f"🔐 权限请求：{perm}" + (f" — {title[:160]}" if title else ""))
        elements = [
            {"tag": "div", "text": {"tag": "lark_md", "content": "\n\n".join(body)}},
            {"tag": "hr"},
            {
                "tag": "column_set", "flex_mode": "none", "background_style": "default",
                "columns": [
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": [{
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "✅ 允许"},
                        "type": "primary",
                        "value": {"action": "feishu_reply", "taskId": task.id,
                                  "reply": "allow", "requestId": request_id},
                    }]},
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": [{
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "✅ 本会话允许"},
                        "type": "default",
                        "value": {"action": "feishu_reply", "taskId": task.id,
                                  "reply": "always", "requestId": request_id},
                    }]},
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": [{
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "❌ 拒绝"},
                        "type": "danger",
                        "value": {"action": "feishu_reply", "taskId": task.id,
                                  "reply": "reject", "requestId": request_id},
                    }]},
                ],
            },
        ]
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "orange",
            "title": {"tag": "plain_text", "content": f"⏸️ 等待应答 · {workspace_name}"[:40]},
        },
        "elements": elements,
    }


def answered_card(task_id: str) -> dict:
    """应答后回调替换卡（无按钮，提示已交给工作区继续执行）。"""
    info = _active.get(task_id) or {}
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "blue",
            "title": {"tag": "plain_text", "content": "✅ 已应答"},
        },
        "elements": [{
            "tag": "div",
            "text": {"tag": "lark_md",
                     "content": "应答已发送，工作区继续执行中。完成后会推送结果简报。"},
        }],
    }


async def _on_event(workspace_id: str, event: dict) -> None:
    kind = event.get("kind")
    if not kind and event.get("type") in ("permission", "question"):
        # 监控轮（TUI 前台会话）的权限/提问：四方应答先答先算（TUI/web 现成），
        # 飞书在这里发独立卡（随 brief_on 窗口）。task_id = roundKey（a2a_tasks 里
        # caller=monitor 的轮行 id），按钮应答走 reply 端点与 web 同路。
        task_id = str(event.get("roundKey", ""))
        if task_id and workspace_id:
            await _on_input_required(workspace_id, event, task_id, from_monitor=True)
        return
    if kind != "status-update":
        return
    state_ = str((event.get("status") or {}).get("state", ""))
    task_id = str(event.get("taskId", ""))
    if not task_id or not workspace_id:
        return
    if state_ == "input-required":
        await _on_input_required(workspace_id, event, task_id)
    elif state_ in ("completed", "failed", "canceled", "working"):
        await _on_leave_input(workspace_id, task_id, state_)


async def _on_input_required(workspace_id: str, event: dict, task_id: str, from_monitor: bool = False) -> None:
    with Session(engine) as session:
        task = session.get(models.A2aTask, task_id)
        if task is None:
            return
        if from_monitor:
            # 监控轮事件（TUI 前台会话）：轮行 caller 必然是 monitor，这正是要发卡的来源，
            # 不能走下面的排除逻辑。四方应答先答先算（TUI/web 现成，飞书卡 + 微信卡在此补齐）
            pass
        elif task.caller in ("nexus-feishu", "monitor"):
            return  # 飞书自发任务走时间线；monitor 轮时间线卡已有按钮
        ws = session.get(models.Workspace, workspace_id)
        ws_name = ws.name if ws else "工作区"
        owner_user_id = ws.user_id if ws else ""
        owner_key = ""
        if owner_user_id:
            u = session.get(models.User, owner_user_id)
            owner_key = (u.api_key or "") if u else ""
        card_task = task.model_copy()
    if not owner_user_id:
        return
    # 只发任务属主名下 brief_on 的窗口（跨用户不发）
    chats = state.brief_chats_all(owner_user_id, set())
    if not chats or _gw is None:
        return
    info = _active.get(task_id)
    data = _input_data(event)
    card = perm_card(card_task, ws_name, event, owner_key)
    # 同一任务重复 input-required（多轮权限/提问）：只推未收过该轮卡的窗口；
    # 简化处理：重发同一张卡（飞书里就是一条新消息，用户点最新的即可），并刷新注册表
    chat_ids = {c.chat_id for c in chats}
    _active[task_id] = {
        "chat_ids": chat_ids,
        "request_id": str(data.get("requestId") or task_id),
        "itype": str(data.get("type", "permission")),
    }
    for chat in chats:
        try:
            await _gw.send_card(chat.chat_id, card)
        except Exception:  # noqa: BLE001
            log.exception("权限卡推送失败 chat=%s", chat.chat_id)
    log.info("权限卡已推送 task=%s caller=%s windows=%s", task_id[:8], card_task.caller, len(chat_ids))


async def _on_leave_input(workspace_id: str, task_id: str, state_: str) -> None:
    """离开等待态：working（已应答/继续）→ 补发已应答提示；终态 → 收尾提示。

    回调换卡已覆盖点击者窗口；这里覆盖其他窗口（及 TUI 直接应答的场景）。
    """
    info = _active.pop(task_id, None)
    if info is None or _gw is None:
        return
    if state_ not in ("completed", "failed", "canceled", "working"):
        return
    text = "✅ 应答已生效，工作区继续执行中（完成后推送结果简报）。" if state_ == "working" \
        else f"任务已{'完成' if state_ == 'completed' else '失败' if state_ == 'failed' else '取消'}。"
    card = {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": "grey" if state_ != "working" else "blue",
            "title": {"tag": "plain_text", "content": "🔔 权限请求已处理"[:40]},
        },
        "elements": [{
            "tag": "div",
            "text": {"tag": "lark_md", "content": text},
        }],
    }
    for chat_id in info["chat_ids"]:
        try:
            await _gw.send_card(chat_id, card)
        except Exception:  # noqa: BLE001
            log.exception("权限卡收尾推送失败 chat=%s", chat_id)
