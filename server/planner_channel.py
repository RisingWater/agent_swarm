"""规划器控制通道（2026-10-03）：`/ws/planner` + `/api/planner/*`。

背景：planner-core 在用户内网/本机，平台访问不到它的端口，所以由 **core 主动**向
平台建立 WebSocket 长连接：平台网页的目标/审批/验收操作经该 WS 下发；core 把
「目标 + 任务树」结构化快照也从同一条 WS 推回，平台按 workspace 缓存一份供展示
（**展示缓存，非任务真相**，真相在 core 的 SQLite）。

协议见 `agent-swarm-planner/docs/planner-platform-protocol.md`：
  hello → hello_ok / hello_err；ping → pong
  平台→core {"type":"op","op_id","op","payload"}
  core→平台 {"type":"op_result","op_id","ok","error"} / {"type":"state","payload":{...}}
                 / {"type":"notify","payload":{...}}（§7 人工待办边沿事件）

本模块同时维护**人工待办注册表** `planner_pending`（内存态）：core 的两类人工待办
（拆解待审批 / 人工验收待处理）经 notify 帧登记，按 payload.key 去重；命中清键条件
（op_result 成功、state 快照显示已离开待办态）即移除并通知分发钩子。飞书/微信/桌宠的
具体推送由后续任务注册 `register_pending_listener` 接入，本模块只负责登记/去重/收尾。

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


def _record_result(workspace_id: str, msg: dict) -> dict:
    """记录回执并返回该记录（供按 op/payload 清待办键）；未记录过的 op_id 也留痕。"""
    op_id = str(msg.get("op_id") or "")
    for rec in reversed(_ops.get(workspace_id, [])):
        if rec["op_id"] == op_id:
            rec["ok"] = bool(msg.get("ok"))
            rec["error"] = str(msg.get("error") or "")
            rec["done_at"] = _ts()
            return rec
    # 未记录过的回执（例如重连后补发）也留存一条，便于排查
    lst = _ops.setdefault(workspace_id, [])
    rec = {
        "op_id": op_id,
        "op": "",
        "payload": {},
        "ok": bool(msg.get("ok")),
        "error": str(msg.get("error") or ""),
        "created_at": _ts(),
        "done_at": _ts(),
    }
    lst.append(rec)
    del lst[:-OPS_KEEP]
    return rec


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


# ---------------------------------------------------------------- 人工待办注册表（notify）
#
# core 在"进入态"边沿经同一条 WS 发 {"type":"notify","payload":{...}}（协议 §7）；
# 平台按 payload.key 去重登记，命中清键条件即移除并回调分发钩子。内存态：重启丢失
# 无妨——core 只在边沿发、不重放（协议 §7.2）。飞书/微信/桌宠推送（后续任务）通过
# register_pending_listener 接入，本模块不做具体推送。

# kind 仅这两个（协议 §7.1）
NOTIFY_KINDS = ("plan_approval", "task_acceptance")

# workspace_id → {key: item}
planner_pending: dict[str, dict[str, dict]] = {}

# 待办事件向外分发钩子：async fn(workspace_id, action, item)
#   action = "pending"（新登记）/ "resolved"（被处理或状态不再待办）
# 钩子异常互不影响（与 nexus_a2a.internal_listeners 同款容错）。
pending_listeners: list = []


def register_pending_listener(fn) -> None:
    if fn not in pending_listeners:
        pending_listeners.append(fn)


def unregister_pending_listener(fn) -> None:
    try:
        pending_listeners.remove(fn)
    except ValueError:
        pass


def list_pending(workspace_id: str) -> list[dict]:
    """该工作区当前待办（按登记顺序，最新在后）。供 IM/web 后续复用。"""
    return list(planner_pending.get(workspace_id, {}).values())


async def _emit_pending(workspace_id: str, action: str, item: dict) -> None:
    """通知所有分发钩子；单个钩子异常不阻断其他钩子与 WS 主链路。"""
    for fn in list(pending_listeners):
        try:
            await fn(workspace_id, action, item)
        except Exception:  # noqa: BLE001
            log.exception("planner pending listener 失败 action=%s key=%s",
                          action, item.get("key"))


async def _drop_pending(workspace_id: str, key: str, reason: str) -> bool:
    """移除一个待办并回调钩子（收尾）。命中返回 True。"""
    bucket = planner_pending.get(workspace_id)
    if not bucket or key not in bucket:
        return False
    item = bucket.pop(key)
    item["resolved_reason"] = reason
    item["resolved_at"] = _ts()
    log.info("planner pending - key=%s reason=%s", key, reason)
    await _emit_pending(workspace_id, "resolved", item)
    return True


async def handle_notify(workspace_id: str, payload: dict) -> bool:
    """收到 core 的 notify 帧：登记待办并按 key 去重（同键只提醒一次）。返回是否新登记。"""
    kind = str(payload.get("kind") or "")
    key = str(payload.get("key") or "")
    if kind not in NOTIFY_KINDS or not key:
        log.warning("planner notify 字段缺失 kind=%r key=%r", kind, key)
        return False
    bucket = planner_pending.setdefault(workspace_id, {})
    if key in bucket:
        return False  # 同键重复：core 本不应重发，幂等保护（协议 §7.2）
    item = {
        "kind": kind,
        "key": key,
        "workspace_id": workspace_id,  # 以连接为准，不用 payload 里的（防串号）
        "goal_id": str(payload.get("goal_id") or ""),
        "goal_title": str(payload.get("goal_title") or ""),
        "task_id": str(payload.get("task_id") or ""),
        "task_title": str(payload.get("task_title") or ""),
        "plan_rev": payload.get("plan_rev"),
        "attempt": payload.get("attempt"),
        "title": str(payload.get("title") or ""),
        "detail": str(payload.get("detail") or ""),
        "created_at": str(payload.get("created_at") or ""),
        "received_at": _ts(),
    }
    bucket[key] = item
    log.info("planner pending + %s key=%s", kind, key)
    await _emit_pending(workspace_id, "pending", item)
    return True


async def _clear_pending_for_op(workspace_id: str, op: str, payload: dict) -> None:
    """op 回执成功后的清键（协议 §7.2-①）：批准/重拆清该目标的 plan 键，验收清该任务的 accept 键。"""
    if op in ("plan.approve", "plan.revise"):
        goal_id = str(payload.get("goal_id") or "")
        if not goal_id:
            return
        prefix = f"plan:{goal_id}:"
    elif op in ("task.accept", "task.reject"):
        task_id = str(payload.get("task_id") or "")
        if not task_id:
            return
        prefix = f"accept:{task_id}:"
    else:
        return
    for key in [k for k in planner_pending.get(workspace_id, {}) if k.startswith(prefix)]:
        await _drop_pending(workspace_id, key, "op_result")


async def reconcile_pending(workspace_id: str, snapshot: dict) -> None:
    """按最新 state 快照收尾（协议 §7.2-②③）：
    - 目标被删除（快照无此目标）或不再 active（归档/done）→ 清该目标下所有待办；
    - 拆解待办：目标 plan_status 不再 draft → 清；
    - 验收待办：任务不在 waiting_human（或已消失）→ 清。
    快照形状未知（无 goals 列表）时不动待办，避免误清。
    """
    goals = snapshot.get("goals")
    if not isinstance(goals, list):
        return
    goal_by_id = {str(g.get("id") or ""): g for g in goals if isinstance(g, dict)}
    tasks = snapshot.get("tasks")
    task_by_id: dict[str, dict] = {}
    if isinstance(tasks, list):
        task_by_id = {str(t.get("id") or ""): t for t in tasks if isinstance(t, dict)}
    for key, item in list(planner_pending.get(workspace_id, {}).items()):
        goal = goal_by_id.get(item.get("goal_id") or "")
        gstatus = goal.get("status") if goal else None
        reason = ""
        if goal is None:
            reason = "goal_missing"
        elif gstatus is not None and str(gstatus) != "active":
            reason = "goal_inactive"
        elif item["kind"] == "plan_approval":
            ps = goal.get("plan_status")
            if ps is not None and str(ps) != "draft":
                reason = "plan_not_draft"
        else:  # task_acceptance
            task = task_by_id.get(item.get("task_id") or "")
            if task is None:
                reason = "task_missing"
            else:
                ts = task.get("status")
                if ts is not None and str(ts) != "waiting_human":
                    reason = "task_not_waiting"
        if reason:
            await _drop_pending(workspace_id, key, reason)


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
                    # 快照可能让待办离开待办态 → 收尾（协议 §7.2-②③）
                    await reconcile_pending(conn.workspace_id, payload)
            elif mtype == "notify":
                payload = msg.get("payload") or {}
                if isinstance(payload, dict):
                    await handle_notify(conn.workspace_id, payload)
            elif mtype == "op_result":
                rec = _record_result(conn.workspace_id, msg)
                if rec.get("ok") and rec.get("op"):
                    # 操作成功 → 清对应待办键（协议 §7.2-①）
                    await _clear_pending_for_op(conn.workspace_id, rec["op"], rec.get("payload") or {})
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
