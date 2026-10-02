"""规划器控制通道（2026-10-03）：`/ws/planner` + `/api/planner/*`。

背景：planner-core 在用户内网/本机，平台访问不到它的端口，所以由 **core 主动**向
平台建立 WebSocket 长连接：平台网页的目标/审批/验收操作经该 WS 下发；core 把
「目标 + 任务树」结构化快照也从同一条 WS 推回，平台按 workspace 缓存一份供展示
（**展示缓存，非任务真相**，真相在 core 的 SQLite）。

协议见 `agent-swarm-planner/docs/planner-platform-protocol.md`：
  hello → hello_ok / hello_err；ping → pong
  平台→core {"type":"op","op_id","op","payload"}
  core→平台 {"type":"op_result","op_id","ok","error"} / {"type":"state","payload":{...}}

与 `/ws/plugin` 分开（那是 agent 插件链路、会抢任务派发），也不塞进 `/ws/nexus`。
"""
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from sqlmodel import Session

from server import models
from server.db import engine
from server.nexus_a2a import _auth_apikey, _json_body, _require_user_http, _select_ws

log = logging.getLogger("planner")

router = APIRouter()

# 连接多久没收到任何消息算「不新鲜」（core 每 30s 推 state，另加 ping）
PLANNER_FRESH_SECONDS = 90

OPS_KEEP = 100  # 每工作区保留的最近操作/回执条数（仅展示用，内存态）


class PlannerConn:
    """planner-core 的 WS 连接（一个工作区一条，新连接替换旧的）。"""

    __slots__ = ("ws", "user_id", "workspace_id", "last_seen")

    def __init__(self, ws: WebSocket, user_id: str, workspace_id: str):
        self.ws = ws
        self.user_id = user_id
        self.workspace_id = workspace_id
        self.last_seen = time.monotonic()


# workspace_id → 连接（单条：core 断线自动重连，新连接顶替旧的）
planner_conns: dict[str, PlannerConn] = {}

# workspace_id → 最近操作/回执（内存态，重启清空；仅供「规划器」页展示历史）
_ops: dict[str, list[dict]] = {}


def _ts() -> str:
    return datetime.now(timezone.utc).isoformat()


def planner_online(workspace_id: str) -> bool:
    c = planner_conns.get(workspace_id)
    return c is not None and (time.monotonic() - c.last_seen) < PLANNER_FRESH_SECONDS


async def _send_json(ws: WebSocket, payload: dict) -> bool:
    try:
        await ws.send_text(json.dumps(payload, ensure_ascii=False))
        return True
    except Exception:  # noqa: BLE001
        return False


# ---------------------------------------------------------------- 快照缓存


def save_state(workspace_id: str, payload: dict) -> None:
    """按 workspace upsert 最新快照（同步、短会话；调用方不得在会话里 await）。"""
    text = json.dumps(payload, ensure_ascii=False)
    with Session(engine) as s:
        row = s.get(models.PlannerState, workspace_id)
        if row is None:
            row = models.PlannerState(workspace_id=workspace_id, payload=text)
        else:
            row.payload = text
            row.updated_at = models.utcnow()
        s.add(row)
        s.commit()


def load_state(workspace_id: str) -> tuple[dict, Optional[datetime]]:
    with Session(engine) as s:
        row = s.get(models.PlannerState, workspace_id)
        if row is None:
            return {}, None
        try:
            payload = json.loads(row.payload or "{}")
            if not isinstance(payload, dict):
                payload = {}
        except ValueError:
            payload = {}
        return payload, row.updated_at


# ---------------------------------------------------------------- 操作历史（内存）


def _record_op(workspace_id: str, op_id: str, op: str, payload: dict) -> None:
    lst = _ops.setdefault(workspace_id, [])
    lst.append(
        {
            "op_id": op_id,
            "op": op,
            "payload": payload,
            "ok": None,
            "error": "",
            "created_at": _ts(),
            "done_at": None,
        }
    )
    del lst[:-OPS_KEEP]


def _record_result(workspace_id: str, msg: dict) -> None:
    op_id = str(msg.get("op_id") or "")
    for rec in reversed(_ops.get(workspace_id, [])):
        if rec["op_id"] == op_id:
            rec["ok"] = bool(msg.get("ok"))
            rec["error"] = str(msg.get("error") or "")
            rec["done_at"] = _ts()
            return
    # 未记录过的回执（例如重连后补发）也留存一条，便于排查
    lst = _ops.setdefault(workspace_id, [])
    lst.append(
        {
            "op_id": op_id,
            "op": "",
            "payload": {},
            "ok": bool(msg.get("ok")),
            "error": str(msg.get("error") or ""),
            "created_at": _ts(),
            "done_at": _ts(),
        }
    )
    del lst[:-OPS_KEEP]


