"""飞书指令与消息路由（纯逻辑，gateway 把飞书事件转成本模块的调用）。

指令：/swarm help|bind|unbind|list|select|status|monitor|last
普通文本：已绑定+已选中 → 下发任务（caller="nexus-feishu"）；未选中 → 弹选择卡；未绑定 → 宣传卡
"""
import logging

from server import models
from server.nexus_a2a import _send_message_core, ws_online
from server.db import engine
from sqlmodel import Session

from . import cards, state, workspaces

log = logging.getLogger("nexus-feishu")

CALLER = "nexus-feishu"

HELP = """🐝 **agent_swarm 指令**
/swarm bind as_xxx — 绑定账号（API Key 页复制）
/swarm unbind — 解绑
/swarm list — 我的工作区（在线/类型）
/swarm select — 选择当前窗口使用的工作区
/swarm status — 当前状态
/swarm monitor on|off — 前台会话实时同步开关（默认关）
/swarm last — 最后一次问答细节

绑定后直接发文本 = 给选中工作区派任务。"""


def _ws_or_none(user_id: str, workspace_id: str) -> models.Workspace | None:
    return workspaces.get_own_workspace(user_id, workspace_id)


async def handle_message(
    chat_id: str,
    chat_type: str,
    open_id: str,
    text: str,
    send_text,
    send_card,
) -> None:
    """所有飞书文本消息入口。send_text/send_card 为 gateway 注入的发送协程。"""
    text = (text or "").strip()
    if not text:
        return

    user_id = state.user_id_by_open_id(open_id)
    lower = text.lower()

    # 未绑定：只允许 bind / help，其余一律宣传卡
    if not user_id:
        if lower.startswith("/swarm bind"):
            await _cmd_bind(chat_id, chat_type, open_id, text, send_text)
        elif lower.startswith("/swarm help") or lower == "/swarm":
            await send_text(chat_id, HELP)
        else:
            await send_card(chat_id, cards.promo_card())
        return

    # 已绑定指令分发
    if lower.startswith("/swarm") or lower == "/swarm":
        await _dispatch_command(chat_id, chat_type, user_id, open_id, text, send_text, send_card)
        return

    # 普通文本 → 下发任务
    await _dispatch_task(chat_id, chat_type, user_id, text, send_text, send_card)


async def _cmd_bind(chat_id, chat_type, open_id, text, send_text) -> None:
    parts = text.split(None, 2)
    key = parts[2].strip() if len(parts) >= 3 else ""
    if not key:
        await send_text(chat_id, "用法：`/swarm bind as_你的密钥`（web 端「API Key」页复制）")
        return
    try:
        user_id, username = state.bind(open_id, key)
    except ValueError as e:
        await send_text(chat_id, f"❌ {e}")
        return
    # 顺手把该窗口绑定到操作者（群聊里他人后续 bind 会覆盖）
    state.update_chat(chat_id, chat_type, user_id)
    await send_text(
        chat_id,
        f"✅ 已绑定账号 **{username}**。\n发 `/swarm select` 选择工作区，之后直接发文本即可派任务。\n"
        "⚠️ 密钥已出现在聊天记录中，建议稍后在 web 端重置 API Key（绑定不受影响）。",
    )


async def _dispatch_command(chat_id, chat_type, user_id, open_id, text, send_text, send_card) -> None:
    parts = text.split()
    cmd = parts[1].lower() if len(parts) >= 2 else "help"
    arg = parts[2].lower() if len(parts) >= 3 else ""

    if cmd == "help":
        await send_text(chat_id, HELP)
    elif cmd == "bind":
        await send_text(chat_id, "该窗口已绑定。如需换号：`/swarm unbind` 后重新 bind。")
    elif cmd == "unbind":
        if state.unbind(open_id):
            await send_text(chat_id, "✅ 已解绑。下次使用请 `/swarm bind as_xxx`。")
        else:
            await send_text(chat_id, "该账号尚未绑定。")
    elif cmd == "list":
        rows = workspaces.list_workspaces(user_id)
        if not rows:
            await send_text(chat_id, "还没有注册任何工作区。在目标机器的 opencode/claude 里运行 `/swarm-add`。")
            return
        lines = []
        for w in rows:
            icon = "🟢" if w["online"] else "⚪"
            lines.append(f"{icon} {workspaces.agent_icon(w['agent_type'])} **{w['name']}** — {w['agent_type'] or '未知类型'}"
                         + ("" if w["online"] else "（离线）"))
        await send_text(chat_id, "\n".join(lines))
    elif cmd == "select":
        rows = workspaces.list_workspaces(user_id)
        await send_card(chat_id, cards.select_card(rows))
    elif cmd == "status":
        await _cmd_status(chat_id, user_id, send_text)
    elif cmd == "monitor":
        await _cmd_monitor(chat_id, chat_type, user_id, arg, send_text)
    elif cmd == "last":
        from .last import send_last
        await send_last(chat_id, user_id, send_card, send_text)
    else:
        await send_text(chat_id, f"未知指令 `{cmd}`。\n{HELP}")


async def _cmd_status(chat_id, user_id, send_text) -> None:
    chat = state.get_chat(chat_id)
    ws = _ws_or_none(user_id, chat.workspace_id) if chat and chat.workspace_id else None
    lines = ["🟢 已绑定"]
    if ws is None:
        lines.append("⚪ 未选择工作区（/swarm select）")
    else:
        online = ws_online(ws.id)
        icon = "🟢" if online else "⚪"
        lines.append(f"{icon} {ws.name}（{ws.agent_type or '未知'}）— {'在线' if online else '离线'}")
        lines.append(f"👀 监控：{'开' if chat and chat.monitor_on else '关'}")
    await send_text(chat_id, "\n".join(lines))


async def _cmd_monitor(chat_id, chat_type, user_id, arg, send_text) -> None:
    ws = _current_ws(chat_id, user_id)
    if ws is None:
        await send_text(chat_id, "先 `/swarm select` 选择工作区。")
        return
    if arg == "on":
        state.update_chat(chat_id, chat_type, user_id, monitor_on=True)
        await send_text(chat_id, f"👀 已开启 **{ws.name}** 前台会话实时同步（/swarm monitor off 关闭）。")
    elif arg == "off":
        state.update_chat(chat_id, chat_type, user_id, monitor_on=False)
        await send_text(chat_id, "已关闭前台会话实时同步。")
    else:
        await send_text(chat_id, "用法：`/swarm monitor on` 或 `/swarm monitor off`")


def _current_ws(chat_id: str, user_id: str) -> models.Workspace | None:
    chat = state.get_chat(chat_id)
    if chat is None or not chat.workspace_id:
        return None
    return _ws_or_none(user_id, chat.workspace_id)


async def _dispatch_task(chat_id, chat_type, user_id, text, send_text, send_card) -> None:
    ws = _current_ws(chat_id, user_id)
    if ws is None:
        rows = workspaces.list_workspaces(user_id)
        await send_card(chat_id, cards.select_card(rows))
        return
    if ws.status == "disabled":
        await send_text(chat_id, f"❌ 工作区 **{ws.name}** 已被禁用。")
        return
    if not ws_online(ws.id):
        await send_text(chat_id, f"❌ 工作区 **{ws.name}** 插件不在线（目标机器上的 opencode/claude 没开？）。")
        return
    snap = await _send_message_core(ws, text, CALLER)
    from .last import send_task_accepted
    await send_task_accepted(chat_id, snap, send_text)
