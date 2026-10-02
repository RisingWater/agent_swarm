# -*- coding: utf-8 -*-
"""微信规划器待办（协议 §7）：独立 pending 槽 + 入站数字 → op + 离线容错 + 渲染。"""
import asyncio

from fastapi import HTTPException

from server import planner_channel
from server.weixin import commands, gateway as wgateway, render
from server.weixin import state as wstate


def test_planner_pending_slot_isolated_from_permission():
    """规划器待办与权限待应答分槽，互不覆盖。"""
    wstate.clear_pending("u-iso")
    wstate.clear_planner_pending("u-iso")
    wstate.set_pending("u-iso", "t1", "permission", "问题", ["允许", "拒绝"], request_id="r1")
    wstate.set_planner_pending("u-iso", "plan:g:1", {
        "kind": "plan_approval", "key": "plan:g:1", "workspace_id": "w-plan",
        "goal_id": "g1", "title": "拆解待审批",
    })
    assert wstate.get_pending("u-iso")["task_id"] == "t1"
    assert wstate.get_planner_pending("u-iso")["key"] == "plan:g:1"

    wstate.pop_planner_pending("u-iso", "plan:g:1")
    assert wstate.get_planner_pending("u-iso") is None
    assert wstate.get_pending("u-iso") is not None  # 权限 pending 不受影响
    wstate.clear_pending("u-iso")
    wstate.clear_planner_pending("u-iso")


def test_inbound_digit_routes_plan_approve(monkeypatch):
    wstate.clear_pending("u-p1")
    wstate.clear_planner_pending("u-p1")
    wstate.set_planner_pending("u-p1", "plan:g:1", {
        "kind": "plan_approval", "key": "plan:g:1", "workspace_id": "w-plan",
        "goal_id": "g1", "title": "拆解待审批",
    })
    calls = []

    async def fake_dispatch(wid, op, payload):
        calls.append((wid, op, payload))
        return "opid"

    monkeypatch.setattr(planner_channel, "dispatch_op", fake_dispatch)
    sess = wgateway.UserSession("u-p1")  # context_token 为空 → reply 仅记日志，不发网络
    asyncio.run(commands.handle_inbound(sess, "1"))
    assert calls == [("w-plan", "plan.approve", {"goal_id": "g1"})]
    assert wstate.get_planner_pending("u-p1") is None  # 已提交 → 移除
    wstate.clear_planner_pending("u-p1")


def test_inbound_digit_routes_task_reject(monkeypatch):
    wstate.clear_pending("u-p2")
    wstate.clear_planner_pending("u-p2")
    wstate.set_planner_pending("u-p2", "accept:t:0", {
        "kind": "task_acceptance", "key": "accept:t:0", "workspace_id": "w-plan",
        "task_id": "t1", "title": "人工验收待处理",
    })
    calls = []

    async def fake_dispatch(wid, op, payload):
        calls.append((wid, op, payload))
        return "opid"

    monkeypatch.setattr(planner_channel, "dispatch_op", fake_dispatch)
    sess = wgateway.UserSession("u-p2")
    asyncio.run(commands.handle_inbound(sess, "2"))
    assert calls == [("w-plan", "task.reject", {"task_id": "t1"})]
    wstate.clear_planner_pending("u-p2")


def test_inbound_offline_keeps_pending(monkeypatch):
    wstate.clear_pending("u-p3")
    wstate.clear_planner_pending("u-p3")
    wstate.set_planner_pending("u-p3", "plan:g:9", {
        "kind": "plan_approval", "key": "plan:g:9", "workspace_id": "w-plan",
        "goal_id": "g9", "title": "拆解待审批",
    })

    async def boom(wid, op, payload):
        raise HTTPException(409, "planner-core 未连接")

    monkeypatch.setattr(planner_channel, "dispatch_op", boom)
    sess = wgateway.UserSession("u-p3")
    asyncio.run(commands.handle_inbound(sess, "1"))
    assert wstate.get_planner_pending("u-p3") is not None  # 离线保留待办
    wstate.clear_planner_pending("u-p3")


def test_bridge_resolved_pops_pending(as_user, ws):
    from server.weixin import bridge as wbridge

    wstate.clear_planner_pending(as_user.id)
    wstate.set_planner_pending(as_user.id, "k1", {
        "kind": "plan_approval", "key": "k1", "workspace_id": ws.id, "title": "T",
    })
    asyncio.run(wbridge._route_planner_pending(ws.id, "resolved", {"key": "k1", "title": "T"}))
    assert wstate.get_planner_pending(as_user.id) is None


def test_render_planner_texts():
    plan = render.planner_pending_text({"kind": "plan_approval", "title": "拆解待审批：X",
                                        "detail": "共 2 个任务"})
    assert "通过拆解" in plan and "重新拆解" in plan
    assert "1." in plan and "2." in plan
    accept = render.planner_pending_text({"kind": "task_acceptance", "title": "验收Y"})
    assert "通过" in accept and "拒绝" in accept
    assert "已处理" in render.planner_resolved_text({"title": "验收Y"})
