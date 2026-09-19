"""nexus A2A 网关（agent_swarm 的工作区互调 / web 中枢 / 外部 A2A agent 统一走 A2A 协议）。

手写 A2A 协议子集（Linux Foundation A2A 0.3.x，JSON-RPC over HTTP transport），
不依赖官方 SDK——线上协议就是 JSON-RPC 2.0 + 固定对象形状，子集足够互操作。

HTTP 端点（入站，apikey 鉴权）：
  GET  /.well-known/agent-card.json     本服务器的 Agent Card（工作区枚举在 extensions 里）
  GET  /a2a/{workspace_id}              单工作区 Agent Card（name/path/skills 由工作区资料生成）
  POST /a2a/{workspace_id}             JSON-RPC：message/send、message/stream(SSE)、tasks/get、tasks/cancel

WebSocket 链路（服务端 ↔ 插件，载荷为 A2A 对象）：
  /ws/plugin   插件连接（hello 带 apikey+workspace_id）
    服务端 → 插件：{type:"rpc", payload:<JSON-RPC request 原样>}  下发 message/send
    插件 → 服务端：{type:"rpc", id, payload:<response 或 error>}  同步应答
                   {type:"event", payload:<TaskStatusUpdateEvent|TaskArtifactUpdateEvent>}  流式事件
  /ws/nexus    web 中枢订阅（hello 带 JWT；订阅后实时收本用户工作区的事件流）

Task 状态机（对齐 A2A TaskState）：
  queued --(插件领取)--> working --(idle)--> completed
                              |--(权限/提问)--> input-required --(应答)--> working
  任意态 --(错误/取消)--> failed / canceled
最终状态（completed/failed/canceled）由服务端在事件转发时落库收尾。

外部 A2A agent（出站）：a2a_call 工具用 call_external() 打任意 Agent Card 端点，
任务同样落本表（workspace_id 为空、external_url 记录来源），供 a2a_task 查询。
"""
from __future__ import annotations

import asyncio
import contextvars
import hmac
import json
import logging
import os
import time

import shortuuid
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from jwt import PyJWTError
from sqlmodel import Session, func, select
import jwt

from server import crypto, models
from server.auth import JWT_SECRET
from server.config import get as cfg_get
from server.db import engine

log = logging.getLogger("nexus_a2a")

router = APIRouter()

CALL_TIMEOUT_SECONDS = int(os.environ.get("AGENT_SWARM_CALL_TIMEOUT", str(cfg_get("AGENT_SWARM_CALL_TIMEOUT", "3600"))))

# ---------------------------------------------------------------- A2A 对象构造（camelCase，规范形状）


def _ts() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def task_obj(t: models.A2aTask, owner_key: str | None = None) -> dict:
    """A2aTask 行 → A2A Task 对象。owner_key 缺省时内部查属主 apikey（解密 error 用）。"""
    if owner_key is None:
        with Session(engine) as s:
            owner_key = _owner_key(s, t)
    status_msg = None
    if t.status == "input-required":
        status_msg = {
            "role": "agent",
            "parts": [{"kind": "data", "data": {"type": _input_type(t), "taskId": t.id, "requestId": t.id, "session_id": t.session_id or ""}}],
            "messageId": f"msg-{t.id}-input",
            "taskId": t.id,
            "contextId": t.context_id,
        }
    else:
        error_text = crypto.decrypt(owner_key, t.error_enc, t.error) if (t.error_enc or t.error) else ""
        if error_text:
            status_msg = {
                "role": "agent",
                "parts": [{"kind": "text", "text": error_text}],
                "messageId": f"msg-{t.id}-err",
                "taskId": t.id,
                "contextId": t.context_id,
            }
    return {
        "id": t.id,
        "contextId": t.context_id,
        "status": {"state": t.status, **({"message": status_msg} if status_msg else {}), "timestamp": _ts()},
        "kind": "task",
    }


def _input_type(t: models.A2aTask) -> str:
    """input-required 的 DataPart 类型（permission / question）：取最近一次 input 类事件。"""
    with Session(engine) as session:
        rows = session.exec(
            select(models.A2aEvent)
            .where(models.A2aEvent.task_id == t.id)
            .order_by(models.A2aEvent.id.desc())
            .limit(50)
        ).all()
    for r in rows:
        try:
            payload = json.loads(event_payload_text(r))
        except ValueError:
            continue
        data = ((payload.get("status") or {}).get("message") or {}).get("data") or {}
        if data.get("type") in ("permission", "question"):
            return str(data["type"])
    return "input"


def event_payload_text(r: models.A2aEvent, apikeys: dict[str, str] | None = None) -> str:
    """事件 payload 明文（优先解密 *_enc；apikeys 缺省时按行 user_id/workspace 现查）。"""
    if not r.payload_enc:
        return r.payload
    key = ""
    if apikeys is not None:
        key = apikeys.get(r.user_id or "", "") or apikeys.get(f"ws:{r.workspace_id}", "")
    else:
        with Session(engine) as s:
            uid = r.user_id
            if not uid and r.workspace_id:
                ws = s.get(models.Workspace, r.workspace_id)
                uid = ws.user_id if ws else ""
            if uid:
                u = s.get(models.User, uid)
                key = (u.api_key or "") if u else ""
    return crypto.decrypt(key, r.payload_enc, r.payload)


def _apikeys_for_rows(session: Session, rows: list[models.A2aEvent]) -> dict[str, str]:
    """一批事件的解密密钥表：user_id → apikey，外加 "ws:<workspace_id>" → apikey（旧行无 user_id 兜底）。"""
    out: dict[str, str] = {}
    uids: set[str] = set()
    wids: set[str] = set()
    for r in rows:
        if r.user_id:
            uids.add(r.user_id)
        if r.workspace_id:
            wids.add(r.workspace_id)
    if uids:
        for u in session.exec(select(models.User).where(models.User.id.in_(uids))).all():  # type: ignore[attr-defined]
            out[u.id] = u.api_key or ""
    if wids:
        for w in session.exec(select(models.Workspace).where(models.Workspace.id.in_(wids))).all():  # type: ignore[attr-defined]
            out[f"ws:{w.id}"] = out.get(w.user_id, "")
    return out


def user_message(text: str, task_id: str = "", context_id: str = "", message_id: str = "") -> dict:
    return {
        "role": "user",
        "parts": [{"kind": "text", "text": text}],
        "messageId": message_id or f"msg-{shortuuid.uuid()}",
        **({"taskId": task_id} if task_id else {}),
        **({"contextId": context_id} if context_id else {}),
    }


def status_event(t: models.A2aTask, final: bool, msg: dict | None = None) -> dict:
    st = {"state": t.status}
    if msg:
        st["message"] = msg
    return {
        "taskId": t.id,
        "contextId": t.context_id,
        "kind": "status-update",
        "status": st,
        "final": final,
    }


def artifact_event(t: models.A2aTask, text: str, last_chunk: bool, artifact_id: str = "") -> dict:
    aid = artifact_id or f"artifact-{t.id}"
    return {
        "taskId": t.id,
        "contextId": t.context_id,
        "kind": "artifact-update",
        "artifact": {
            "artifactId": aid,
            "name": "result",
            "parts": [{"kind": "text", "text": text}],
        },
        "lastChunk": last_chunk,
    }


