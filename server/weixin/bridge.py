"""A2A 事件桥：internal_listeners 监听 → 按用户设置（monitor/brief）渲染成微信文本发送。

- 简报（终态 completed/failed）：brief_on 的用户收 MD 摘要（自己下发的任务也在时间线上看过了，不重复推 timeline 全量；简报仍是主通知）
- input-required（权限/提问）：推文本卡 + 入待应答注册表
- 监控轮（monitor_on 用户自己的前台对话）：thinking 发文本；tool 走官方 tool item（失败降级文本行）
"""
from __future__ import annotations

import asyncio
import logging

import httpx
from sqlmodel import Session

from server import models
from server.db import engine
from server.nexus_a2a import internal_listeners

from . import gateway, render, state

log = logging.getLogger("nexus-weixin")

_LISTENER = "nexus-weixin-bridge"
# 监控轮 tool 节流：同一 roundKey+callId 的 start 只发一次
_tool_seen: dict[str, set[str]] = {}


def bind_listener() -> None:
    if _LISTENER not in internal_listeners:
        internal_listeners.append(_on_event)


def unbind_listener() -> None:
    try:
        internal_listeners.remove(_on_event)
    except ValueError:
        pass


async def _on_event(workspace_id: str, event: dict) -> None:
    try:
        await _route(workspace_id, event)
    except Exception:  # noqa: BLE001
        log.exception("weixin bridge error")


async def _route(workspace_id: str, event: dict) -> None:
    # 监控 payload（无 kind，有 type）
    if not event.get("kind") and event.get("type"):
        round_key = str(event.get("roundKey", ""))
        with Session(engine) as s:
            row = s.get(models.WeixinLogin, _owner_of(s, workspace_id) or "")
        if row is None or not row.monitor_on:
            return
        sess = gateway.peek_session(row.user_id)
        if sess is None or not sess.context_token:
            return
        await _send_monitor(sess, event, round_key)
        return

    # A2A 任务事件
    task_id = str(event.get("taskId", ""))
    if not task_id:
        return
    state_ = str((event.get("status") or {}).get("state", "")) if event.get("kind") == "status-update" else ""
    with Session(engine) as s:
        task = s.get(models.A2aTask, task_id)
        if task is None:
            return
        # 监控轮（TUI 前台对话）不发微信简报：内容已实时同步/本地可见，且轮内常无最终文本
        # （tool-only 轮），推出去只会是"无最终回答文本"刷屏——对齐飞书侧排除自身渠道的逻辑
        if task.caller == "monitor":
            return
        uid = task.user_id or _owner_of(s, task.workspace_id)
        if not uid:
            return  # 外部任务无属主，不推微信
        row = s.get(models.WeixinLogin, uid)
        if row is None:
            return
        brief_on = row.brief_on
        ws_name = ""
        if task.workspace_id:
            ws = s.get(models.Workspace, task.workspace_id)
            ws_name = ws.name if ws else ""
        u = s.get(models.User, uid)
        key = (u.api_key or "") if u else ""
        from server import crypto

        instr = crypto.decrypt(key, task.message_enc, task.message)
        answer = crypto.decrypt(key, task.artifact_enc, task.artifact)
        error = crypto.decrypt(key, task.error_enc, task.error)

    sess = gateway.peek_session(uid)
    if sess is None or not sess.context_token:
        return

    # input-required：推文本卡 + 入待应答
    if state_ == "input-required":
        data = _input_data_of(event)
        kind = str(data.get("type", "permission"))
        q = str(data.get("question") or "AI 需要确认")
        opts = [str(o if isinstance(o, str) else (o.get("label") or o.get("value") or ""))
                for o in (data.get("options") or [])[:6]]
        opts = [o for o in opts if o]
        state.set_pending(uid, task_id, kind, q, opts)
        await _send(sess, render.permission_text(task_id, kind, q, opts))
        return

    # 终态简报
    if state_ in ("completed", "failed") and brief_on:
        text = render.brief_text(instr, answer, error, state_ == "failed", ws_name or "工作区")
        await _send(sess, text)
        state.clear_pending(uid)


def _input_data_of(event: dict) -> dict:
    msg = (event.get("status") or {}).get("message") or {}
    for p in msg.get("parts") or []:
        if p.get("kind") == "data":
            return p.get("data") or {}
    return {}


def _owner_of(s: Session, workspace_id: str) -> str:
    ws = s.get(models.Workspace, workspace_id) if workspace_id else None
    return (ws.user_id if ws else "") or ""


async def _send_monitor(sess: gateway.UserSession, payload: dict, round_key: str) -> None:
    """监控事件：thinking→文本；tool→官方 item（异常降级文本）。"""
    mtype = str(payload.get("type", ""))
    if mtype == "thinking":
        texts = render.monitor_texts(payload)
        for t in texts:
            await _send(sess, t)
    elif mtype == "tool":
        tool = str(payload.get("tool") or "工具")
        call_id = str(payload.get("callId") or "")
        st = str(payload.get("toolState") or "")
        key = f"{round_key}:{call_id}:{tool}"
        seen = _tool_seen.setdefault(sess.user_id, set())
        if st in ("running", "input-required", ""):
            if key in seen:
                return
            seen.add(key)
            # 先试官方 tool_call_start_item（普通客户端显示效果待真机实测）
            try:
                client = sess.client or httpx.AsyncClient()
                await gateway.send_tool_items(
                    client, sess.token, sess.baseurl, sess.wx_user_id, sess.context_token,
                    [render.tool_item_start(call_id, tool)])
                return
            except Exception:  # noqa: BLE001
                await _send(sess, render.tool_start_text(tool))
        elif st in ("completed", "error"):
            ok = st == "completed"
            try:
                client = sess.client or httpx.AsyncClient()
                await gateway.send_tool_items(
                    client, sess.token, sess.baseurl, sess.wx_user_id, sess.context_token,
                    [render.tool_item_result(call_id, tool, ok)])
            except Exception:  # noqa: BLE001
                await _send(sess, render.tool_done_text(tool, ok))
            finally:
                seen.discard(key)


async def _send(sess: gateway.UserSession, text: str) -> None:
    if not sess.context_token:
        log.info("weixin push skipped (no context_token) user=%s: %s", sess.user_id, text[:40])
        return
    try:
        client = sess.client or httpx.AsyncClient()
        await gateway.send_text(client, sess.token, sess.baseurl, sess.wx_user_id, sess.context_token, text)
    except gateway.ILinkError as exc:
        if exc.stale_token:
            state.update(sess.user_id, status="need_relogin")
            await notify_relogin_needed(sess)
        else:
            log.warning("weixin push failed: %s", exc)
    except Exception:  # noqa: BLE001
        log.exception("weixin push crash")


async def notify_relogin_needed(sess: gateway.UserSession) -> None:
    """token 失效提示（尽量发最后一条 context_token，发不出就算了）。"""
    if not sess.context_token:
        return
    try:
        client = sess.client or httpx.AsyncClient()
        await gateway.send_text(
            client, sess.token, sess.baseurl, sess.wx_user_id, sess.context_token,
            "⚠️ 微信连接已失效，请到网页「账号 → 聊天工具绑定」重新扫码。")
    except Exception:  # noqa: BLE001
        pass
