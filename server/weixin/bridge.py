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
        mtype = str(event.get("type", ""))
        # 监控轮 idle 收尾：handle_monitor_event 只广播原始 payload（无 kind），
        # 简报在这里触发（对齐 feishu/brief.py 的 idle 分支）——有最终回答才推
        if mtype == "idle":
            round_key = str(event.get("roundKey", ""))
            await _brief_round(workspace_id, round_key)
            return
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
        uid = task.user_id or _owner_of(s, task.workspace_id)
        if not uid:
            return  # 外部任务无属主，不推微信
        caller = task.caller or ""

    # 来源分流（docs/channel-dispatch-design.md §4）：
    # - 微信自己派的任务 → 详细流（thinking/tool/最终回答全量/input-required 卡），终态免简报
    # - 其它来源 → 终态简报 + input-required 单卡
    if caller == "nexus-weixin-clawbot":
        sess = gateway.peek_session(uid)
        if sess is None or not sess.context_token:
            return
        await _stream_task_event(sess, task_id, event, uid)
        return
    if state_ in ("completed", "failed"):
        await _brief_round(workspace_id, task_id, state_)
        return
    if state_ == "input-required":
        await _push_input_required(workspace_id, task_id, event)
        return


# 微信派发任务的详细流节流：同一 (task, callId) 的 start 只发一次
_task_tool_seen: dict[str, set[str]] = {}


def tool_name_hash(name: str) -> str:
    import hashlib

    return hashlib.md5(name.encode()).hexdigest()[:8]


async def _stream_task_event(sess: gateway.UserSession, task_id: str, event: dict, uid: str) -> None:
    """微信自己派的 A2A 任务 → 详细流（对齐 feishu _on_task_event 的 timeline，文本形态）。

    metadata.nexus 为 snake_case（插件 nexus_a2a.ts：call_id/tool_state/part_id/mode）。
    """
    text, kind = render.a2a_stream_text(event)
    if kind == "final":
        # completed/canceled/failed：最终回答全量（artifact 优先）——替代简报
        with Session(engine) as s:
            t = s.get(models.A2aTask, task_id)
            if t is None:
                return
            u = s.get(models.User, uid)
            key = (u.api_key or "") if u else ""
            from server import crypto

            answer = crypto.decrypt(key, t.artifact_enc, t.artifact)
            error = crypto.decrypt(key, t.error_enc, t.error)
        await _send(sess, render.assistant_final(answer, t.status == "failed", error))
        state.clear_pending(uid)
        _task_tool_seen.pop(task_id, None)
        return
    if kind == "input":
        # input-required：入待应答（事件文本卡里已带编号选项）
        data = _input_data_of(event)
        itype = str(data.get("type", "permission"))
        q = str(data.get("question") or "AI 需要确认")
        opts = [str(o if isinstance(o, str) else (o.get("label") or o.get("value") or ""))
                for o in (data.get("options") or [])[:6]]
        state.set_pending(uid, task_id, itype, q, [o for o in opts if o])
    if not text:
        return
    meta = event.get("metadata") or {}
    if str(meta.get("nexus", "")) == "tool":
        # 用户拍板（2026-09-19）：tool 一律文本行并带关键参数（bash 命令/读写文件）；
        # 官方 type 11/12 item 在普通微信客户端不渲染——不再尝试。
        # 只发**完成行**（✓/✗，一条/工具）：opencode 的 running 阶段会多次 part.update，
        # start 行实测一秒内重复四条；完成的最终态只到一次，天然去重。
        st = str(meta.get("tool_state") or "")
        if st in ("running", "input-required", ""):
            return
        await _send(sess, text)
        return