# ---------------------------------------------------------------- 连接注册表


class PluginConn:
    """插件侧 WS 连接。"""

    __slots__ = ("ws", "user_id", "workspace_id", "pending", "tasks")

    def __init__(self, ws: WebSocket, user_id: str, workspace_id: str):
        self.ws = ws
        self.user_id = user_id
        self.workspace_id = workspace_id
        self.pending: dict[str, asyncio.Future] = {}  # JSON-RPC id → Future（等插件 rpc 应答）
        self.tasks: set = set()  # 防 dispatch 任务被 GC


class WebConn:
    """web 中枢侧 WS 连接。"""

    __slots__ = ("ws", "user_id", "workspace_id")

    def __init__(self, ws: WebSocket, user_id: str):
        self.ws = ws
        self.user_id = user_id
        self.workspace_id: str | None = None

    def __eq__(self, other):
        return self is other

    def __hash__(self):
        return id(self)


plugins: dict[str, PluginConn] = {}  # workspace_id → 插件连接（新顶旧）
subscribers: dict[str, set[WebConn]] = {}  # workspace_id → 订阅的 web 连接

_user_ctx: contextvars.ContextVar[models.User] = contextvars.ContextVar("nexus_a2a_user")


async def _send_json(ws: WebSocket, payload: dict) -> bool:
    try:
        await ws.send_text(json.dumps(payload, ensure_ascii=False))
        return True
    except Exception:
        return False


def ws_online(workspace_id: str) -> bool:
    """插件 WS 是否在线（比心跳更实时）。"""
    return workspace_id in plugins


# ---------------------------------------------------------------- 事件总线（进程内，SSE/同步等待用）

# task_id → 等待该任务事件的 asyncio.Queue 集合（_stream_response / _wait_final 消费）
_task_queues: dict[str, set[asyncio.Queue]] = {}

TERMINAL_STATES = ("completed", "failed", "canceled")


