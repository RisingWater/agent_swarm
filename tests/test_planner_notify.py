# -*- coding: utf-8 -*-
"""规划器人工待办（notify）平台侧接入测试。

覆盖：notify 登记 + 按 key 去重、op_result 成功清键、state 快照收尾（拆解/验收/归档删除）、
分发钩子容错与离线（无渠道/钩子异常）容错。协议见 planner-platform-protocol.md §7。

`test_notify.py` 是"跨工作区长任务完成提醒"，与本文件无关。
"""
import asyncio

import pytest
from fastapi.testclient import TestClient

from server import planner_channel as pc
from server.main import app

from tests.conftest import as_user, ws, user  # noqa: F401  共享夹具

APIKEY = "ak-test"


def _auth(key: str = APIKEY) -> dict:
    return {"Authorization": f"Bearer {key}"}


@pytest.fixture()
def client():
    pc.planner_conns.clear()
    pc._ops.clear()
    pc.planner_pending.clear()
    pc.pending_listeners.clear()
    c = TestClient(app)
    yield c
    c.close()
    pc.planner_conns.clear()
    pc._ops.clear()
    pc.planner_pending.clear()
    pc.pending_listeners.clear()


def _plan_notify(wid: str, goal_id: str = "g1", rev: int = 1, **over) -> dict:
    p = {
        "kind": "plan_approval",
        "key": f"plan:{goal_id}:{rev}",
        "workspace_id": wid,
        "goal_id": goal_id,
        "goal_title": "目标一",
        "plan_rev": rev,
        "task_id": "",
        "title": "拆解待审批：目标一",
        "detail": "共 2 个任务，等待人工『通过拆解』或『重新拆解』",
        "created_at": "2026-10-03T00:00:00Z",
    }
    p.update(over)
    return p


def _task_notify(wid: str, task_id: str = "t1", goal_id: str = "g1", attempt: int = 0, **over) -> dict:
    p = {
        "kind": "task_acceptance",
        "key": f"accept:{task_id}:{attempt}",
        "workspace_id": wid,
        "goal_id": goal_id,
        "goal_title": "目标一",
        "task_id": task_id,
        "task_title": "任务一",
        "attempt": attempt,
        "title": "人工验收待处理：任务一",
        "detail": "目标《目标一》",
        "created_at": "2026-10-03T00:00:00Z",
    }
    p.update(over)
    return p


def _hello(wsc, wid: str) -> None:
    wsc.send_json({"type": "hello", "apikey": APIKEY, "workspace_id": wid})
    assert wsc.receive_json()["type"] == "hello_ok"


def _sync(wsc) -> None:
    """ping/pong 同步：确保在此之前的帧都被服务端处理完。"""
    wsc.send_json({"type": "ping"})
    assert wsc.receive_json()["type"] == "pong"


def _collector():
    events: list[tuple[str, str, str]] = []

    async def fn(wid: str, action: str, item: dict) -> None:
        events.append((wid, action, str(item.get("key") or "")))

    return events, fn


# ---------------------------------------------------------------- 登记 + 去重

def test_notify_register_and_dedup(client, ws):
    """notify 帧登记待办；同 key 重复只提醒一次（分发钩子只收到一次 pending）。"""
    wid = ws.id
    events, fn = _collector()
    pc.register_pending_listener(fn)
    with client.websocket_connect("/ws/planner") as wsc:
        _hello(wsc, wid)
        wsc.send_json({"type": "notify", "payload": _plan_notify(wid)})
        wsc.send_json({"type": "notify", "payload": _plan_notify(wid)})  # 同 key 重复
        _sync(wsc)
    assert events == [(wid, "pending", "plan:g1:1")]  # 只登记一次
    pending = pc.list_pending(wid)
    assert len(pending) == 1
    assert pending[0]["kind"] == "plan_approval" and pending[0]["goal_id"] == "g1"


def test_notify_bad_payload_ignored(client, ws):
    """缺 kind/key 的 notify 不登记、不报错。"""
    wid = ws.id
    with client.websocket_connect("/ws/planner") as wsc:
        _hello(wsc, wid)
        wsc.send_json({"type": "notify", "payload": {"kind": "bogus", "key": "x"}})
        wsc.send_json({"type": "notify", "payload": {"kind": "plan_approval"}})  # 无 key
        _sync(wsc)
    assert pc.list_pending(wid) == []


# ---------------------------------------------------------------- op_result 清键

def test_op_result_ok_clears_plan_pending(client, ws):
    wid = ws.id
    with client.websocket_connect("/ws/planner") as wsc:
        _hello(wsc, wid)
        wsc.send_json({"type": "notify", "payload": _plan_notify(wid, goal_id="g1", rev=1)})
        _sync(wsc)
        assert pc.list_pending(wid)

        r = client.post(f"/api/planner/{wid}/op", headers=_auth(),
                        json={"op": "plan.approve", "payload": {"goal_id": "g1"}})
        assert r.status_code == 200
        op_id = r.json()["op_id"]
        frame = wsc.receive_json()
        assert frame["type"] == "op" and frame["op"] == "plan.approve"

        wsc.send_json({"type": "op_result", "op_id": op_id, "ok": True, "error": ""})
        _sync(wsc)
        assert pc.list_pending(wid) == []


def test_op_result_failed_keeps_pending(client, ws):
    """回执失败（如 core 侧状态已变返回 ok:false）不清键。"""
    wid = ws.id
    with client.websocket_connect("/ws/planner") as wsc:
        _hello(wsc, wid)
        wsc.send_json({"type": "notify", "payload": _task_notify(wid, task_id="t1", attempt=0)})
        _sync(wsc)

        r = client.post(f"/api/planner/{wid}/op", headers=_auth(),
                        json={"op": "task.accept", "payload": {"task_id": "t1"}})
        op_id = r.json()["op_id"]
        assert wsc.receive_json()["type"] == "op"

        wsc.send_json({"type": "op_result", "op_id": op_id, "ok": False,
                       "error": "任务不在待验收状态（当前 done）"})
        _sync(wsc)
        assert pc.list_pending(wid)  # 仍待办


