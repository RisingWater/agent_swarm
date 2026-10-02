# -*- coding: utf-8 -*-
"""规划器人工待办 → 桌宠 /ws/nexus 只读事件（协议 §7.4）。

覆盖：事件形状、属主过滤（精确订阅 + 通配，不跨用户）、resolved 不推送。
"""
import json

import pytest
from sqlmodel import Session

from server import models, nexus_a2a, planner_channel, planner_pet
from server.db import engine

from tests.conftest import as_user, ws, user  # noqa: F401  共享夹具


class _CollectWS:
    def __init__(self):
        self.sent: list[str] = []

    async def send_text(self, raw: str) -> None:
        self.sent.append(raw)


def _web_conn(user_id: str) -> nexus_a2a.WebConn:
    return nexus_a2a.WebConn(ws=_CollectWS(), user_id=user_id)


@pytest.fixture()
def _clean():
    nexus_a2a.subscribers.clear()
    nexus_a2a.all_subscribers.clear()
    planner_channel.pending_listeners.clear()
    planner_channel.planner_pending.clear()
    yield
    nexus_a2a.subscribers.clear()
    nexus_a2a.all_subscribers.clear()
    planner_channel.pending_listeners.clear()
    planner_channel.planner_pending.clear()


def _plan_item(wid: str) -> dict:
    return {
        "kind": "plan_approval",
        "key": f"plan:g1:1",
        "workspace_id": wid,
        "goal_id": "g1",
        "task_id": "",
        "title": "拆解待审批：目标一",
        "detail": "共 2 个任务",
        "created_at": "2026-10-03T00:00:00Z",
    }


@pytest.mark.asyncio
async def test_pet_event_shape_and_owner_filter(as_user, ws, _clean):
    """属主（精确 + 通配）收到 type=planner 事件，形状与协议 §7.4 一致；他人收不到。"""
    conn = _web_conn(as_user.id)
    nexus_a2a.subscribers.setdefault(ws.id, set()).add(conn)
    conn.workspace_id = ws.id
    wild = _web_conn(as_user.id)
    wild.all_workspaces = True
    nexus_a2a.all_subscribers.add(wild)

    # 另一个用户 + 通配连接（验证不跨用户）
    with Session(engine) as s:
        if s.get(models.User, "u-plan-pet-evil") is None:
            s.add(models.User(
                id="u-plan-pet-evil", username="pet-evil",
                password_hash=models.hash_password("password123"),
                api_key_hash=models.hash_api_key("ak-pet-evil"), api_key="ak-pet-evil",
            ))
            s.add(models.Workspace(id="w-pet-evil", user_id="u-plan-pet-evil", name="e", path="/e"))
            s.commit()
    evil = _web_conn("u-plan-pet-evil")
    evil.all_workspaces = True
    nexus_a2a.all_subscribers.add(evil)

    planner_pet.bind_listener()
    try:
        assert await planner_channel.handle_notify(ws.id, _plan_item(ws.id)) is True
    finally:
        planner_pet.unbind_listener()

    assert len(conn.ws.sent) == 1 and len(wild.ws.sent) == 1
    frame = json.loads(conn.ws.sent[-1])
    assert frame["type"] == "planner"
    p = frame["payload"]
    assert set(p.keys()) == {"kind", "workspace_id", "goal_id", "task_id",
                             "title", "detail", "updated_at"}
    assert p["kind"] == "plan_approval" and p["workspace_id"] == ws.id
    assert p["goal_id"] == "g1" and p["task_id"] == ""
    assert evil.ws.sent == []  # 别人的工作区：收不到


@pytest.mark.asyncio
async def test_pet_resolved_not_pushed(as_user, ws, _clean):
    conn = _web_conn(as_user.id)
    nexus_a2a.subscribers.setdefault(ws.id, set()).add(conn)
    conn.workspace_id = ws.id
    await planner_pet._on_pending(ws.id, "resolved", _plan_item(ws.id))
    assert conn.ws.sent == []


@pytest.mark.asyncio
async def test_pet_task_acceptance_shape(as_user, ws, _clean):
    conn = _web_conn(as_user.id)
    nexus_a2a.subscribers.setdefault(ws.id, set()).add(conn)
    conn.workspace_id = ws.id
    item = {"kind": "task_acceptance", "key": "accept:t1:0", "workspace_id": ws.id,
            "goal_id": "g1", "task_id": "t1", "title": "人工验收待处理：任务一",
            "detail": "", "created_at": ""}
    await planner_pet._on_pending(ws.id, "pending", item)
    p = json.loads(conn.ws.sent[-1])["payload"]
    assert p["kind"] == "task_acceptance" and p["task_id"] == "t1"
    assert p["updated_at"] == ""  # 无 received_at 时回退 created_at
