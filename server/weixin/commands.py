"""微信入站文本处理：菜单式交互（/q 菜单 + /N 编号选择）+ /swarm 兼容 + 待应答路由。

交互设计（微信无按钮，全部编号化）：
- /q 输出命令菜单，用户回 /1 /2 /3… 执行对应命令
- /swarm select（或菜单里的"选择工作区"）输出工作区列表，回 /1 /2 /3… 完成切换
- AI 权限/提问：输出编号选项，回编号或直接打字答
- 未识别的 / 命令：回复菜单（对齐飞书行为）
- 普通文本 = 给选中工作区派任务；有待应答时优先路由为应答

交互状态（一个问题状态机，_menus[uid]）：
{"kind": "menu" | "select_ws", "items": [...], "ts": float}，TTL 5 分钟。
权限/提问待应答走 state.get_pending（优先级最高）。
"""
from __future__ import annotations

import logging
import time as _time

import httpx
from sqlmodel import Session, select

from server import models
from server.db import engine
from server.nexus_a2a import reply_task_from_feishu  # 通用 reply 路由（feishu 命名沿用，非 feishu 专属）

from . import gateway, render, state

log = logging.getLogger("nexus-weixin")

MENU_ITEMS = [
    ("选择工作区", "select"),
    ("我的工作区", "list"),
    ("最近一轮问答", "last"),
    ("监控同步 开/关", "monitor"),
    ("简报 开/关", "brief"),
]

HELP = """**🤖 agent_swarm 指令**
/q — 命令菜单（回复 /1 /2 /3… 选择）
/swarm select — 选择工作区
/swarm list — 列出我的工作区
/swarm last — 最近一轮问答
/swarm monitor on|off — 监控同步
/swarm brief on|off — 简报
其他文字 = 给选中工作区派任务；AI 提问/要授权时直接回复即可"""

# 交互菜单注册表：user_id → {"kind", "items", "ts"}
# kind=menu: items=[(label, action)]；kind=select_ws: items=[(name, ws_id)]
# 菜单长期有效（无 TTL），直到被新菜单替换或使用掉；纯内存即可——
# 没有菜单时收到 /N 会回命令菜单而不是当任务派发（见 handle_inbound 1.5 步）
_menus: dict[str, dict] = {}


def _get_menu(uid: str) -> dict | None:
    return _menus.get(uid)


def _set_menu(uid: str, kind: str, items: list) -> None:
    _menus[uid] = {"kind": kind, "items": items, "ts": _time.time()}


def _pop_menu(uid: str) -> dict | None:
    return _menus.pop(uid, None)


def _menu_text(title: str, items: list[tuple[str, str]], footer: str = "") -> str:
    lines = [f"**{title}**"]
    for i, (label, _action) in enumerate(items, 1):
        lines.append(f"/{i}. {label}")
    if footer:
        lines.append(footer)
    return "\n".join(lines)