async def dispatch_op(workspace_id: str, op: str, payload: dict) -> str:
    """把操作经 WS 下发给 core；core 离线返回 409。返回生成的 op_id。"""
    conn = planner_conns.get(workspace_id)
    if conn is None or not planner_online(workspace_id):
        raise HTTPException(409, "planner-core 未连接")
    op_id = uuid.uuid4().hex
    ok = await _send_json(conn.ws, {"type": "op", "op_id": op_id, "op": op, "payload": payload})
    if not ok:
        if planner_conns.get(workspace_id) is conn:
            planner_conns.pop(workspace_id, None)
        raise HTTPException(409, "planner-core 发送失败（连接可能已断开）")
    _record_op(workspace_id, op_id, op, payload)
    return op_id


# ---------------------------------------------------------------- WS：planner-core 链路


@router.websocket("/ws/planner")
async def ws_planner(ws: WebSocket):
    await ws.accept()
    conn: Optional[PlannerConn] = None
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
                # 新连接替换旧连接（一个 workspace 一条）
                old = planner_conns.get(wid)
                if old is not None and old is not conn:
                    try:
                        await old.ws.close(code=4000)
                    except Exception:  # noqa: BLE001
                        pass
                conn = PlannerConn(ws=ws, user_id=user.id, workspace_id=wid)
                planner_conns[wid] = conn
                await _send_json(ws, {"type": "hello_ok"})
                log.info("planner-core connected: ws=%s user=%s", wid, user.id)
                continue

            if conn is None:
                await _send_json(ws, {"type": "hello_err", "error": "hello first"})
                continue
            conn.last_seen = time.monotonic()

            if mtype == "ping":
                await _send_json(ws, {"type": "pong"})
            elif mtype == "state":
                payload = msg.get("payload") or {}
                if isinstance(payload, dict):
                    save_state(conn.workspace_id, payload)
            elif mtype == "op_result":
                _record_result(conn.workspace_id, msg)
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.warning("planner ws error: %s", e)
    finally:
        if conn is not None and planner_conns.get(conn.workspace_id) is conn:
            planner_conns.pop(conn.workspace_id, None)
            log.info("planner-core disconnected: ws=%s", conn.workspace_id)


# ---------------------------------------------------------------- REST（属主校验）


def _own_or_404(user: models.User, workspace_id: str) -> models.Workspace:
    with Session(engine) as s:
        row = s.exec(_select_ws(user.id, workspace_id)).first()
    if row is None:
        raise HTTPException(404, "workspace not found")
    return row


@router.get("/api/planner/{workspace_id}/state")
async def planner_state(workspace_id: str, request: Request):
    """最近快照 + online（该 wid 是否有 /ws/planner 连接）。"""
    user = await _require_user_http(request)
    _own_or_404(user, workspace_id)
    payload, updated_at = load_state(workspace_id)
    return {
        "workspace_id": workspace_id,
        "online": planner_online(workspace_id),
        "updated_at": payload.get("updated_at")
        or (updated_at.isoformat() + "Z" if updated_at else None),
        "goals": payload.get("goals") or [],
        "tasks": payload.get("tasks") or [],
    }


@router.post("/api/planner/{workspace_id}/op")
async def planner_op(workspace_id: str, request: Request):
    """下发一个操作：body {op, payload} → 生成 op_id 经 WS 下发；core 离线 409。"""
    user = await _require_user_http(request)
    _own_or_404(user, workspace_id)
    body = await _json_body(request)
    op = str(body.get("op") or "").strip()
    if not op:
        raise HTTPException(422, "op is required")
    payload = body.get("payload")
    if not isinstance(payload, dict):
        payload = {}
    op_id = await dispatch_op(workspace_id, op, payload)
    return {"op_id": op_id, "op": op}


@router.get("/api/planner/{workspace_id}/ops")
async def planner_ops(workspace_id: str, request: Request, limit: int = 50):
    """最近操作/回执历史（内存态，最新在后）。"""
    user = await _require_user_http(request)
    _own_or_404(user, workspace_id)
    limit = max(1, min(int(limit or 50), OPS_KEEP))
    return {"ops": _ops.get(workspace_id, [])[-limit:]}