def _task_subscribe(task_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue()
    _task_queues.setdefault(task_id, set()).add(q)
    return q


def _task_unsubscribe(task_id: str, q: asyncio.Queue) -> None:
    qs = _task_queues.get(task_id)
    if qs:
        qs.discard(q)
        if not qs:
            _task_queues.pop(task_id, None)


def _task_broadcast(task_id: str, event_id: int, event: dict) -> None:
    for q in list(_task_queues.get(task_id, ())):
        q.put_nowait((event_id, event))


# 内部事件监听者（如 nexus-feishu）：签名 async fn(workspace_id, event_dict)；
# 在 handle_plugin_event / handle_monitor_event 持久化后调用，异常互不影响主链路
internal_listeners: list = []


# ---------------------------------------------------------------- 事件管道


async def _push_web(workspace_id: str, payload: dict, type_: str = "event") -> None:
    """把事件推给所有订阅该工作区的 web 连接。

    type_="event"：A2A 事件（payload 为 A2A 形状）；
    type_="monitor"：前台监控事件（payload 为 {roundKey, type, ...}，已含 monitor 语义，
    不再包一层——曾因统一包 event 导致前端 case "monitor" 永远匹配不上，实时流全灭）。
    """
    conns = subscribers.get(workspace_id)
    if not conns:
        return
    msg = json.dumps({"type": type_, "payload": payload}, ensure_ascii=False)
    for conn in list(conns):
        try:
            await conn.ws.send_text(msg)
        except Exception:
            conns.discard(conn)


def _artifact_text(event: dict) -> str:
    art = event.get("artifact") or {}
    parts = art.get("parts") or []
    return "\n".join(p.get("text", "") for p in parts if p.get("kind") == "text")


def _owner_key(session: Session, task: models.A2aTask) -> str:
    """任务的加密属主 apikey：优先行上 user_id，回退 workspace→user。空 = 外部任务。"""
    uid = task.user_id
    if not uid and getattr(task, "workspace_id", ""):
        ws = session.get(models.Workspace, task.workspace_id)
        uid = ws.user_id if ws else ""
    if not uid:
        return ""
    user = session.get(models.User, uid)
    return (user.api_key or "") if user else ""


def _ws_user_id(session: Session, workspace_id: str) -> str:
    ws = session.get(models.Workspace, workspace_id)
    return (ws.user_id if ws else "") or ""


def task_user_key(session: Session, task: models.A2aTask) -> str:
    """= _owner_key（语义别名：写侧建行时用）。"""
    return _owner_key(session, task)


def ws_user_key(session: Session, ws: models.Workspace) -> str:
    """工作区属主 apikey（写侧加密用）。"""
    user = session.get(models.User, ws.user_id) if ws.user_id else None
    return (user.api_key or "") if user else ""


def _api_key_of(user_id: str) -> str:
    """user_id → apikey（无 session 场景；查不到返回空 = 不加密走明文）。"""
    if not user_id:
        return ""
    with Session(engine) as session:
        user = session.get(models.User, user_id)
        return (user.api_key or "") if user else ""


def _finalize_task(session: Session, task: models.A2aTask, event: dict, owner_key: str = "") -> None:
    """终态事件 → 收尾任务行（幂等：只收未终态的）。owner_key 用于错误文本加密。"""
    if task.status in TERMINAL_STATES:
        return
    if event.get("kind") != "status-update":
        return
    state = str(event.get("status", {}).get("state", ""))
    if state not in TERMINAL_STATES:
        return
    task.status = state
    task.done_at = models.utcnow()
    if state == "failed":
        msg = event.get("status", {}).get("message") or {}
        parts = msg.get("parts") or []
        error = str(next((p.get("text") for p in parts if p.get("kind") == "text"), state))
        task.error_enc = crypto.encrypt(owner_key, error)
        task.error = "" if task.error_enc else error
    session.add(task)


def _artifact_text(event: dict) -> str:
    art = event.get("artifact") or {}
    parts = art.get("parts") or []
    return "\n".join(p.get("text", "") for p in parts if p.get("kind") == "text")


async def handle_plugin_event(workspace_id: str, event: dict) -> None:
    """插件上报的 A2A 流式事件：持久化 + 任务收尾 + 广播（web 订阅者 / SSE / 同步等待者）。"""
    task_id = str(event.get("taskId", ""))
    if not task_id or event.get("kind") not in ("status-update", "artifact-update"):
        return
    event_id = 0
    snapshot: dict | None = None
    state = str((event.get("status") or {}).get("state", "")) if event.get("kind") == "status-update" else ""
    with Session(engine) as session:
        task = session.get(models.A2aTask, task_id)
        if task is None or task.workspace_id != workspace_id:
            return
        owner_key = _owner_key(session, task)
        payload_json = json.dumps(event, ensure_ascii=False)[:131072]
        payload_enc = crypto.encrypt(owner_key, payload_json)
        session.add(
            models.A2aEvent(task_id=task.id, workspace_id=workspace_id, user_id=task.user_id, kind="status" if event.get("kind") == "status-update" else "artifact", round_key=task.id, payload="{}" if payload_enc else payload_json, payload_enc=payload_enc)
        )
        _finalize_task(session, task, event, owner_key)
        # artifact：全量文本落 task.artifact（插件每轮发全量，lastChunk=true）
        if event.get("kind") == "artifact-update" and event.get("lastChunk"):
            artifact = _artifact_text(event)[:60000]
            task.artifact_enc = crypto.encrypt(owner_key, artifact)
            task.artifact = None if task.artifact_enc else artifact
        session.add(task)
        session.commit()
        session.refresh(task)
        snapshot = task_obj(task)
        last_row = session.exec(
            select(models.A2aEvent.id).where(models.A2aEvent.task_id == task.id).order_by(models.A2aEvent.id.desc()).limit(1)
        ).first()
        event_id = int(last_row or 0)
    # 广播：事件（SSE 流 / 同步等待队列）
    _task_broadcast(task_id, event_id, event)
    await _push_web(workspace_id, event)
    # 内部监听者（feishu 等）
    for listener in internal_listeners:
        try:
            await listener(workspace_id, event)
        except Exception:
            pass
    # 状态变化时附带推送任务快照（web 直接拿最新 status / artifact）
    if snapshot is not None and event.get("kind") == "status-update":
        await _push_web(workspace_id, {"type": "task", "task": snapshot})
    # input-required 需要任务行带上应答信息（task_obj 的 status.message）
    if state == "input-required" and snapshot is not None:
        _task_broadcast(task_id, event_id, {"kind": "task-snapshot", "task": snapshot})


# ---------------------------------------------------------------- 前台监控（TUI 对话轮次上报）


async def handle_monitor_event(workspace_id: str, payload: dict) -> None:
    """插件上报的前台会话监控事件（用户在 TUI 手动对话）：落库 + 建/更新轮次任务行 + 推 web。

    payload: {roundKey, sessionId, type: user|text|reasoning|tool|permission|question|idle, ...}
    监控轮复用 a2a_tasks 表（id=roundKey，caller="monitor"），web 应答权限/提问直接走
    现有 reply 端点（task_id=roundKey）。
    """
    round_key = str(payload.get("roundKey", ""))
    mtype = str(payload.get("type", ""))
    if not round_key or not mtype:
        return
    superseded: list[models.A2aTask] = []  # 新轮开轮时被收尾的旧前台轮（事务外通知）
    with Session(engine) as session:
        task = session.get(models.A2aTask, round_key)
        if task is None:
            # 前台轮唯一性：一个工作区同时只有一个前台轮。新轮开轮时把旧的前台轮
            # （caller=monitor 且未终态）就地收尾——插件侧 monRounds 直接覆盖旧轮不发
            # idle，旧轮会永远停在 working，只能靠这里关（idle 先到的已终态，幂等跳过）。
            stale = session.exec(
                select(models.A2aTask)
                .where(models.A2aTask.workspace_id == workspace_id)
                .where(models.A2aTask.caller == "monitor")
                .where(models.A2aTask.status.not_in(list(TERMINAL_STATES)))  # type: ignore[attr-defined]
            ).all()
            for old in stale:
                if old.id == round_key:
                    continue
                old.status = "completed"
                old.done_at = models.utcnow()
                session.add(old)
                superseded.append(old.model_copy())
            # 轮次首事件：建监控轮任务行（user 开轮；其他事件先到也容忍，文本后补）
            task = models.A2aTask(
                id=round_key,
                context_id=round_key,
                workspace_id=workspace_id,
                user_id=_ws_user_id(session, workspace_id),
                caller="monitor",
                status="working",
                session_id=str(payload.get("sessionId", "")) or None,
            )
            msg = str(payload.get("text", ""))[:8000]
            task.message_enc = crypto.encrypt(task_user_key(session, task), msg)
            task.message = "" if task.message_enc else msg
            session.add(task)
            session.commit()
        elif mtype == "user" and payload.get("text"):
            return  # 已存在却收到带文本的 user（重放），忽略
        elif mtype == "user-text":
            # 提问文本补拉事件：更新任务行 message + 落事件表（回放时前端回填 user 条目）+ 推 web
            msg = str(payload.get("text", ""))[:8000]
            task.message_enc = crypto.encrypt(_owner_key(session, task), msg)
            task.message = "" if task.message_enc else msg
            session.add(task)
        payload_json = json.dumps(payload, ensure_ascii=False)[:131072]
        payload_enc = crypto.encrypt(_owner_key(session, task), payload_json)
        session.add(
            models.A2aEvent(
                task_id=round_key,
                workspace_id=workspace_id,
                user_id=task.user_id,
                kind="monitor",
                round_key=round_key,
                payload="{}" if payload_enc else payload_json,
                payload_enc=payload_enc,
            )
        )
        # 权限/提问 → input-required；idle → completed；text 事件累积为最终回答（artifact）
        # 注意：input-required 期间 text/reasoning/tool 事件**不把状态推回 working**——
        # 权限等待中仍会收到此前发起工具的收尾快照（completed/reasoning 尾帧），它们不是新活动；
        # 误推回 working 会导致 web 应答 409（task is working）且条目状态混乱，流程看似卡死。
        # 能离开 input-required 的只有：reply 端点（用户应答）或 idle（轮结束）。
        if mtype in ("permission", "question") and task.status not in ("completed", "failed", "canceled"):
            task.status = "input-required"
        elif mtype == "replied" and task.status == "input-required":
            # web 端应答到达（插件确认 opencode API 已受理）：离开等待态回 working。
            # stillWaiting=true = 同轮还有别的权限/提问排队，保持 input-required
            if not payload.get("stillWaiting"):
                task.status = "working"
        elif mtype == "idle" and task.status not in ("completed", "failed", "canceled"):
            # idle = 轮结束：无论是否还在等权限（未应答即放弃/已在 TUI 处理），轮次收尾
            task.status = "completed"
            task.done_at = models.utcnow()
        if mtype == "text":
            # replace 全量快照：最后一条 text 即本轮完整回答（与 A2A artifact 同语义）
            art = str(payload.get("text", ""))[:60000]
            task.artifact_enc = crypto.encrypt(_owner_key(session, task), art)
            task.artifact = None if task.artifact_enc else art
        session.add(task)
        session.commit()
    await _push_web(workspace_id, payload, "monitor")
    # 被新轮顶替的旧前台轮：web 条目收尾 + 通知内部监听者（feishu 时间线卡 finalize）
    for old in superseded:
        ev = {"kind": "status-update", "taskId": old.id,
              "status": {"state": "completed", "superseded": True}}
        await _push_web(workspace_id, ev)
        await _push_web(workspace_id, {"type": "task", "task": {**task_obj(old), "status": "completed"}})
        for listener in internal_listeners:
            try:
                await listener(workspace_id, ev)
            except Exception:
                pass
    # 内部监听者（feishu 等）
    for listener in internal_listeners:
        try:
            await listener(workspace_id, payload)
        except Exception:
            pass
    with Session(engine) as session:
        t = session.get(models.A2aTask, round_key)
        if t is not None:
            await _push_web(workspace_id, {"type": "task", "task": task_obj(t)})


# ---------------------------------------------------------------- HTTP：Agent Card


def _base_url(request: Request) -> str:
    public = cfg_get("AGENT_SWARM_PUBLIC_URL")
    if public:
        return public.rstrip("/")
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.headers.get("host", request.url.netloc))
    return f"{proto}://{host}"


