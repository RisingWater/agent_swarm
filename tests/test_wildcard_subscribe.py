# -*- coding: utf-8 -*-
"""WS /ws/nexus 通配订阅（workspace_id="*"）测试（2026-09-25 派单）。

桌宠简报模式：订阅本用户名下全部工作区，与飞书/微信「属主全局」语义对齐。
核心安全点：推送时逐事件 _owns 属主过滤（2026-09-18 IM 跨用户泄漏教训）。
"""
import asyncio
import json

import pytest

from server import models, nexus_a2a
from server.db import engine
from sqlmodel import Session

from tests.conftest import as_user, ws, user  # noqa: F401  共享夹具（conftest 定义；_db 为 autouse 不导入）


class _CollectWS:
    """收集推送帧的假 WS。"""

    def __init__(self):
        self.sent: list[str] = []

    async def send_text(self, raw: str) -> None:
        self.sent.append(raw)


def _web_conn(user_id: str) -> nexus_a2a.WebConn:
    return nexus_a2a.WebConn(ws=_CollectWS(), user_id=user_id)


def _last_payload(conn: nexus_a2a.WebConn) -> dict:
    return json.loads(conn.ws.sent[-1])


@pytest.fixture()
def _clean_registry():
    """测试前后清空订阅注册表（全局状态，防测试间污染）。"""
    nexus_a2a.subscribers.clear()
    nexus_a2a.all_subscribers.clear()
    yield
    nexus_a2a.subscribers.clear()
    nexus_a2a.all_subscribers.clear()


@pytest.mark.asyncio
async def test_wildcard_receives_owned_workspace_events(as_user, ws, _clean_registry):
    """通配连接收到自己名下工作区的事件。"""
    conn = _web_conn(as_user.id)
    conn.all_workspaces = True
    nexus_a2a.all_subscribers.add(conn)

    await nexus_a2a._push_web(ws.id, {"kind": "status-update", "taskId": "t1"})
    assert len(conn.ws.sent) == 1
    frame = _last_payload(conn)
    assert frame["type"] == "event" and frame["payload"]["taskId"] == "t1"

    # monitor 类型也走同路
    await nexus_a2a._push_web(ws.id, {"roundKey": "mon-x", "type": "text"}, type_="monitor")
    assert _last_payload(conn)["type"] == "monitor"


@pytest.mark.asyncio
async def test_wildcard_isolation_from_other_users(as_user, _clean_registry):
    """别人工作区的事件不通配推给本用户（属主过滤不回归——泄漏教训）。"""
    # 另一个用户 + 他的工作区
    with Session(engine) as s:
        other = s.get(models.User, "u-evil")
        if other is None:
            other = models.User(
                id="u-evil", username="evil2",
                password_hash=models.hash_password("password123"),
                api_key_hash=models.hash_api_key("ak-evil2"), api_key="ak-evil2",
            )
            s.add(other)
            s.commit()
        s.add(models.Workspace(id="w-evil", user_id="u-evil", name="e", path="/e"))
        s.commit()

    conn = _web_conn(as_user.id)
    conn.all_workspaces = True
    nexus_a2a.all_subscribers.add(conn)

    await nexus_a2a._push_web("w-evil", {"kind": "status-update", "taskId": "t2"})
    assert conn.ws.sent == []  # 别人的工作区事件：收不到


@pytest.mark.asyncio
async def test_normal_subscribe_path_not_regressed(as_user, ws, _clean_registry):
    """普通按 wid 订阅路径不回归：只收订阅 wid 的帧。"""
    conn = _web_conn(as_user.id)
    nexus_a2a.subscribers.setdefault(ws.id, set()).add(conn)
    conn.workspace_id = ws.id

    await nexus_a2a._push_web(ws.id, {"kind": "status-update", "taskId": "t3"})
    assert len(conn.ws.sent) == 1

    # 未订阅的 wid 不收（工作区属主仍是本用户，排除「跨 wid 泄漏到普通订阅」）
    with Session(engine) as s:
        s.add(models.Workspace(id="w-mine2", user_id=as_user.id, name="m2", path="/m2"))
        s.commit()
    await nexus_a2a._push_web("w-mine2", {"kind": "status-update", "taskId": "t4"})
    assert len(conn.ws.sent) == 1  # 没有新帧


@pytest.mark.asyncio
async def test_wildcard_and_single_both_receive(as_user, ws, _clean_registry):
    """同一事件：单 wid 订阅者与通配订阅者都收到（互不影响）。"""
    single = _web_conn(as_user.id)
    nexus_a2a.subscribers.setdefault(ws.id, set()).add(single)
    single.workspace_id = ws.id

    wild = _web_conn(as_user.id)
    wild.all_workspaces = True
    nexus_a2a.all_subscribers.add(wild)

    await nexus_a2a._push_web(ws.id, {"kind": "status-update", "taskId": "t5"})
    assert len(single.ws.sent) == 1 and len(wild.ws.sent) == 1


@pytest.mark.asyncio
async def test_wildcard_dead_conn_discarded(as_user, ws, _clean_registry):
    """通配连接发送失败被剔除（与单 wid 订阅同款容错）。"""
    class _DeadWS:
        async def send_text(self, raw: str) -> None:
            raise RuntimeError("closed")

    dead = nexus_a2a.WebConn(ws=_DeadWS(), user_id=as_user.id)
    dead.all_workspaces = True
    nexus_a2a.all_subscribers.add(dead)

    await nexus_a2a._push_web(ws.id, {"kind": "status-update", "taskId": "t6"})
    assert dead not in nexus_a2a.all_subscribers


def test_unsubscribe_clears_wildcard(as_user, _clean_registry):
    """退订/断线清理把通配标记一并复位。"""
    conn = _web_conn(as_user.id)
    conn.all_workspaces = True
    nexus_a2a.all_subscribers.add(conn)
    nexus_a2a._unsubscribe(conn)
    assert conn.all_workspaces is False
    assert conn not in nexus_a2a.all_subscribers
