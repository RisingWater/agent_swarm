"""任务完成简报（brief 模式）。

所有工作区的任务（web 中枢 / agent 互调 / A2A 外部 / 前台监控轮）进入终态后，
向选中该工作区且 brief_on 的飞书窗口推一张单卡摘要。
例外（避免与时间线详情重复）：
- 飞书自己下发的任务（caller=nexus-feishu）：timeline 全程卡已覆盖，不发简报
- 监控轮（caller=monitor）：monitor_on 的窗口已有时间线，不发；brief_on 且
  未开监控的窗口仍发
- canceled：用户主动中断，不打扰
"""
import logging

from sqlmodel import Session

from server import crypto, models
from server.db import engine
from server.nexus_a2a import internal_listeners

from . import cards, state

log = logging.getLogger("nexus-feishu")

CALLER_LABELS = {
    "nexus-web": "🌐 网页中枢",
    "agent": "🤝 agent 调用",
    "a2a-client": "🔗 A2A 外部调用",
    "monitor": "👀 前台监控轮",
}

_LISTENER = "nexus-feishu-brief"


def bind_listener() -> None:
    if _LISTENER not in internal_listeners:
        internal_listeners.append(_on_event)


def unbind_listener() -> None:
    try:
        internal_listeners.remove(_on_event)
    except ValueError:
        pass


def _sender_desc(task: models.A2aTask) -> str:
    """任务发送人描述（对齐 api/calls.py 的 caller_name 逻辑，简版）。"""
    if task.external_url:
        return "🔗 A2A 外部 agent"
    if task.caller == "agent":
        return "🤝 其他工作区 agent"
    return CALLER_LABELS.get(task.caller, task.caller or "未知来源")


def brief_card(task: models.A2aTask, workspace_name: str, owner_key: str = "") -> dict:
    """简报单卡：来源 + 提问首行 + 最终回答/失败原因。owner_key 用于内容列解密。"""
    failed = task.status == "failed"
    header_tpl = "red" if failed else "green"
    title = f"{'❌ 任务失败' if failed else '✅ 任务完成'} · {workspace_name}"
    question = crypto.decrypt(owner_key, task.message_enc, task.message).strip().replace("\r", "\n")
    first_line = next((ln.strip() for ln in question.split("\n") if ln.strip()), "")
    parts = [f"📤 {_sender_desc(task)}"]
    if first_line:
        parts.append(f"**❓ 提问**\n{first_line[:200]}")
    if failed:
        err = crypto.decrypt(owner_key, task.error_enc, task.error).strip() or "执行出错"
        parts.append(f"**💥 失败原因**\n{err[:600]}")
    else:
        answer = crypto.decrypt(owner_key, task.artifact_enc, task.artifact).strip()
        if answer:
            parts.append(f"**💬 回答**\n{answer[:1500]}")
        else:
            parts.append("_（无最终回答文本）_")
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "template": header_tpl,
            "title": {"tag": "plain_text", "content": title[:40]},
        },
        "elements": [{
            "tag": "div",
            "text": {"tag": "lark_md", "content": "\n\n".join(parts)},
        }],
    }


async def _on_event(workspace_id: str, event: dict) -> None:
    task_id = ""
    state_ = ""
    if event.get("kind") == "status-update":
        # A2A 任务终态事件（web/agent/A2A 下发 + 被顶替的旧前台轮）
        state_ = str((event.get("status") or {}).get("state", ""))
        task_id = str(event.get("taskId", ""))
    elif not event.get("kind") and event.get("type") == "idle":
        # 监控轮 idle 收尾：handle_monitor_event 通知 listeners 的就是原始监控 payload，
        # 没有合成的 status-update——简报在这里补抓（否则监控轮完成永远不推简报）
        state_ = "completed"
        task_id = str(event.get("roundKey", ""))
    if state_ not in ("completed", "failed") or not task_id or not workspace_id:
        return
    with Session(engine) as session:
        task = session.get(models.A2aTask, task_id)
        if task is None:
            return
        # 飞书自己下发的任务：timeline 全程卡已覆盖
        if task.caller == "nexus-feishu":
            return
        ws_name = ""
        owner_user_id = ""
        owner_key = ""
        ws = session.get(models.Workspace, workspace_id)
        if ws is not None:
            ws_name = ws.name
            owner_user_id = ws.user_id
            u = session.get(models.User, ws.user_id) if ws.user_id else None
            owner_key = (u.api_key or "") if u else ""
        card_task = task.model_copy()
        card_owner_key = owner_key
    if not owner_user_id:
        return
    # 排除规则：
    # 1) 开了监控的窗口对**其选中的工作区**不收简报（监控时间线已是全程详情）——
    #    对其他工作区的任务仍收简报
    # 2) 监控轮（caller=monitor）在其选中工作区上开监控的窗口本来就被规则 1 排除，
    #    简报发给其余 brief_on 窗口
    # 简报发任务属主名下 brief_on 的所有窗口（不按选中工作区过滤，但限属主）
    exclude = {
        c.chat_id
        for c in state.chats_watching_workspace(workspace_id)
        if c.workspace_id == workspace_id
    }
    chats = state.brief_chats_all(owner_user_id, exclude)
    if not chats:
        return
    gw = _gw_ref()
    if gw is None:
        return
    card = brief_card(card_task, ws_name or "工作区", card_owner_key)
    for chat in chats:
        try:
            await gw.send_card(chat.chat_id, card)
        except Exception:  # noqa: BLE001
            log.exception("简报推送失败 chat=%s", chat.chat_id)


_gw_instance = None


def set_gateway(gw) -> None:
    global _gw_instance
    _gw_instance = gw


def _gw_ref():
    if _gw_instance is None:
        # bridge.manager().gw 兜底（bind_gateway 时已注入）
        from . import bridge
        _gw = getattr(bridge.manager(), "gw", None)
        if _gw is not None:
            set_gateway(_gw)
    return _gw_instance