WORKSPACE_EXT_URI = "agent-swarm:workspaces"


@router.get("/.well-known/agent-card.json")
def agent_card_root(request: Request):
    """服务器级 Agent Card：网关本身是一个 A2A server agent（message/send 走 workspaces 扩展寻址）。

    skills 列出当前用户可见的在线工作区（鉴权后由前端/工具按 apikey 拉取；这里匿名只给框架信息，
    具体工作区寻址走 /a2a/{workspace_id} 各自的 card）。
    """
    base = _base_url(request)
    return {
        "name": "agent_swarm",
        "description": "agent_swarm workspace hub: route A2A tasks to registered agent workspaces.",
        "url": f"{base}/a2a",
        "version": "0.3.0",
        "protocolVersion": "0.3.0",
        "preferredTransport": "JSONRPC",
        "capabilities": {"streaming": True},
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain", "text/markdown"],
        "skills": [],
        "extensions": [{"uri": WORKSPACE_EXT_URI, "required": False}],
    }


@router.get("/a2a/{workspace_id}")
def agent_card_workspace(workspace_id: str, request: Request):
    with Session(engine) as session:
        ws = session.get(models.Workspace, workspace_id)
    if ws is None:
        raise HTTPException(404, "workspace not found")
    base = _base_url(request)
    online = ws_online(workspace_id)
    return {
        "name": ws.name,
        "description": ws.purpose or f"agent workspace {ws.name}",
        "url": f"{base}/a2a/{ws.id}",
        "version": "0.3.0",
        "protocolVersion": "0.3.0",
        "preferredTransport": "JSONRPC",
        "capabilities": {"streaming": True},
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain", "text/markdown"],
        "skills": [
            {
                "id": f"{ws.id}-general",
                "name": "general task execution",
                "description": (ws.capabilities or "Execute tasks in this workspace."),
            }
        ],
        "extensions": [
            {"uri": WORKSPACE_EXT_URI, "params": {"workspace_id": ws.id, "online": online, "agent_type": ws.agent_type or ""}}
        ],
    }


# ---------------------------------------------------------------- HTTP：JSON-RPC 入站（message/send 等）


