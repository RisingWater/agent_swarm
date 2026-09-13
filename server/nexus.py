"""中枢（nexus）WebSocket hub。

两类连接方：
- 插件（opencode 等 agent 工具端）：携带 apikey 连接，注册自己的工作区，
  接收中枢下发的指令，上报 timeline 事件（思考/工具/文本/idle）。
- Web 前端：携带 JWT 连接，订阅本用户在线工作区的 timeline 流，
  并可通过 hub 向指定工作区下发指令。

协议（JSON 行）：
  插件 → 服务端：
    {type:"hello", workspace_id}              注册（hello_ok / hello_err）
    {type:"ping"}                             心跳（服务端回 pong）
    {type:"event", event:{...}}               timeline 事件上报（转发给订阅者）
    {type:"result", req_id, ok, result}       指令执行结果回传
  服务端 → 插件：
    {type:"hello_ok"} / {type:"hello_err", error}
    {type:"pong"}
    {type:"command", req_id, command:"prompt", text}   下发指令
  Web → 服务端：
    {type:"subscribe", workspace_id}          订阅某工作区
    {type:"unsubscribe"}
    {type:"command", workspace_id, text, req_id}  下发指令
  服务端 → Web：
    {type:"subscribed", workspace_id} / {type:"unsubscribed"}
    {type:"event", workspace_id, event}       转发的 timeline 事件
    {type:"result", req_id, ok, result}       指令结果（或错误）
    {type:"agent_offline"}                    目标工作区不在线
"""
from __future__ import annotations

import asyncio
import contextvars
import json
import hmac
import logging
from dataclasses import dataclass, field

import shortuuid
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jwt import PyJWTError
from sqlmodel import Session, select
import jwt

from server import models
from server.auth import JWT_SECRET
from server.db import engine

log = logging.getLogger("nexus")

router = APIRouter()


# ---------------------------------------------------------------- 连接对象


@dataclass
class PluginConn:
    """插件侧连接。"""
    ws: WebSocket
    user_id: str
    workspace_id: str
    tasks: set = field(default_factory=set)  # 防止 command 任务被 GC


@dataclass(eq=False)
class WebConn:
    """Web 前端连接（eq=False：按对象身份 hash，可放入 set）。"""
    ws: WebSocket
    user_id: str
    workspace_id: str | None = None  # 当前订阅的工作区


# workspace_id → 插件连接（同一工作区重复连接：旧的让位给新的）
plugins: dict[str, PluginConn] = {}
# workspace_id → 订阅该工作区的 web 连接集合
subscribers: dict[str, set[WebConn]] = {}

_user_ctx: contextvars.ContextVar[models.User] = contextvars.ContextVar("nexus_user")


async def _send(ws: WebSocket, payload: dict) -> bool:
    try:
        await ws.send_text(json.dumps(payload, ensure_ascii=False))
        return True
    except Exception:
        return False


async def _forward_event(workspace_id: str, event: dict) -> None:
    """插件上报的 timeline 事件：持久化 + 转发给所有订阅该工作区的 web 连接。"""
    # 落库（限流：单事件 128KB，超限截断丢弃，防滥用）
    req_id = str(event.get("req_id", ""))[:128]
    kind = str(event.get("kind", ""))[:64]
    if req_id and kind:
        payload = dict(event)
        payload.pop("kind", None)
        payload.pop("req_id", None)
        try:
            payload_json = json.dumps(payload, ensure_ascii=False)[:131072]
        except (TypeError, ValueError):
            payload_json = "{}"
        with Session(engine) as session:
            session.add(
                models.NexusEvent(workspace_id=workspace_id, req_id=req_id, kind=kind, payload=payload_json)
            )
            session.commit()

        # session-idle / run-error 事件收尾对应的调用记录
        if kind in ("session-idle", "run-error"):
            status = "done" if kind == "session-idle" else "failed"
            error = str(event.get("error", "")) if kind == "run-error" else None
            with Session(engine) as session:
                call = session.get(models.WorkspaceCall, req_id)
                if call is not None and call.status == "running":
                    call.status = status
                    call.done_at = models.utcnow()
                    if error:
                        call.error = error
                    session.add(call)
                    session.commit()

    conns = subscribers.get(workspace_id)
    if not conns:
        return
    msg = json.dumps(
        {"type": "event", "workspace_id": workspace_id, "event": event},
        ensure_ascii=False,
    )
    for conn in list(conns):
        try:
            await conn.ws.send_text(msg)
        except Exception:
            conns.discard(conn)


def ws_online(workspace_id: str) -> bool:
    """插件 WS 是否在线（比心跳更实时的在线判定）。"""
    return workspace_id in plugins


# ---------------------------------------------------------------- 插件端点