async def handle_inbound(sess: gateway.UserSession, text: str) -> None:
    """入口：菜单编号 → /swarm 指令 → 待应答应答 → 普通任务下发。"""
    uid = sess.user_id
    stripped = (text or "").strip()
    low = stripped.lower()
    log.info("weixin inbound user=%s text=%r", uid[:8], stripped[:60])

    # 1) 菜单编号应答（/1 /2 /3… 或纯数字）
    menu = _get_menu(uid)
    idx = _parse_index(stripped, len(menu["items"]) if menu else 0)
    if menu is not None and idx is not None and (stripped.startswith("/") or stripped.isdigit()):
        _pop_menu(uid)
        if menu["kind"] == "menu":
            await _run_menu_action(sess, menu["items"][idx][1])
        else:  # select_ws
            name, wid = menu["items"][idx]
            state.update_ws_settings(uid, workspace_id=wid)
            await reply_text(sess, f"✅ 已选择 **{name}**\n直接发文字即可派任务")
        return
    # 1.5) 编号但当前没有菜单：/N 不是任务——回命令菜单供选择
    if (stripped.startswith("/") and _is_ws_directive(stripped)) or stripped.isdigit():
        await reply_text(sess, _menu_text("🤖 命令菜单（回复编号执行）",
                                          [(l, a) for l, a in MENU_ITEMS],
                                          "其他文字 = 给选中工作区派任务"))
        _set_menu(uid, "menu", list(MENU_ITEMS))
        return

    # 2) 菜单命令
    if low in ("/help", "/指令", "help", "/swarm", "/q", "/菜单"):
        await reply_text(sess, _menu_text("🤖 命令菜单（回复编号执行）",
                                          [(l, a) for l, a in MENU_ITEMS],
                                          "其他文字 = 给选中工作区派任务"))
        _set_menu(uid, "menu", list(MENU_ITEMS))
        return
    if low.startswith("/swarm"):
        await _handle_swarm(sess, stripped)
        return
    if low in ("/time", "/重新连接"):
        await _legacy_cmd(sess, low)
        return

    # 3) 未识别的斜杠命令 → 回菜单（对齐飞书）
    if stripped.startswith("/") and len(stripped) > 1 and not _is_ws_directive(stripped):
        await reply_text(sess, f"❓ 未识别的命令 `{stripped}`\n\n" +
                         _menu_text("🤖 命令菜单（回复编号执行）",
                                    [(l, a) for l, a in MENU_ITEMS],
                                    "其他文字 = 给选中工作区派任务"))
        _set_menu(uid, "menu", list(MENU_ITEMS))
        return

    # 4) 待应答任务优先：权限/提问的编号或文字应答
    pending = state.get_pending(uid)
    if pending:
        await _answer_pending(sess, pending, stripped)
        return

    # 5) 普通文本 = 下发任务
    row = state.get_login(uid)
    if not row or not row.workspace_id:
        await _start_select_ws(sess)
        return
    from server.nexus_a2a import _send_message_core

    with Session(engine) as s:
        ws = s.get(models.Workspace, row.workspace_id)
        if ws is None or ws.user_id != uid:
            state.update_ws_settings(uid, workspace_id="")
            await _start_select_ws(sess, prefix="选中的工作区已失效，重新选择：\n\n")
            return
        try:
            await _send_message_core(ws, stripped, "nexus-weixin-clawbot")
        except Exception as exc:  # noqa: BLE001
            log.warning("weixin dispatch failed: %s", exc)
            await reply_text(sess, f"⚠️ 派发失败：{exc}")
            return
    await reply_text(sess, render.task_accepted_text(""))


def _is_ws_directive(text: str) -> bool:
    """斜杠 + 编号（菜单应答）不算未识别命令。"""
    t = text[1:]
    return t.isdigit()


async def _run_menu_action(sess: gateway.UserSession, action: str) -> None:
    if action == "select":
        await _start_select_ws(sess)
    elif action == "list":
        await _cmd_list(sess)
    elif action == "status":
        await _cmd_status(sess)
    elif action == "last":
        await _send_last(sess)
    elif action == "monitor":
        row = state.get_login(sess.user_id)
        on = not (row and row.monitor_on)
        state.update_ws_settings(sess.user_id, monitor_on=on)
        await reply_text(sess, f"监控同步已{'开启（thinking/工具将实时同步到这里）' if on else '关闭'}")
    elif action == "brief":
        row = state.get_login(sess.user_id)
        on = not (row and row.brief_on)
        state.update_ws_settings(sess.user_id, brief_on=on)
        await reply_text(sess, f"简报模式已{'开启' if on else '关闭'}")
    elif action == "time":
        await _cmd_time(sess)
    else:
        await reply_text(sess, HELP)


async def _start_select_ws(sess: gateway.UserSession, prefix: str = "") -> None:
    """输出工作区编号选择列表（菜单状态 kind=select_ws）。"""
    uid = sess.user_id
    with Session(engine) as s:
        rows = s.exec(
            select(models.Workspace)
            .where(models.Workspace.user_id == uid)
            .order_by(models.Workspace.name)  # type: ignore[attr-defined]
        ).all()
    if not rows:
        await reply_text(sess, "你还没有注册工作区（先在电脑上用 /swarm-add 注册）。")
        return
    if len(rows) == 1:
        state.update_ws_settings(uid, workspace_id=rows[0].id)
        await reply_text(sess, f"✅ 只有一个工作区，已自动选择 **{rows[0].name}**\n直接发文字即可派任务")
        return
    row = state.get_login(uid)
    items = []
    lines = [prefix + "**📍 回复编号选择工作区**"] if prefix else ["**📍 回复编号选择工作区**"]
    for i, w in enumerate(rows, 1):
        mark = "✅ " if row and w.id == row.workspace_id else ""
        on = "🟢" if (w.status == "online" and w.last_heartbeat) else "⚪"
        lines.append(f"/{i}. {mark}{on} {w.name}")
        items.append((w.name, w.id))
    _set_menu(uid, "select_ws", items)
    await reply_text(sess, "\n".join(lines))