def _err(code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": None, "error": {"code": code, "message": message}}


def _result(id_, result: dict) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def _text_from_message(params: dict) -> tuple[str, str, str]:
    """Message → (text, taskId, contextId)。"""
    msg = params.get("message") or {}
    parts = msg.get("parts") or []
    text = "\n".join(p.get("text", "") for p in parts if p.get("kind") == "text")
    return text, str(msg.get("taskId", "")), str(msg.get("contextId", ""))


def _auth_ws_user(request: Request) -> models.User | None:
    """apikey 鉴权（HTTP 端点）。"""
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return None
    return _auth_apikey(auth[7:].strip())


def _load_task_for_user(user: models.User, task_id: str) -> tuple[models.A2aTask, models.Workspace | None]:
    with Session(engine) as session:
        task = session.get(models.A2aTask, task_id)
        if task is None:
            raise HTTPException(404, "task not found")
        ws = session.get(models.Workspace, task.workspace_id) if task.workspace_id else None
        if ws is not None and ws.user_id != user.id:
            raise HTTPException(403, "not your task")
        if ws is None and not task.external_url:
            raise HTTPException(403, "not your task")
        # 脱离 session 后只读使用
        session.expunge(task)
        return task, ws


async def _dispatch_to_plugin(task: models.A2aTask, message_text: str, caller: str) -> None:
    """把 message/send 转成 JSON-RPC request 推给目标工作区插件。"""
    await _dispatch_to_plugin_plain(
        {"id": task.id, "context_id": task.context_id, "workspace_id": task.workspace_id},
        message_text,
        caller,
    )


async def _dispatch_to_plugin_plain(task_snap: dict, message_text: str, caller: str) -> None:
    """同上，但接受纯字段快照（流式生成器场景，ORM 对象已不可用）。"""
    conn = plugins.get(task_snap["workspace_id"])
    if conn is None:
        return
    # 附带工作区当前会话 id（heartbeat 上报）：插件以此为执行/续聊锚点
    with Session(engine) as session:
        ws = session.get(models.Workspace, task_snap["workspace_id"])
        session_id = (ws.session_id if ws else "") or ""
    req = {
        "jsonrpc": "2.0",
        "id": f"srv-{task_snap['id']}",
        "method": "message/send",
        "params": {
            "message": user_message(message_text, task_id=task_snap["id"], context_id=task_snap["context_id"]),
            "metadata": {"caller": caller, "session_id": session_id},
        },
    }
    fut: asyncio.Future = asyncio.get_running_loop().create_future()
    conn.pending[req["id"]] = fut

    async def _cleanup():
        await asyncio.sleep(30)  # 插件同步应答上限（后续事件走 event 通道）
        if not fut.done():
            fut.set_exception(TimeoutError("plugin rpc no response"))

    t = asyncio.create_task(_cleanup())
    ok = await _send_json(conn.ws, {"type": "rpc", "payload": req})
    if not ok:
        conn.pending.pop(req["id"], None)
        fut.set_exception(ConnectionError("plugin connection lost"))
    conn.tasks.add(t)
    t.add_done_callback(conn.tasks.discard)


def _mark_task(session: Session, task_id: str, status: str, error: str | None = None) -> None:
    task = session.get(models.A2aTask, task_id)
    if task is None or task.status in ("completed", "failed", "canceled"):
        return
    task.status = status
    if error:
        task.error_enc = crypto.encrypt(_owner_key(session, task), error)
        task.error = None if task.error_enc else error
    task.done_at = models.utcnow()
    session.add(task)


@router.post("/a2a/{workspace_id}")
async def a2a_rpc(workspace_id: str, request: Request):
    """A2A JSON-RPC 端点：message/send / message/stream / tasks/get / tasks/cancel。"""
    user = _auth_ws_user(request)
    if user is None:
        return JSONResponse(_err(-32001, "invalid api key"), status_code=401)
    try:
        body = json.loads((await request.body()) or b"{}")
    except ValueError:
        return JSONResponse(_err(-32700, "parse error"), status_code=400)
    rpc_id = body.get("id")
    method = str(body.get("method", ""))
    params = body.get("params") or {}

    with Session(engine) as session:
        ws = session.get(models.Workspace, workspace_id)
        if ws is None or ws.user_id != user.id:
            return JSONResponse(_err(-32002, "workspace not found or not visible"), status_code=404)
        if ws.status == "disabled" or not ws_online(workspace_id):
            return JSONResponse(_err(-32004, "workspace plugin is not online"), status_code=409)

        if method == "message/send" or method == "message/stream":
            text, task_id, context_id = _text_from_message(params)
            if not text:
                return JSONResponse(_err(-32602, "message.text is required"))
            caller = str((params.get("metadata") or {}).get("caller") or "a2a-client")
            if task_id:
                # 续聊（input-required 应答 / 多轮）：复用已有任务
                task = session.get(models.A2aTask, task_id)
                if task is None or task.workspace_id != ws.id:
                    return JSONResponse(_err(-32001, "task not found"))
                if task.status not in ("input-required", "working", "queued"):
                    return JSONResponse(_err(-32005, f"task is {task.status}, cannot continue"))
                task.status = "working" if task.status == "input-required" else task.status
                session.add(task)
                session.commit()
            else:
                task = models.A2aTask(
                    id=shortuuid.uuid(),
                    context_id=context_id or shortuuid.uuid(),
                    workspace_id=ws.id,
                    user_id=ws.user_id,
                    caller=caller,
                    status="queued",
                )
                msg_enc = crypto.encrypt(ws_user_key(session, ws), text)
                task.message_enc = msg_enc
                task.message = "" if msg_enc else text
                session.add(task)
                session.commit()

            streaming = method == "message/stream"
            if streaming:
                # 提取字段快照（流式生成器在 session 关闭后跑，不能引用 ORM 对象）
                task_snap = {
                    "id": task.id,
                    "context_id": task.context_id,
                    "workspace_id": task.workspace_id,
                }
                return await _stream_response(task_snap, text, caller)
            # 非流式：推给插件，同步等终态（最多 CALL_TIMEOUT）
            await _dispatch_to_plugin(task, text, caller)
            final = await _wait_final(task.id, CALL_TIMEOUT_SECONDS)
            with Session(engine) as session2:
                t2 = session2.get(models.A2aTask, task.id)
                if t2 is None:
                    return JSONResponse(_err(-32001, "task lost"))
                return _result(rpc_id, task_obj(t2))

        elif method == "tasks/get":
            task_id = str(params.get("id", ""))
            task, _ = _load_task_for_user(user, task_id)
            return _result(rpc_id, task_obj(task))

        elif method == "tasks/cancel":
            task_id = str(params.get("id", ""))
            task, _ = _load_task_for_user(user, task_id)
            if task.status in ("completed", "failed", "canceled"):
                return _result(rpc_id, task_obj(task))
            # 通知插件取消（尽力而为）；任务置 canceled
            conn = plugins.get(task.workspace_id) if task.workspace_id else None
            if conn is not None:
                await _send_json(
                    conn.ws,
                    {
                        "type": "rpc",
                        "payload": {
                            "jsonrpc": "2.0",
                            "id": f"srv-cancel-{task.id}",
                            "method": "tasks/cancel",
                            "params": {"id": task.id},
                        },
                    },
                )
            with Session(engine) as session2:
                _mark_task(session2, task.id, "canceled")
            await _push_web(task.workspace_id, status_event(task, True))
            return _result(rpc_id, task_obj(task))

        else:
            return JSONResponse(_err(-32601, f"method not supported: {method}"))


# 任务超时收割（reap）已彻底移除（2026-09-18 用户决定）：
# - 后台会话不产生权限交互，不会卡死；前台会话由 idle / 新轮顶替收尾
# - AI 互调发起方自带超时（_wait_final / a2a_task 轮询），自己会停止
# - 插件崩溃丢终态时任务停在 working：web 调用记录页可手动取消


async def _wait_final(task_id: str, timeout: float) -> None:
    """事件驱动等任务终态（handle_plugin_event 广播）；超时置 failed。"""
    q = _task_subscribe(task_id)
    try:
        # 先查一次（事件可能已经来过）
        with Session(engine) as session:
            t = session.get(models.A2aTask, task_id)
            if t is not None and t.status in TERMINAL_STATES:
                return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            try:
                _, event = await asyncio.wait_for(q.get(), timeout=max(remaining, 0.1))
            except asyncio.TimeoutError:
                break
            if event.get("kind") == "status-update":
                state = str((event.get("status") or {}).get("state", ""))
                if state in TERMINAL_STATES:
                    return
        # 超时：置 failed
        with Session(engine) as session:
            _mark_task(session, task_id, "failed", f"timeout after {int(timeout)}s")
    finally:
        _task_unsubscribe(task_id, q)


async def _stream_response(task_snap: dict, text: str, caller: str):
    """message/stream：SSE，事件总线驱动，实时推 status/artifact 事件，终态收尾。

    task_snap: {id, context_id, workspace_id}（纯字段，ORM 对象已随请求 session 关闭）
    """

    async def gen():
        task_id = task_snap["id"]
        q = _task_subscribe(task_id)
        try:
            # 先推任务快照（A2A 规范：首个事件为 Task 对象）
            with Session(engine) as s:
                t = s.get(models.A2aTask, task_id)
                snap_obj = task_obj(t) if t is not None else {"id": task_id, "kind": "task"}
            yield f"data: {json.dumps({'jsonrpc': '2.0', 'id': None, 'result': snap_obj}, ensure_ascii=False)}\n\n"
            # 回放历史事件（断线重连/晚订阅不丢事件）
            with Session(engine) as s:
                rows = s.exec(
                    select(models.A2aEvent)
                    .where(models.A2aEvent.task_id == task_id)
                    .order_by(models.A2aEvent.id)
                ).all()
                apikeys = _apikeys_for_rows(s, rows)
                last_event_id = 0
                for r in rows:
                    last_event_id = r.id
                    try:
                        payload = json.loads(event_payload_text(r, apikeys))
                    except ValueError:
                        continue
                    ev = {"jsonrpc": "2.0", "id": None, "result": payload}
                    yield f"id: {r.id}\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
            # 派发给插件（在回放之后，避免事件乱序）
            await _dispatch_to_plugin_plain(task_snap, text, caller)
            deadline = time.monotonic() + CALL_TIMEOUT_SECONDS
            while time.monotonic() < deadline:
                remaining = deadline - time.monotonic()
                try:
                    event_id, event = await asyncio.wait_for(q.get(), timeout=max(remaining, 0.1))
                except asyncio.TimeoutError:
                    break
                if event_id <= last_event_id:
                    continue
                last_event_id = event_id
                ev = {"jsonrpc": "2.0", "id": None, "result": event}
                yield f"id: {event_id}\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
                if event.get("kind") == "status-update":
                    state = str((event.get("status") or {}).get("state", ""))
                    if state in TERMINAL_STATES:
                        return
            # 超时未终态：置 failed 并推送
            with Session(engine) as s:
                t = s.get(models.A2aTask, task_id)
                if t is not None and t.status not in TERMINAL_STATES:
                    _mark_task(s, task_id, "failed", f"timeout after {int(CALL_TIMEOUT_SECONDS)}s")
                    s.commit()
                    s.refresh(t)
                    ev = {"jsonrpc": "2.0", "id": None, "result": status_event(t, True)}
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        finally:
            _task_unsubscribe(task_id, q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------- 出站：调用外部 A2A agent


async def call_external(url: str, text: str, context_id: str = "", task_id: str = "", api_key: str = "") -> tuple[str, str, str]:
    """调外部 A2A agent（message/send 非流式），返回 (task_id, context_id, status)。

    失败抛 HTTPException(502)。
    """
    import httpx

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    msg = user_message(text, task_id=task_id, context_id=context_id)
    body = {"jsonrpc": "2.0", "id": 1, "method": "message/send", "params": {"message": msg}}
    try:
        async with httpx.AsyncClient(timeout=CALL_TIMEOUT_SECONDS) as client:
            rsp = await client.post(url, json=body, headers=headers)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"A2A endpoint unreachable: {e}")
    if rsp.status_code != 200:
        raise HTTPException(502, f"A2A endpoint returned {rsp.status_code}")
    data = rsp.json()
    if data.get("error"):
        raise HTTPException(502, f"A2A error: {data['error'].get('message', 'unknown')}")
    task = data.get("result") or {}
    return str(task.get("id", "")), str(task.get("contextId", "")), str(task.get("status", {}).get("state", "unknown"))


async def get_external(url: str, task_id: str, api_key: str = "") -> dict:
    """tasks/get 外部任务（a2a_task 查询用）。"""
    import httpx

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body = {"jsonrpc": "2.0", "id": 1, "method": "tasks/get", "params": {"id": task_id}}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            rsp = await client.post(url, json=body, headers=headers)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"A2A endpoint unreachable: {e}")
    if rsp.status_code != 200:
        raise HTTPException(502, f"A2A endpoint returned {rsp.status_code}")
    data = rsp.json()
    if data.get("error"):
        raise HTTPException(502, f"A2A error: {data['error'].get('message', 'unknown')}")
    return data.get("result") or {}