def test_op_result_ok_clears_task_pending(client, ws):
    wid = ws.id
    with client.websocket_connect("/ws/planner") as wsc:
        _hello(wsc, wid)
        wsc.send_json({"type": "notify", "payload": _task_notify(wid, task_id="t9", attempt=2)})
        _sync(wsc)
        r = client.post(f"/api/planner/{wid}/op", headers=_auth(),
                        json={"op": "task.reject", "payload": {"task_id": "t9", "reason": "不合格"}})
        op_id = r.json()["op_id"]
        assert wsc.receive_json()["type"] == "op"
        wsc.send_json({"type": "op_result", "op_id": op_id, "ok": True, "error": ""})
        _sync(wsc)
        assert pc.list_pending(wid) == []


# ---------------------------------------------------------------- state 收尾

def test_state_keeps_draft_pending_then_clears_on_approved(client, ws):
    """拆解待办：draft 仍在 → 保持；plan_status 变 approved → 清键。"""
    wid = ws.id
    with client.websocket_connect("/ws/planner") as wsc:
        _hello(wsc, wid)
        wsc.send_json({"type": "notify", "payload": _plan_notify(wid, goal_id="g1", rev=3)})
        _sync(wsc)

        base = {"workspace_id": wid, "tasks": []}
        # 仍 draft + active → 不收尾
        wsc.send_json({"type": "state", "payload": {
            **base, "goals": [{"id": "g1", "status": "active", "plan_status": "draft"}]}})
        _sync(wsc)
        assert pc.list_pending(wid)
        # approved → 收尾
        wsc.send_json({"type": "state", "payload": {
            **base, "goals": [{"id": "g1", "status": "active", "plan_status": "approved"}]}})
        _sync(wsc)
        assert pc.list_pending(wid) == []


def test_state_clears_on_goal_archived_or_deleted(client, ws):
    """目标归档（status!=active）或从快照消失 → 清该目标下所有待办（含验收）。"""
    wid = ws.id
    with client.websocket_connect("/ws/planner") as wsc:
        _hello(wsc, wid)
        wsc.send_json({"type": "notify", "payload": _task_notify(wid, task_id="t1")})
        _sync(wsc)
        assert pc.list_pending(wid)

        wsc.send_json({"type": "state", "payload": {
            "workspace_id": wid,
            "goals": [{"id": "g1", "status": "archived", "plan_status": "approved"}],
            "tasks": [{"id": "t1", "status": "waiting_human"}]}})
        _sync(wsc)
        assert pc.list_pending(wid) == []

        # 目标被删除：快照里完全没有该目标
        wsc.send_json({"type": "notify", "payload": _plan_notify(wid, goal_id="g2", rev=1)})
        _sync(wsc)
        assert pc.list_pending(wid)
        wsc.send_json({"type": "state", "payload": {"workspace_id": wid, "goals": [], "tasks": []}})
        _sync(wsc)
        assert pc.list_pending(wid) == []


def test_state_keeps_waiting_human_then_clears_on_done(client, ws):
    """验收待办：waiting_human → 保持；done → 清键。"""
    wid = ws.id
    with client.websocket_connect("/ws/planner") as wsc:
        _hello(wsc, wid)
        wsc.send_json({"type": "notify", "payload": _task_notify(wid, task_id="t5", attempt=0)})
        _sync(wsc)

        goals = [{"id": "g1", "status": "active", "plan_status": "approved"}]
        wsc.send_json({"type": "state", "payload": {
            "workspace_id": wid, "goals": goals,
            "tasks": [{"id": "t5", "status": "waiting_human"}]}})
        _sync(wsc)
        assert pc.list_pending(wid)

        wsc.send_json({"type": "state", "payload": {
            "workspace_id": wid, "goals": goals,
            "tasks": [{"id": "t5", "status": "done"}]}})
        _sync(wsc)
        assert pc.list_pending(wid) == []


# ---------------------------------------------------------------- 容错（无渠道 / 钩子异常 / 未知快照）

def test_reconcile_unknown_snapshot_keeps_pending():
    """快照形状未知（无 goals 列表）时不误清。"""
    pc.planner_pending.clear()
    assert asyncio.run(pc.handle_notify("w-x", _plan_notify("w-x"))) is True
    asyncio.run(pc.reconcile_pending("w-x", {}))
    asyncio.run(pc.reconcile_pending("w-x", {"goals": "oops"}))
    assert pc.list_pending("w-x")
    pc.planner_pending.clear()


def test_notify_dedup_returns_bool_and_listener_exception_isolated():
    """无渠道钩子时静默登记；钩子抛异常不影响登记与主链路（与 brief 同款容错）。"""
    pc.planner_pending.clear()
    pc.pending_listeners.clear()
    payload = _plan_notify("w-y")

    async def boom(wid, action, item):
        raise RuntimeError("channel down")

    pc.register_pending_listener(boom)
    assert asyncio.run(pc.handle_notify("w-y", payload)) is True  # 钩子炸了也登记成功
    assert asyncio.run(pc.handle_notify("w-y", payload)) is False  # 同 key 去重
    assert len(pc.list_pending("w-y")) == 1

    # resolved 钩子异常同样不影响清键
    asyncio.run(pc._clear_pending_for_op("w-y", "plan.approve", {"goal_id": "g1"}))
    assert pc.list_pending("w-y") == []
    pc.pending_listeners.clear()
    pc.planner_pending.clear()