async def _handle_swarm(sess: gateway.UserSession, raw: str) -> None:
    """/swarm 子命令（菜单化的兼容入口）。"""
    parts = raw.split()
    sub = parts[1].lower() if len(parts) > 1 else ""
    arg = parts[2].lower() if len(parts) > 2 else ""

    if sub in ("", "help", "指令", "menu", "q"):
        await reply_text(sess, _menu_text("🤖 命令菜单（回复编号执行）",
                                          [(l, a) for l, a in MENU_ITEMS],
                                          "其他文字 = 给选中工作区派任务"))
        _set_menu(sess.user_id, "menu", list(MENU_ITEMS))
    elif sub == "select":
        await _start_select_ws(sess)
    elif sub == "list":
        await _cmd_list(sess)
    elif sub == "status":
        await _cmd_status(sess)
    elif sub == "last":
        await _send_last(sess)
    elif sub == "monitor":
        if arg in ("on", "off"):
            on = arg == "on"
        else:
            row = state.get_login(sess.user_id)
            on = not (row and row.monitor_on)
        state.update_ws_settings(sess.user_id, monitor_on=on)
        await reply_text(sess, f"监控同步已{'开启（thinking/工具将实时同步到这里）' if on else '关闭'}")
    elif sub == "brief":
        if arg in ("on", "off"):
            on = arg == "on"
        else:
            row = state.get_login(sess.user_id)
            on = not (row and row.brief_on)
        state.update_ws_settings(sess.user_id, brief_on=on)
        await reply_text(sess, f"简报模式已{'开启' if on else '关闭'}")
    else:
        await reply_text(sess, f"❓ 未识别的命令 `{raw}`\n\n" +
                         _menu_text("🤖 命令菜单（回复编号执行）",
                                    [(l, a) for l, a in MENU_ITEMS],
                                    "其他文字 = 给选中工作区派任务"))
        _set_menu(sess.user_id, "menu", list(MENU_ITEMS))


async def _legacy_cmd(sess: gateway.UserSession, low: str) -> None:
    if low == "/time":
        await _cmd_time(sess)
    elif low == "/重新连接":
        state.update(sess.user_id, status="need_relogin")
        await reply_text(sess, "已标记重连，请到网页「账号 → 聊天工具绑定」重新扫码")


async def _cmd_time(sess: gateway.UserSession) -> None:
    row = state.get_login(sess.user_id)
    if row and row.logged_at:
        elapsed = (models.utcnow() - row.logged_at).total_seconds()
        left = max(0, int(24 * 3600 - elapsed))
        await reply_text(sess, f"⏱ 连接剩余约 {left // 3600} 小时 {(left % 3600) // 60} 分钟（协议参考值，失效会自动提示重扫）")
    else:
        await reply_text(sess, "未登录或缺少登录时间记录")


async def _cmd_list(sess: gateway.UserSession) -> None:
    uid = sess.user_id
    with Session(engine) as s:
        rows = s.exec(
            select(models.Workspace)
            .where(models.Workspace.user_id == uid)
            .order_by(models.Workspace.name)  # type: ignore[attr-defined]
        ).all()
    if not rows:
        await reply_text(sess, "你还没有注册工作区。")
        return
    row = state.get_login(uid)
    lines = ["**📍 我的工作区**"]
    for w in rows:
        mark = "✅ " if row and w.id == row.workspace_id else ""
        on = "🟢" if (w.status == "online" and w.last_heartbeat) else "⚪"
        lines.append(f"{mark}{on} {w.name}")
    lines.append("\n发 /q 可切换（选「选择工作区」）")
    await reply_text(sess, "\n".join(lines))