# ---------------------------------------------------------------- REST：web 中枢下发/应答


def _new_task(workspace: models.Workspace, text: str, caller: str, task_id: str = "", context_id: str = "") -> models.A2aTask:
    task = models.A2aTask(
        id=task_id or shortuuid.uuid(),
        context_id=context_id or shortuuid.uuid(),
        workspace_id=workspace.id,
        user_id=workspace.user_id,
        caller=caller,
        status="queued",
    )
    msg_enc = crypto.encrypt(_api_key_of(workspace.user_id), text)
    task.message_enc = msg_enc
    task.message = "" if msg_enc else text
    return task


async def _send_message_core(ws_row: models.Workspace, text: str, caller: str, task_id: str = "", context_id: str = "") -> dict:
    """web/REST 侧 message/send 共用逻辑：落任务 + 推插件。"""
    with Session(engine) as session:
        if task_id:
            task = session.get(models.A2aTask, task_id)
            if task is None or task.workspace_id != ws_row.id:
                raise HTTPException(404, "task not found")
            if task.status not in ("queued", "working", "input-required"):
                raise HTTPException(409, f"task is {task.status}, cannot continue")
            task.status = "working" if task.status == "input-required" else task.status
            session.add(task)
            session.commit()
            session.refresh(task)
        else:
            task = _new_task(ws_row, text, caller, context_id=context_id)
            session.add(task)
            session.commit()
            session.refresh(task)
        snap = task_obj(task)
    if ws_online(ws_row.id):
        import asyncio

        asyncio.ensure_future(_dispatch_to_plugin(task, text, caller))
    return snap


@router.post("/api/nexus/{workspace_id}/message:send")
async def nexus_send(workspace_id: str, request: Request):
    """web 中枢下发任务（JWT 鉴权）。body: {text, task_id?, context_id?}"""
    user = await _require_jwt_http(request)
    body = await _json_body(request)
    text = str(body.get("text", "")).strip()
    if not text:
        raise HTTPException(422, "text is required")
    with Session(engine) as session:
        ws = session.get(models.Workspace, workspace_id)
        if ws is None or ws.user_id != user.id:
            raise HTTPException(404, "workspace not found")
        if ws.status == "disabled":
            raise HTTPException(409, "workspace is disabled")
        # 在线判定以插件 WS 为准（WS 在线即证明工作区可用；心跳 90s 超时只影响展示态）
        if not ws_online(workspace_id):
            raise HTTPException(409, "workspace plugin is not online")
        snap = await _send_message_core(ws, text, "nexus-web", task_id=str(body.get("task_id", "")), context_id=str(body.get("context_id", "")))
    return snap


@router.post("/api/nexus/{workspace_id}/reply")
async def nexus_reply(workspace_id: str, request: Request):
    """web 中枢应答 input-required 任务（JWT 鉴权）。

    body: {task_id, type: "permission"|"question", request_id, reply?: "once"|"always"|"reject", answers?: [[..]]}
    服务端转成 A2A 续聊 message/send（DataPart 携带应答），插件据此调 opencode API。
    """
    user = await _require_jwt_http(request)
    body = await _json_body(request)
    task_id = str(body.get("task_id", ""))
    req_type = str(body.get("type", ""))
    request_id = str(body.get("request_id", ""))
    if req_type not in ("permission", "question") or not task_id or not request_id:
        raise HTTPException(422, "task_id/type/request_id required")
    with Session(engine) as session:
        task = session.get(models.A2aTask, task_id)
        if task is None or task.workspace_id != workspace_id:
            raise HTTPException(404, "task not found")
        ws = session.get(models.Workspace, workspace_id)
        if ws is None or ws.user_id != user.id:
            raise HTTPException(403, "no permission")
        # 前台监控轮（caller=monitor）：状态机宽松处理——只要任务未终态就接受应答。
        # 权限等待期间 part 快照事件多，状态可能仍在 working；且 TUI 与 web 竞答应答，
        # 严格校验 input-required 会误伤（409 卡死用户流程）。应答转发给插件后，
        # opencode API 找不到对应 permission 会自然报错，真实状态由插件侧兜底。
        if task.caller == "monitor":
            if task.status in ("completed", "failed", "canceled"):
                raise HTTPException(409, f"task is {task.status}, cannot reply")
        elif task.status != "input-required":
            raise HTTPException(409, f"task is {task.status}, not waiting for input")
    conn = plugins.get(workspace_id)
    if conn is None:
        raise HTTPException(409, "workspace plugin is not online")
    data: dict = {"type": req_type, "requestId": request_id, "taskId": task_id}
    if req_type == "permission":
        reply = str(body.get("reply", ""))
        if reply not in ("once", "always", "reject"):
            raise HTTPException(422, "reply must be once/always/reject")
        data["reply"] = reply
    else:
        answers = body.get("answers")
        if not isinstance(answers, list) or not answers:
            raise HTTPException(422, "answers required")
        data["answers"] = answers
    # 续聊消息：role=user 的 DataPart
    msg = {
        "role": "user",
        "parts": [{"kind": "data", "data": data}],
        "messageId": f"msg-{task_id}-reply-{request_id}",
        "taskId": task_id,
        "contextId": "",
    }
    req = {
        "jsonrpc": "2.0",
        "id": f"srv-reply-{request_id}",
        "method": "message/send",
        "params": {"message": msg, "metadata": {"caller": "nexus-web-reply"}},
    }
    ok = await _send_json(conn.ws, {"type": "rpc", "payload": req})
    if not ok:
        raise HTTPException(502, "plugin connection lost")
    return {"ok": True, "status": "working"}


# ---------------------------------------------------------------- 飞书渠道入口（nexus-feishu）