@router.websocket("/ws/plugin")
async def ws_plugin(ws: WebSocket):
    await ws.accept()
    plugin: PluginConn | None = None
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue

            mtype = msg.get("type")

            if mtype == "hello":
                # 首条消息必须 hello：带 apikey 与 workspace_id
                user = _auth_apikey(str(msg.get("apikey", "")))
                if user is None:
                    await _send(ws, {"type": "hello_err", "error": "invalid api key"})
                    continue
                wid = str(msg.get("workspace_id", ""))
                with Session(engine) as session:
                    row = session.exec(
                        _select_ws(user.id, wid)
                    ).first()
                if row is None:
                    await _send(ws, {"type": "hello_err", "error": "workspace not found"})
                    continue
                old = plugins.get(wid)
                if old is not None:
                    # 同工作区新连接顶替旧连接
                    try:
                        await old.ws.close(code=4001, reason="replaced by new connection")
                    except Exception:
                        pass
                    plugins.pop(wid, None)
                plugin = PluginConn(ws=ws, user_id=user.id, workspace_id=wid)
                plugins[wid] = plugin
                await _send(ws, {"type": "hello_ok"})
                log.info("plugin connected: ws=%s user=%s", wid, user.id)
                continue

            if plugin is None:
                await _send(ws, {"type": "hello_err", "error": "hello first"})
                continue

            if mtype == "ping":
                await _send(ws, {"type": "pong"})
            elif mtype == "event":
                # timeline 事件：透传给订阅者（限制大小防滥用）
                if raw.__sizeof__() < 256 * 1024:
                    await _forward_event(plugin.workspace_id, msg.get("event") or {})
            elif mtype == "result":
                # 指令结果：直接丢弃（结果由 timeline 事件本身承载，前端渲染）
                pass
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.warning("plugin ws error: %s", e)
    finally:
        if plugin is not None and plugins.get(plugin.workspace_id) is plugin:
            plugins.pop(plugin.workspace_id, None)
            log.info("plugin disconnected: ws=%s", plugin.workspace_id)


# ---------------------------------------------------------------- Web 端点


