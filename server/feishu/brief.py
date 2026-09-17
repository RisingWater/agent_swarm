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

from server import models
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


def brief_card(task: models.A2aTask, workspace_name: str) -> dict:
    """简报单卡：来源 + 提问首行 + 最终回答/失败原因。"""
    failed = task.status == "failed"
    header_tpl = "red" if failed else "green"
    title = f"{'❌ 任务失败' if failed else '✅ 任务完成'} · {workspace_name}"
    question = (task.message or "").strip().replace("\r", "\n")
    first_line = next((ln.strip() for ln in question.split("\n") if ln.strip()), "")
    parts = [f"📤 {_sender_desc(task)}"]
    if first_line:
        parts.append(f"**❓ 提问**\n{first_line[:200]}")
    if failed:
        err = (task.error or "").strip() or "执行出错"
        parts.append(f"**💥 失败原因**\n{err[:600]}")
    else:
        answer = (task.artifact or "").strip()
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
    if event.get("kind") != "status-update":
        return
    status_obj = event.get("status") or {}
    state_ = str(status_obj.get("state", ""))
    if state_ not in ("completed", "failed"):
        return
    task_id = str(event.get("taskId", ""))
    if not task_id or not workspace_id:
        return
    with Session(engine) as session:
        task = session.get(models.A2aTask, task_id)
        if task is None:
            return
        # 飞书自己下发的任务：timeline 全程卡已覆盖
        if task.caller == "nexus-feishu":
            return
        ws_name = ""
        ws = session.get(models.Workspace, workspace_id)
        if ws is not None:
            ws_name = ws.name
        card_task = task.model_copy()
    # 监控轮：monitor_on 的窗口有时间线详情，排除掉；其他窗口照发简报
    exclude: set[str] = set()
    if card_task.caller == "monitor":
        exclude = {c.chat_id for c in state.chats_watching_workspace(workspace_id)}
    chats = state.brief_chats_for_workspace(workspace_id, exclude)
    if not chats:
        return
    gw = _gw_ref()
    if gw is None:
        return
    card = brief_card(card_task, ws_name or "工作区")
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