async def _cmd_status(sess: gateway.UserSession) -> None:
    uid = sess.user_id
    with Session(engine) as s:
        t = s.exec(
            select(models.A2aTask)
            .where(models.A2aTask.workspace_id.in_(  # type: ignore[attr-defined]
                select(models.Workspace.id).where(models.Workspace.user_id == uid)  # type: ignore[attr-defined]
            ))
            .order_by(models.A2aTask.created_at.desc())  # type: ignore[attr-defined]
            .limit(1)
        ).first()
    if t is None:
        await reply_text(sess, "还没有任务记录。")
        return
    label = {"queued": "⏳ 排队中", "working": "🔄 执行中", "input-required": "⏸ 等待你的输入",
             "completed": "✅ 已完成", "failed": "❌ 失败", "canceled": "🚫 已取消"}.get(t.status, t.status)
    await reply_text(sess, f"**最近任务** `{t.id[:8]}`\n状态：{label}")


async def _answer_pending(sess: gateway.UserSession, pending: dict, text: str) -> None:
    uid = sess.user_id
    task_id = pending["task_id"]
    kind = pending.get("kind", "permission")
    options = pending.get("options") or []
    idx = _parse_index(text, len(options))
    if kind == "permission":
        # 权限：只认编号（1=允许一次 2=始终允许 3=拒绝）；其它输入一律视为同意（once）
        if idx is None:
            idx = 0
        answer = ("once", "always", "reject")[idx]
    else:
        answer = options[idx] if idx is not None else text
    ok, msg = await reply_task_from_feishu(task_id, answer, f"wx-{uid[:8]}")
    if ok:
        state.clear_pending(uid)
        await reply_text(sess, "✅ 已应答，任务继续执行中。")
    else:
        await reply_text(sess, f"⚠️ 应答失败：{msg}")


def _parse_index(text: str, size: int) -> int | None:
    """/N、N、/1. xxx 都解析为第 N 项（1-based）。越界/非数字返回 None。"""
    t = (text or "").strip()
    if t.startswith("/"):
        t = t[1:].strip()
    if not t or size <= 0:
        return None
    head = t.split(".", 1)[0].split(" ", 1)[0]
    if head.isdigit():
        i = int(head)
        if 1 <= i <= size:
            return i - 1
    return None


async def _send_last(sess: gateway.UserSession) -> None:
    uid = sess.user_id
    from server import crypto

    with Session(engine) as s:
        row = s.get(models.WeixinLogin, uid)
        if row is None or not row.workspace_id:
            await _start_select_ws(sess, prefix="先选择工作区：\n\n")
            return
        ws = s.get(models.Workspace, row.workspace_id)
        t = s.exec(
            select(models.A2aTask)
            .where(models.A2aTask.workspace_id == row.workspace_id)
            .order_by(models.A2aTask.created_at.desc())  # type: ignore[attr-defined]
            .limit(1)
        ).first()
        if t is None:
            await reply_text(sess, f"工作区 **{ws.name if ws else ''}** 还没有任务记录。")
            return
        u = s.get(models.User, uid)
        key = (u.api_key or "") if u else ""
        instr = crypto.decrypt(key, t.message_enc, t.message)
        answer = crypto.decrypt(key, t.artifact_enc, t.artifact)
        error = crypto.decrypt(key, t.error_enc, t.error)
    text = render.brief_text(instr, answer, error, t.status == "failed", ws.name if ws else "工作区")
    await reply_text(sess, text)


async def reply_text(sess: gateway.UserSession, text: str) -> None:
    """回复当前用户（用最近 context_token；无 token 时只能记日志）。"""
    if not sess.context_token:
        log.warning("weixin reply skipped (no context_token) for user %s: %r", sess.user_id[:8], text[:50])
        return
    try:
        if sess.client is not None:
            await gateway.send_text(sess.client, sess.token, sess.baseurl, sess.wx_user_id, sess.context_token, text)
        else:
            async with httpx.AsyncClient() as client:
                await gateway.send_text(client, sess.token, sess.baseurl, sess.wx_user_id, sess.context_token, text)
        log.info("weixin reply sent user=%s: %r", sess.user_id[:8], text[:50])
    except gateway.ILinkError as exc:
        log.warning("weixin reply failed user=%s: %s", sess.user_id[:8], exc)