@router.websocket("/ws/nexus")
async def ws_nexus(ws: WebSocket):
    await ws.accept()
    conn: WebConn | None = None
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except ValueError:
                continue

            mtype = msg.get("type")

            if mtype == "hello":
                user = _auth_jwt(str(msg.get("token", "")))
                if user is None:
                    await _send(ws, {"type": "hello_err", "error": "invalid token"})
                    continue
                conn = WebConn(ws=ws, user_id=user.id)
                await _send(ws, {"type": "hello_ok"})
                continue

            if conn is None:
                await _send(ws, {"type": "hello_err", "error": "hello first"})
                continue

            if mtype == "ping":
                await _send(ws, {"type": "pong"})
            elif mtype == "subscribe":
                wid = str(msg.get("workspace_id", ""))
                if not _owns(conn.user_id, wid):
                    await _send(ws, {"type": "subscribed", "error": "no permission"})
                    continue
                _unsubscribe(conn)
                subscribers.setdefault(wid, set()).add(conn)
                conn.workspace_id = wid
                online = ws_online(wid)
                # 回放历史 timeline（按时间正序，web 端自行合并流式更新）
                history = []
                with Session(engine) as session:
                    rows = session.exec(
                        select(models.NexusEvent)
                        .where(models.NexusEvent.workspace_id == wid)
                        .order_by(models.NexusEvent.id)  # 自增 id 即时间序
                        .limit(500)  # 回放上限，防止超大历史拖垮连接
                    ).all()
                    for r in rows:
                        try:
                            payload = json.loads(r.payload)
                        except ValueError:
                            payload = {}
                        payload["kind"] = r.kind
                        payload["req_id"] = r.req_id
                        history.append(payload)
                await _send(ws, {"type": "subscribed", "workspace_id": wid, "plugin_online": online, "history": history})
            elif mtype == "clear":
                # 手动清空该工作区的 timeline 历史
                wid = str(msg.get("workspace_id", ""))
                if _owns(conn.user_id, wid):
                    with Session(engine) as session:
                        for r in session.exec(
                            select(models.NexusEvent).where(models.NexusEvent.workspace_id == wid)
                        ).all():
                            session.delete(r)
                        session.commit()
                    await _send(ws, {"type": "cleared", "workspace_id": wid})
            elif mtype == "unsubscribe":
                _unsubscribe(conn)
                await _send(ws, {"type": "unsubscribed"})
            elif mtype == "permission_reply":
                # web 端响应权限请求：转发给目标工作区插件
                wid = str(msg.get("workspace_id", ""))
                request_id = str(msg.get("request_id", ""))
                reply = str(msg.get("reply", ""))
                if reply not in ("once", "always", "reject"):
                    await _send(ws, {"type": "result", "req_id": "", "ok": False, "result": "invalid reply"})
                    continue
                if not _owns(conn.user_id, wid):
                    await _send(ws, {"type": "result", "req_id": "", "ok": False, "result": "no permission"})
                    continue
                plugin = plugins.get(wid)
                if plugin is None:
                    await _send(ws, {"type": "result", "req_id": "", "ok": False, "result": "目标工作区插件不在线"})
                    continue
                await _send(
                    plugin.ws,
                    {
                        "type": "command",
                        "command": "permission_reply",
                        "request_id": request_id,
                        "reply": reply,
                    },
                )
            elif mtype == "question_reply":
                # web 端回答 AI 提问（选择方案等）：转发给目标工作区插件
                wid = str(msg.get("workspace_id", ""))
                request_id = str(msg.get("request_id", ""))
                answers = msg.get("answers")
                if not request_id or not isinstance(answers, list):
                    await _send(ws, {"type": "result", "req_id": "", "ok": False, "result": "invalid answers"})
                    continue
                if not _owns(conn.user_id, wid):
                    await _send(ws, {"type": "result", "req_id": "", "ok": False, "result": "no permission"})
                    continue
                plugin = plugins.get(wid)
                if plugin is None:
                    await _send(ws, {"type": "result", "req_id": "", "ok": False, "result": "目标工作区插件不在线"})
                    continue
                await _send(
                    plugin.ws,
                    {
                        "type": "command",
                        "command": "question_reply",
                        "request_id": request_id,
                        "answers": answers,
                    },
                )
            elif mtype == "command":
                wid = str(msg.get("workspace_id", ""))
                text = str(msg.get("text", "")).strip()
                req_id = str(msg.get("req_id", ""))
                # 指令来源：web 网页端；后期扩展 im 渠道（nexus-feishu / nexus-wechat 等）
                source = str(msg.get("source", "")).strip() or "nexus-web"
                if not text:
                    await _send(ws, {"type": "result", "req_id": req_id, "ok": False, "result": "empty command"})
                    continue
                if not _owns(conn.user_id, wid):
                    await _send(ws, {"type": "result", "req_id": req_id, "ok": False, "result": "no permission"})
                    continue
                plugin = plugins.get(wid)
                if plugin is None:
                    await _send(ws, {"type": "result", "req_id": req_id, "ok": False, "result": "目标工作区插件不在线"})
                    continue
                # 落一条调用记录（调用方 = 目标工作区自身，标注来源 nexus-*；状态 running，
                # 完成时间线由 idle 事件驱动收尾）
                with Session(engine) as session:
                    session.add(
                        models.WorkspaceCall(
                            id=req_id or shortuuid.uuid(),
                            caller_ws_id=wid,
                            target_ws_id=wid,
                            instruction=f"[{source}] {text}",
                            status="running",
                        )
                    )
                    session.commit()
                # 异步等结果，避免阻塞消息循环
                task = asyncio.create_task(
                    _dispatch_command(plugin, conn, req_id, text, source)
                )
                plugin.tasks.add(task)
                task.add_done_callback(plugin.tasks.discard)
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.warning("web ws error: %s", e)
    finally:
        if conn is not None:
            _unsubscribe(conn)


async def _dispatch_command(plugin: PluginConn, web: WebConn, req_id: str, text: str, source: str) -> None:
    """向插件下发 prompt 指令，等结果回传给 web。"""
    cmd = {
        "type": "command",
        "req_id": req_id,
        "command": "prompt",
        "text": text,
        "source": source,  # 指令来源（nexus-web / nexus-feishu / ...），插件注入 prompt 时可标注
    }
    ok = await _send(plugin.ws, cmd)
    if not ok:
        await _send(web.ws, {"type": "result", "req_id": req_id, "ok": False, "result": "插件连接已断开"})


def _unsubscribe(conn: WebConn) -> None:
    if conn.workspace_id:
        conns = subscribers.get(conn.workspace_id)
        if conns:
            conns.discard(conn)
            if not conns:
                subscribers.pop(conn.workspace_id, None)
        conn.workspace_id = None


# ---------------------------------------------------------------- 工具函数


def _select_ws(user_id: str, workspace_id: str):
    from sqlmodel import select

    return select(models.Workspace).where(
        models.Workspace.user_id == user_id,
        models.Workspace.id == workspace_id,
    )


def _owns(user_id: str, workspace_id: str) -> bool:
    with Session(engine) as session:
        return session.exec(_select_ws(user_id, workspace_id)).first() is not None


def _auth_apikey(key: str) -> models.User | None:
    if not key:
        return None
    key_hash = models.hash_api_key(key)
    with Session(engine) as session:
        from sqlmodel import select

        user = session.exec(
            select(models.User).where(models.User.api_key_hash == key_hash)
        ).first()
        if not user or not hmac.compare_digest(user.api_key_hash, key_hash):
            return None
        return user


def _auth_jwt(token: str) -> models.User | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except PyJWTError:
        return None
    with Session(engine) as session:
        return session.get(models.User, payload.get("sub"))