async def _brief_round(workspace_id: str, task_id: str, state_: str = "completed") -> None:
    """终态简报：completed/failed（含监控轮 idle）→ brief_on 用户收 MD 摘要。

    微信自己派的任务（caller=nexus-weixin-clawbot）不发——详细流已全程推送（§4.3 去重）。
    """
    with Session(engine) as s:
        task = s.get(models.A2aTask, task_id)
        if task is None:
            return
        uid = task.user_id or _owner_of(s, task.workspace_id)
        if not uid:
            return  # 外部任务无属主，不推微信
        row = s.get(models.WeixinLogin, uid)
        if row is None:
            return
        if (task.caller or "") == "nexus-weixin-clawbot":
            state.clear_pending(uid)
            return  # 详细流已覆盖，免简报（防御性：_route 已分流）
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
    # 监控轮：只在有最终回答文本时发（tool-only 轮没有 text 事件，artifact 为空，
    # 推出去只会是"无最终回答文本"刷屏）；有人在本机看着，无内容的轮不值得打扰
    if task.caller == "monitor" and not (answer or "").strip():
        state.clear_pending(uid)
        return
    if not row.brief_on:
        state.clear_pending(uid)
        return
    text = render.brief_text(instr, answer, error, state_ == "failed", ws_name or "工作区")
    await _send(sess, text)
    state.clear_pending(uid)


async def _push_input_required(workspace_id: str, task_id: str, event: dict) -> None:
    """input-required：推文本卡 + 入待应答注册表。"""
    with Session(engine) as s:
        task = s.get(models.A2aTask, task_id)
        if task is None:
            return
        uid = task.user_id or _owner_of(s, task.workspace_id)
        if not uid:
            return
        row = s.get(models.WeixinLogin, uid)
    if row is None:
        return
    sess = gateway.peek_session(uid)
    if sess is None or not sess.context_token:
        return
    data = _input_data_of(event)
    kind = str(data.get("type", "permission"))
    q = str(data.get("question") or "AI 需要确认")
    opts = [str(o if isinstance(o, str) else (o.get("label") or o.get("value") or ""))
            for o in (data.get("options") or [])[:6]]
    opts = [o for o in opts if o]
    state.set_pending(uid, task_id, kind, q, opts)
    await _send(sess, render.permission_text(task_id, kind, q, opts))


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
        input_data = payload.get("input") if isinstance(payload.get("input"), dict) else None
        key = f"{round_key}:{call_id}:{tool}"
        seen = _tool_seen.setdefault(sess.user_id, set())
        # 用户拍板（2026-09-19）：tool 一律文本行带参数；官方 item 在普通微信不渲染，不再尝试。
        # 与任务详细流一致：只发完成行（running 阶段多次 update 会重复刷屏）
        if st in ("running", "input-required", ""):
            return
        if st in ("completed", "error"):
            await _send(sess, render.tool_done_text(tool, st == "completed", input_data))
            seen.discard(key)


async def _send(sess: gateway.UserSession, text: str) -> None:
    if not sess.context_token:
        log.info("weixin push skipped (no context_token) user=%s: %s", sess.user_id, text[:40])
        return
    try:
        client = sess.client or httpx.AsyncClient()
        await gateway.send_text(client, sess.token, sess.baseurl, sess.wx_user_id, sess.context_token, text)
        log.info("weixin push sent user=%s: %r", sess.user_id[:8], text[:60])
    except gateway.ILinkError as exc:
        if exc.stale_token:
            state.update(sess.user_id, status="need_relogin")
            await notify_relogin_needed(sess)
        elif exc.ret == -2:
            # "prepare failed" = context_token 已失效（协议：回复必须带最近入站消息的 token，
            # 长时间无新消息/会话状态变化后服务端作废旧 token）。清缓存等新入站消息自然恢复，
            # 避免对同一失效 token 反复重试。该条内容丢弃（无法补发——没有有效 token 就发不出去）。
            log.warning("weixin push failed (ret=-2, context_token stale), clearing cached token user=%s", sess.user_id[:8])
            sess.context_token = ""
            state.update(sess.user_id, context_token="")
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
