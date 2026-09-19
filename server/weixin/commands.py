"""微信入站文本处理：/swarm 指令 + 待应答路由 + 普通文本下发任务。"""
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

HELP = """**🤖 agent_swarm 指令**
/swarm select — 选择工作区
/swarm list — 列出我的工作区
/swarm status — 当前任务状态
/swarm last — 最近一轮问答
/swarm monitor on/off — 监控同步开关
/swarm brief on/off — 简报开关
其他文字 = 给选中工作区派任务；AI 提问/要授权时直接回复即可"""


async def handle_inbound(sess: gateway.UserSession, text: str) -> None:
    """入口：指令 / 待应答应答 / 普通任务下发。"""
    uid = sess.user_id
    stripped = (text or "").strip()
    low = stripped.lower()

    if low in ("/help", "/指令", "help", "/swarm"):
        await reply_text(sess, HELP)
        return
    if low.startswith("/swarm") or low in ("/重新连接", "/time"):
        await _handle_command(sess, stripped)
        return

    # 待应答任务优先：权限/提问的编号或文字应答
    pending = state.get_pending(uid)
    if pending:
        await _answer_pending(sess, pending, stripped)
        return

    # 普通文本 = 下发任务
    row = state.get_login(uid)
    if not row or not row.workspace_id:
        await reply_text(sess, "先选择工作区：发送 /swarm select")
        return
    from server.nexus_a2a import _send_message_core

    with Session(engine) as s:
        ws = s.get(models.Workspace, row.workspace_id)
        if ws is None or ws.user_id != uid:
            state.update_ws_settings(uid, workspace_id="")
            await reply_text(sess, "选中的工作区已失效，请重新 /swarm select")
            return
        try:
            await _send_message_core(ws, stripped, "nexus-weixin-clawbot")
        except Exception as exc:  # noqa: BLE001
            log.warning("weixin dispatch failed: %s", exc)
            await reply_text(sess, f"⚠️ 派发失败：{exc}")
            return
    await reply_text(sess, render.task_accepted_text(""))


async def _handle_command(sess: gateway.UserSession, raw: str) -> None:
    uid = sess.user_id
    parts = raw.split()
    cmd = parts[0].lower() if parts else ""
    arg = parts[1].lower() if len(parts) > 1 else ""

    if cmd == "/time":
        row = state.get_login(uid)
        if row and row.logged_at:
            elapsed = (models.utcnow() - row.logged_at).total_seconds()
            left = max(0, int(24 * 3600 - elapsed))
            await reply_text(sess, f"⏱ 连接剩余约 {left // 3600} 小时 {(left % 3600) // 60} 分钟（协议参考值，失效会自动提示重扫）")
        else:
            await reply_text(sess, "未登录或缺少登录时间记录")
        return
    if cmd == "/重新连接":
        state.update(uid, status="need_relogin")
        await reply_text(sess, "已标记重连，请到网页「账号 → 聊天工具绑定」重新扫码")
        return

    if cmd != "/swarm":
        return
    sub = arg or "help"
    if sub in ("help", "指令"):
        await reply_text(sess, HELP)
    elif sub == "list":
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
        lines.append("\n用 /swarm select 切换")
        await reply_text(sess, "\n".join(lines))
    elif sub == "select":
        with Session(engine) as s:
            rows = s.exec(
                select(models.Workspace).where(models.Workspace.user_id == uid)
            ).all()
        if not rows:
            await reply_text(sess, "你还没有注册工作区。")
            return
        if len(rows) == 1:
            state.update_ws_settings(uid, workspace_id=rows[0].id)
            await reply_text(sess, f"✅ 已选择 **{rows[0].name}**")
            return
        lines = ["**📍 回复编号选择工作区**"]
        for i, w in enumerate(rows, 1):
            lines.append(f"{i}. {w.name}")
        _select_pending[uid] = {"ids": [w.id for w in rows], "names": [w.name for w in rows], "ts": _time.time()}
        await reply_text(sess, "\n".join(lines))
    elif sub == "status":
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
    elif sub == "last":
        await _send_last(sess)
    elif sub == "monitor":
        on = arg == "on"
        state.update_ws_settings(uid, monitor_on=on)
        await reply_text(sess, f"监控同步已{'开启（thinking/工具将实时同步到这里）' if on else '关闭'}")
    elif sub == "brief":
        on = arg == "on"
        state.update_ws_settings(uid, brief_on=on)
        await reply_text(sess, f"简报模式已{'开启' if on else '关闭'}")
    else:
        await reply_text(sess, HELP)


# /swarm select 的编号选择（与待应答同机制，独立小注册表）
_select_pending: dict[str, dict] = {}


async def _answer_pending(sess: gateway.UserSession, pending: dict, text: str) -> None:
    uid = sess.user_id
    # /swarm select 的编号选择（与待应答同机制，独立小注册表）
    sel = _select_pending.get(uid)
    if sel:
        if _time.time() - sel["ts"] > 300:
            _select_pending.pop(uid, None)
        else:
            idx = _parse_index(text, len(sel["ids"]))
            if idx is not None:
                _select_pending.pop(uid, None)
                wid, name = sel["ids"][idx], sel["names"][idx]
                state.update_ws_settings(uid, workspace_id=wid)
                await reply_text(sess, f"✅ 已选择 **{name}**")
                return
    task_id = pending["task_id"]
    options = pending.get("options") or []
    idx = _parse_index(text, len(options))
    answer = options[idx] if idx is not None else text
    ok, msg = await reply_task_from_feishu(task_id, answer, f"wx-{uid[:8]}")
    if ok:
        state.clear_pending(uid)
        await reply_text(sess, "✅ 已应答，任务继续执行中。")
    else:
        await reply_text(sess, f"⚠️ 应答失败：{msg}")


def _parse_index(text: str, size: int) -> int | None:
    t = (text or "").strip()
    if not t or size <= 0:
        return None
    if t.isdigit():
        i = int(t)
        if 1 <= i <= size:
            return i - 1
    # "1. xxx" 形式的原样选项回传
    for k, ch in enumerate(t.split(".", 1)[0]):
        if not ch.isdigit():
            return None
        if k > 2:
            return None
    return None


async def _send_last(sess: gateway.UserSession) -> None:
    uid = sess.user_id
    from server import crypto

    with Session(engine) as s:
        row = s.get(models.WeixinLogin, uid)
        if row is None or not row.workspace_id:
            await reply_text(sess, "先选择工作区：发送 /swarm select")
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
        log.info("weixin reply skipped (no context_token) for user %s: %s", sess.user_id, text[:50])
        return
    if sess.client is not None:
        await gateway.send_text(sess.client, sess.token, sess.baseurl, sess.wx_user_id, sess.context_token, text)
        return
    async with httpx.AsyncClient() as client:
        await gateway.send_text(client, sess.token, sess.baseurl, sess.wx_user_id, sess.context_token, text)