async def cancel_task_by_id(task_id: str, user_id: str) -> bool:
    """按任务 ID 取消（feishu 中断按钮）。校验任务属于 user_id 的工作区。

    返回是否受理（任务不存在/不属你/已终态 → False）。
    """
    with Session(engine) as session:
        task = session.get(models.A2aTask, task_id)
        if task is None:
            return False
        ws = session.get(models.Workspace, task.workspace_id) if task.workspace_id else None
        if ws is None or ws.user_id != user_id:
            return False
        wid = task.workspace_id
        if task.status in TERMINAL_STATES:
            return False
    conn = plugins.get(wid)
    if conn is not None:
        await _send_json(
            conn.ws,
            {"type": "rpc", "payload": {
                "jsonrpc": "2.0",
                "id": f"srv-cancel-{task_id}",
                "method": "tasks/cancel",
                "params": {"id": task_id},
            }},
        )
    with Session(engine) as session:
        _mark_task(session, task_id, "canceled")
        session.commit()
        t = session.get(models.A2aTask, task_id)
        snap = task_obj(t) if t is not None else None
    if snap is not None:
        await _push_web(wid, status_event_from_snap(snap, True))
        # 飞书/web 卡片都靠 task 快照更新终态
        for listener in internal_listeners:
            try:
                await listener(wid, status_event_from_snap(snap, True))
            except Exception:
                pass
    return True


def status_event_from_snap(snap: dict, final: bool) -> dict:
    """task_obj 快照 → status-update 事件（cancel 后广播用，绕开 ORM 会话生命周期）。"""
    return {
        "taskId": snap.get("id", ""),
        "contextId": snap.get("contextId", ""),
        "kind": "status-update",
        "status": snap.get("status") or {"state": "canceled"},
        "final": final,
    }


async def reply_task_from_feishu(task_id: str, reply: str, request_id: str) -> tuple[bool, str]:
    """飞书卡片应答 input-required（权限 once/always/reject 或提问自由文本）。

    权限复用与 web reply 相同的 DataPart 语义；提问自由文本按 answers=[text] 传递。
    返回 (ok, message)。
    """
    with Session(engine) as session:
        task = session.get(models.A2aTask, task_id)
        if task is None:
            return False, "task not found"
        wid = task.workspace_id
        itype = _input_type(task)
    conn = plugins.get(wid)
    if conn is None:
        return False, "workspace plugin is not online"
    data: dict = {"requestId": request_id or task_id, "taskId": task_id}
    if itype == "question":
        data["type"] = "question"
        data["answers"] = [reply]
    else:
        data["type"] = "permission"
        data["reply"] = reply if reply in ("once", "always", "reject") else "once"
    msg = {
        "role": "user",
        "parts": [{"kind": "data", "data": data}],
        "messageId": f"msg-{task_id}-feishu-{request_id or task_id}",
        "taskId": task_id,
        "contextId": "",
    }
    req = {
        "jsonrpc": "2.0",
        "id": f"srv-reply-feishu-{request_id or task_id}",
        "method": "message/send",
        "params": {"message": msg, "metadata": {"caller": "nexus-feishu-reply"}},
    }
    ok = await _send_json(conn.ws, {"type": "rpc", "payload": req})
    return (True, "") if ok else (False, "plugin connection lost")


@router.get("/api/nexus/{workspace_id}/history")
async def nexus_history(workspace_id: str, request: Request, limit: int = 800):
    """工作区任务事件历史（JWT 鉴权，web 回放渲染）。"""
    user = await _require_jwt_http(request)
    with Session(engine) as session:
        ws = session.get(models.Workspace, workspace_id)
        if ws is None or ws.user_id != user.id:
            raise HTTPException(404, "workspace not found")
        rows = session.exec(
            select(models.A2aEvent)
            .where(models.A2aEvent.workspace_id == workspace_id)
            .order_by(models.A2aEvent.id)
            .limit(min(limit, 2000))
        ).all()
        apikeys = _apikeys_for_rows(session, rows)
        out = []
        for r in rows:
            try:
                out.append(json.loads(event_payload_text(r, apikeys)))
            except ValueError:
                continue
    return {"events": out, "plugin_online": ws_online(workspace_id)}


@router.delete("/api/nexus/{workspace_id}/history")
async def nexus_history_clear(workspace_id: str, request: Request):
    """清空工作区任务事件与任务记录（JWT 鉴权）。"""
    user = await _require_jwt_http(request)
    with Session(engine) as session:
        ws = session.get(models.Workspace, workspace_id)
        if ws is None or ws.user_id != user.id:
            raise HTTPException(404, "workspace not found")
        for r in session.exec(
            select(models.A2aEvent).where(models.A2aEvent.workspace_id == workspace_id)
        ).all():
            session.delete(r)
        for t in session.exec(
            select(models.A2aTask).where(models.A2aTask.workspace_id == workspace_id)
        ).all():
            session.delete(t)
        session.commit()
    return {"ok": True}


async def _require_jwt_http(request: Request) -> models.User:
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
    user = _auth_jwt(token)
    if user is None:
        raise HTTPException(401, "invalid token")
    return user


async def _json_body(request: Request) -> dict:
    try:
        data = json.loads((await request.body()) or b"{}")
        return data if isinstance(data, dict) else {}
    except ValueError:
        raise HTTPException(400, "invalid json")


# ---------------------------------------------------------------- WS：插件链路


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
                user = _auth_apikey(str(msg.get("apikey", "")))
                if user is None:
                    await _send_json(ws, {"type": "hello_err", "error": "invalid api key"})
                    continue
                wid = str(msg.get("workspace_id", ""))
                with Session(engine) as session:
                    row = session.exec(_select_ws(user.id, wid)).first()
                if row is None:
                    await _send_json(ws, {"type": "hello_err", "error": "workspace not found"})
                    continue
                old = plugins.get(wid)
                if old is not None:
                    try:
                        await old.ws.close(code=4001, reason="replaced by new connection")
                    except Exception:
                        pass
                    plugins.pop(wid, None)
                plugin = PluginConn(ws=ws, user_id=user.id, workspace_id=wid)
                plugins[wid] = plugin
                await _send_json(ws, {"type": "hello_ok"})
                # 补推排队任务（插件离线期间 message/send 落库 queued，上线即领）
                asyncio.create_task(_flush_queued(wid, plugin))
                log.info("plugin connected: ws=%s user=%s", wid, user.id)
                continue

            if plugin is None:
                await _send_json(ws, {"type": "hello_err", "error": "hello first"})
                continue

            if mtype == "ping":
                await _send_json(ws, {"type": "pong"})
            elif mtype == "rpc":
                # 插件对服务端 request 的同步应答（解析 pending future）
                payload = msg.get("payload") or {}
                rid = str(payload.get("id", ""))
                fut = plugin.pending.pop(rid, None)
                if fut is not None and not fut.done():
                    if payload.get("error"):
                        fut.set_exception(RuntimeError(str(payload["error"].get("message", "plugin error"))))
                    else:
                        fut.set_result(payload.get("result") or {})
                else:
                    # 无 pending：插件主动请求（如 tasks/cancel 应答），暂忽略
                    pass
            elif mtype == "event":
                payload = msg.get("payload") or {}
                if len(raw) < 256 * 1024:
                    asyncio.create_task(handle_plugin_event(plugin.workspace_id, payload))
            elif mtype == "monitor":
                payload = msg.get("payload") or {}
                if len(raw) < 256 * 1024:
                    asyncio.create_task(handle_monitor_event(plugin.workspace_id, payload))
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.warning("plugin ws error: %s", e)
    finally:
        if plugin is not None and plugins.get(plugin.workspace_id) is plugin:
            plugins.pop(plugin.workspace_id, None)
            # 失联的 pending rpc 全部置错
            for fut in plugin.pending.values():
                if not fut.done():
                    fut.set_exception(ConnectionError("plugin disconnected"))
            plugin.pending.clear()
            log.info("plugin disconnected: ws=%s", plugin.workspace_id)


