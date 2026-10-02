# -*- coding: utf-8 -*-
"""飞书规划器待办卡（协议 §7）：卡形状（两按钮）+ 分发钩子推卡/收尾 + 容错。"""
import asyncio

import pytest

from server.feishu import planner_card
from server.feishu import state as fstate

from tests.conftest import as_user, ws, user  # noqa: F401  共享夹具


def _card_buttons(card: dict) -> list[dict]:
    for el in card.get("elements") or []:
        if el.get("tag") == "column_set":
            return [c["elements"][0] for c in el.get("columns") or []]
    return []


@pytest.fixture()
def _clean_card():
    planner_card._active.clear()
    planner_card.set_gateway(None)
    yield
    planner_card._active.clear()
    planner_card.set_gateway(None)


class _FakeGW:
    def __init__(self):
        self.sent: list[tuple[str, dict]] = []

    async def send_card(self, chat_id: str, card: dict) -> None:
        self.sent.append((chat_id, card))


def test_planner_card_plan_has_two_buttons():
    card = planner_card.planner_card({
        "kind": "plan_approval", "workspace_id": "w1", "goal_id": "g1",
        "title": "拆解待审批：目标一", "detail": "共 2 个任务",
    })
    btns = _card_buttons(card)
    assert [b["value"]["op"] for b in btns] == ["plan.approve", "plan.revise"]
    assert all(b["value"]["action"] == "planner_op" for b in btns)
    assert all(b["value"]["workspace_id"] == "w1" for b in btns)
    assert btns[0]["value"]["payload"] == {"goal_id": "g1"}
    assert btns[1]["value"]["payload"] == {"goal_id": "g1"}


def test_planner_card_task_has_two_buttons():
    card = planner_card.planner_card({
        "kind": "task_acceptance", "workspace_id": "w1", "task_id": "t1",
        "title": "人工验收待处理：任务一",
    })
    btns = _card_buttons(card)
    assert [b["value"]["op"] for b in btns] == ["task.accept", "task.reject"]
    assert btns[0]["value"]["payload"] == {"task_id": "t1"}
    assert btns[1]["value"]["payload"] == {"task_id": "t1"}


def test_submitted_card_no_buttons():
    card = planner_card.submitted_card("plan.approve")
    assert _card_buttons(card) == []
    assert "通过拆解" in str(card)


def test_listener_pushes_card_then_resolves(as_user, ws, _clean_card):
    fstate.update_chat("chat-plan-1", "p2p", as_user.id, brief_on=True)
    gw = _FakeGW()
    planner_card.set_gateway(gw)
    item = {"kind": "plan_approval", "key": "plan:g1:1", "workspace_id": ws.id,
            "goal_id": "g1", "task_id": "", "title": "拆解待审批：目标一",
            "detail": "共 2 个任务", "received_at": "t"}
    asyncio.run(planner_card._on_pending(ws.id, "pending", item))
    assert len(gw.sent) == 1 and gw.sent[0][0] == "chat-plan-1"
    assert len(_card_buttons(gw.sent[0][1])) == 2
    # resolved → 收尾卡（无按钮），且 _active 清空
    asyncio.run(planner_card._on_pending(ws.id, "resolved", {**item, "resolved_reason": "op_result"}))
    assert len(gw.sent) == 2
    assert _card_buttons(gw.sent[1][1]) == []
    assert "plan:g1:1" not in planner_card._active


def test_listener_tolerates_unknown_workspace_and_resolved(as_user, ws, _clean_card):
    gw = _FakeGW()
    planner_card.set_gateway(gw)
    asyncio.run(planner_card._on_pending("w-nonexistent", "pending",
                                         {"kind": "plan_approval", "key": "k1"}))
    asyncio.run(planner_card._on_pending(ws.id, "resolved", {"kind": "plan_approval", "key": "k2"}))
    assert gw.sent == []  # 无属主/无发过卡：静默