async def _flush_queued(workspace_id: str, conn: PluginConn) -> None:
    """插件上线时补推 queued 任务。"""
    await asyncio.sleep(0.5)  # 等 hello_ok 发完
    await dispatch_queued_for(workspace_id)


def _ws_session_id(workspace_id: str) -> str:
    """工作区当前会话 id（heartbeat 上报）；无则空串。"""
    with Session(engine) as session:
        ws = session.get(models.Workspace, workspace_id)
        return (ws.session_id if ws else "") or ""


async def dispatch_queued_for(workspace_id: str) -> int:
    """把某工作区的 queued 任务推给在线插件（a2a_call / 插件上线共用）。返回派发数。"""
    conn = plugins.get(workspace_id)
    if conn is None:
        return 0
    with Session(engine) as session:
        rows = session.exec(
            select(models.A2aTask)
            .where(models.A2aTask.workspace_id == workspace_id)
            .where(models.A2aTask.status == "queued")
            .order_by(models.A2aTask.created_at)
        ).all()
        items = [(t.id, t.message, t.caller) for t in rows]
    n = 0
    for tid, text, caller in items:
        # 派发前置 working（accepted_at 记录开始时间）
        with Session(engine) as session:
            t = session.get(models.A2aTask, tid)
            if t is None or t.status != "queued":
                continue
            t.status = "working"
            t.accepted_at = models.utcnow()
            session.add(t)
            session.commit()
        req = {
            "jsonrpc": "2.0",
            "id": f"srv-{tid}",
            "method": "message/send",
            "params": {
                "message": user_message(text, task_id=tid, context_id=""),
                "metadata": {"caller": caller or "agent", "session_id": _ws_session_id(workspace_id)},
            },
        }
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        conn.pending[req["id"]] = fut
        ok = await _send_json(conn.ws, {"type": "rpc", "payload": req})
        if ok:
            n += 1
        else:
            conn.pending.pop(req["id"], None)
    return n


# ---------------------------------------------------------------- WS：web 中枢订阅


def _latest_round_events(workspace_id: str) -> dict:
    """最新一轮的全部事件（subscribe 回放用）。

    返回 {events: [...], first_id: int}；first_id 供前端做上滚分页游标
    （曾缺失导致首次上滚 before_id=0 又拉回最新一轮，重复重放当前内容）。
    """
    with Session(engine) as session:
        latest = session.exec(
            select(models.A2aEvent.round_key, func.max(models.A2aEvent.id).label("max_id"))
            .where(models.A2aEvent.workspace_id == workspace_id)
            .where(models.A2aEvent.round_key != "")
            .group_by(models.A2aEvent.round_key)
            .order_by(func.max(models.A2aEvent.id).desc())
            .limit(1)
        ).first()
        if latest is None:
            return {"events": [], "first_id": 0}
        rows = session.exec(
            select(models.A2aEvent)
            .where(models.A2aEvent.workspace_id == workspace_id)
            .where(models.A2aEvent.round_key == latest[0])
            .order_by(models.A2aEvent.id)
        ).all()
        apikeys = _apikeys_for_rows(session, rows)
        events = []
        for r in rows:
            try:
                events.append(json.loads(event_payload_text(r, apikeys)))
            except ValueError:
                continue
        return {"events": events, "first_id": int(rows[0].id) if rows else 0}


@router.get("/api/nexus/{workspace_id}/rounds")
async def nexus_rounds(workspace_id: str, request: Request, before_id: int = 0):
    """中枢时间线向上滚动分页：before_id 之前最近一轮的全部事件（JWT 鉴权）。

    返回 {events: [...], first_id: <本轮最小事件id>, has_more: bool}；
    events 按事件 id 升序（web prepend 渲染）。has_more=false 表示没有更早的轮。
    """
    user = await _require_jwt_http(request)
    with Session(engine) as session:
        ws = session.get(models.Workspace, workspace_id)
        if ws is None or ws.user_id != user.id:
            raise HTTPException(404, "workspace not found")
        cond = [models.A2aEvent.workspace_id == workspace_id, models.A2aEvent.round_key != ""]
        if before_id > 0:
            cond.append(models.A2aEvent.id < before_id)
        latest = session.exec(
            select(models.A2aEvent.round_key, func.max(models.A2aEvent.id).label("max_id"))
            .where(*cond)
            .group_by(models.A2aEvent.round_key)
            .order_by(func.max(models.A2aEvent.id).desc())
            .limit(1)
        ).first()
        if latest is None:
            return {"events": [], "first_id": 0, "has_more": False}
        rows = session.exec(
            select(models.A2aEvent)
            .where(models.A2aEvent.workspace_id == workspace_id)
            .where(models.A2aEvent.round_key == latest[0])
            .order_by(models.A2aEvent.id)
        ).all()
        apikeys = _apikeys_for_rows(session, rows)
        events = []
        for r in rows:
            try:
                events.append(json.loads(event_payload_text(r, apikeys)))
            except ValueError:
                continue
        first_id = int(rows[0].id) if rows else 0
        # 本轮之前是否还有更早的轮
        earlier = session.exec(
            select(models.A2aEvent.id)
            .where(models.A2aEvent.workspace_id == workspace_id)
            .where(models.A2aEvent.round_key != "")
            .where(models.A2aEvent.id < first_id)
            .limit(1)
        ).first()
        return {"events": events, "first_id": first_id, "has_more": earlier is not None}


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
                    await _send_json(ws, {"type": "hello_err", "error": "invalid token"})
                    continue
                conn = WebConn(ws=ws, user_id=user.id)
                await _send_json(ws, {"type": "hello_ok"})
                continue

            if conn is None:
                await _send_json(ws, {"type": "hello_err", "error": "hello first"})
                continue

            if mtype == "ping":
                await _send_json(ws, {"type": "pong"})
            elif mtype == "subscribe":
                wid = str(msg.get("workspace_id", ""))
                if not _owns(conn.user_id, wid):
                    await _send_json(ws, {"type": "subscribed", "error": "no permission"})
                    continue
                _unsubscribe(conn)
                subscribers.setdefault(wid, set()).add(conn)
                conn.workspace_id = wid
                online = ws_online(wid)
                # 回放最新一轮（A2A 形状 + monitor 事件，web 自行归并渲染）；
                # 更早的轮由 web 上滚时经 /api/nexus/{wid}/rounds 分页拉取
                replay = _latest_round_events(wid)
                await _send_json(
                    ws,
                    {
                        "type": "subscribed",
                        "workspace_id": wid,
                        "plugin_online": online,
                        "history": replay["events"],
                        "first_id": replay["first_id"],
                    },
                )
            elif mtype == "unsubscribe":
                _unsubscribe(conn)
                await _send_json(ws, {"type": "unsubscribed"})
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.warning("web ws error: %s", e)
    finally:
        if conn is not None:
            _unsubscribe(conn)


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
        user = session.exec(select(models.User).where(models.User.api_key_hash == key_hash)).first()
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
